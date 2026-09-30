import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { generate, parseSchema } from "@mockdata/core";
import {
  catalogToSchema,
  detectDatabase,
  inferFromDatabase,
  inferFromSource,
  introspectMysql,
  introspectPostgres,
  mapDbType,
  parseMysqlEnum,
  type MysqlQuery,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "mockdata-db-"));

describe("mapDbType", () => {
  it.each([
    ["integer", "integer"], ["bigint", "integer"], ["int unsigned", "integer"], ["serial", "integer"], ["INTEGER", "integer"],
    ["numeric(10,2)", "float"], ["double precision", "float"], ["real", "float"], ["DECIMAL(8,2)", "float"],
    ["boolean", "boolean"], ["tinyint(1)", "boolean"], ["tinyint(4)", "integer"],
    ["date", "date"], ["timestamp without time zone", "datetime"], ["timestamptz", "datetime"], ["datetime", "datetime"],
    ["uuid", "uuid"], ["character varying", "string"], ["varchar(255)", "string"], ["text", "string"], ["", "string"],
    ["jsonb", "string"], ["bytea", "string"],
  ])("%s -> %s", (from, to) => {
    expect(mapDbType(from).type).toBe(to);
  });
  it("turns enums into string enums", () => {
    expect(mapDbType("enum", ["a", "b"])).toEqual({ type: "string", enum: ["a", "b"] });
  });
});

describe("sqlite", () => {
  const file = join(dir, "shop.db");
  const db = new DatabaseSync(file);
  db.exec(`
    create table customers (
      id integer primary key,
      email text not null unique,
      name text,
      tier text,
      balance real not null,
      active boolean not null,
      signup date,
      created datetime
    );
    create table orders (
      id integer primary key,
      customer_id integer not null references customers(id),
      total numeric not null,
      note text
    );
    create table employees (id integer primary key, manager_id integer not null references employees(id));
    create table enrollments (student integer, course integer, primary key (student, course));
    create table line_items (order_id integer references orders, sku text, unique (order_id, sku));
    create table "weird name" (id integer primary key, "a.b" text);
    create view order_totals as select customer_id, sum(total) as t from orders group by customer_id;
    insert into customers values (1, 'a@x.com', 'Ann', 'pro', 1.5, 1, '2024-01-01', '2024-01-01 10:00:00');
  `);
  db.close();

  it("reflects tables, keys, types and constraints, without touching rows or views", async () => {
    const { schema, warnings } = await inferFromDatabase(`sqlite:${file}`);
    expect(Object.keys(schema.tables).sort()).toEqual(["customers", "employees", "enrollments", "line_items", "orders", "weird_name"]);
    const c = schema.tables.customers!.columns;
    expect(c.id).toEqual({ type: "integer", primaryKey: true });
    expect(c.email).toMatchObject({ type: "email", unique: true });
    expect(c.name).toMatchObject({ nullable: true, faker: "person.fullName" });
    expect(c.balance).toEqual({ type: "float" });
    expect(c.active).toEqual({ type: "boolean" });
    expect(c.signup).toMatchObject({ type: "date", nullable: true });
    expect(c.created).toMatchObject({ type: "datetime", nullable: true });
    expect(schema.tables.orders!.columns.customer_id).toEqual({ type: "integer", ref: "customers.id" });
    expect(schema.tables.orders!.columns.total).toEqual({ type: "float" });
    expect(schema.tables.weird_name!.columns.a_b).toMatchObject({ type: "string" });
    expect(schema.tables.orders!.rows).toBe(100);
    // Implicit target (references orders, no column) resolves to the parent's primary key.
    expect(schema.tables.line_items!.columns.order_id).toMatchObject({ ref: "orders.id" });
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("enrollments: composite primary key (student, course)"),
      expect.stringContaining("line_items: composite unique (order_id, sku)"),
      expect.stringContaining("employees.manager_id: self-referencing foreign key made nullable"),
    ]));
    expect(warnings.some((w) => w.includes("does not validate"))).toBe(false);
  });

  it("the reflected schema generates valid data, including the self reference", async () => {
    const { schema } = await inferFromDatabase(file, { rows: 25 });
    const data = generate(schema);
    expect(data.customers).toHaveLength(25);
    const ids = new Set(data.customers!.map((r) => r.id));
    for (const o of data.orders!) expect(ids.has(o.customer_id)).toBe(true);
    data.employees!.forEach((e, i) => e.manager_id !== null && expect(e.manager_id as number).toBeLessThanOrEqual(i));
  });

  it("does not modify the database (opened read-only)", async () => {
    await inferFromDatabase(file);
    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("select count(*) as n from customers").all()).toEqual([{ n: 1 }]);
    check.close();
  });

  it("explains a missing or invalid file", async () => {
    await expect(inferFromDatabase(join(dir, "nope.db"))).rejects.toThrow(/Cannot open SQLite|unable to open/i);
    const bad = join(dir, "bad.db");
    writeFileSync(bad, "this is not a database file at all, just text");
    await expect(inferFromDatabase(bad)).rejects.toThrow(/Database error|not a database/i);
  });
});

describe("postgres (real engine via pglite)", () => {
  const pg = new PGlite();
  afterAll(() => pg.close());
  const query = async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows as Record<string, unknown>[];

  it("reflects types, enums, keys and foreign keys", async () => {
    await pg.exec(`
      create type tier as enum ('free', 'pro', 'enterprise');
      create table accounts (
        id serial primary key,
        public_id uuid not null unique,
        email varchar(255) not null unique,
        plan tier not null,
        balance numeric(12,2) not null default 0,
        created_at timestamptz not null default now(),
        birthday date,
        is_admin boolean not null default false,
        prefs jsonb,
        tags text[]
      );
      create table posts (
        id bigserial primary key,
        account_id integer not null references accounts(id),
        reply_to bigint references posts(id),
        body text
      );
      create table memberships (account_id integer references accounts(id), team text, primary key (account_id, team));
      create schema other;
      create table other.ignored (id int primary key);
    `);
    const { schema, warnings } = catalogToSchema(await introspectPostgres(query));
    expect(Object.keys(schema.tables).sort()).toEqual(["accounts", "memberships", "posts"]);
    const a = schema.tables.accounts!.columns;
    expect(a.id).toEqual({ type: "integer", primaryKey: true });
    expect(a.public_id).toMatchObject({ type: "uuid", unique: true });
    expect(a.email).toMatchObject({ type: "email", unique: true });
    expect(a.plan).toMatchObject({ type: "string", enum: ["free", "pro", "enterprise"] });
    expect(a.balance).toEqual({ type: "float" });
    expect(a.created_at).toEqual({ type: "datetime" });
    expect(a.birthday).toMatchObject({ type: "date", nullable: true });
    expect(a.is_admin).toEqual({ type: "boolean" });
    expect(a.prefs).toMatchObject({ type: "string", nullable: true });
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('accounts.prefs: type "jsonb" mapped to string'), expect.stringContaining("memberships: composite primary key")]));

    const p = schema.tables.posts!.columns;
    expect(p.account_id).toEqual({ type: "integer", ref: "accounts.id" });
    expect(p.reply_to).toMatchObject({ type: "integer", ref: "posts.id", nullable: true });
    expect(schema.tables.memberships!.columns.account_id).toMatchObject({ ref: "accounts.id" });
    expect(() => parseSchema(schema)).not.toThrow();
    expect(warnings.some((w) => w.includes("does not validate"))).toBe(false);
  });

  it("reflects only the requested schema", async () => {
    const tables = await introspectPostgres(query, "other");
    expect(tables.map((t) => t.name)).toEqual(["ignored"]);
  });
});

describe("mysql", () => {
  it("parses enum column types, including quotes", () => {
    expect(parseMysqlEnum("enum('a','b','it''s')")).toEqual(["a", "b", "it's"]);
    expect(parseMysqlEnum("varchar(20)")).toBeUndefined();
  });

  it("builds a catalog from information_schema rows", async () => {
    const answers: [RegExp, Record<string, unknown>[]][] = [
      [/from information_schema\.columns/, [
        { table_name: "users", column_name: "id", column_type: "int unsigned", is_nullable: "NO" },
        { table_name: "users", column_name: "role", column_type: "enum('admin','user')", is_nullable: "NO" },
        { table_name: "users", column_name: "active", column_type: "tinyint(1)", is_nullable: "NO" },
        { table_name: "posts", column_name: "id", column_type: "bigint", is_nullable: "NO" },
        { table_name: "posts", column_name: "user_id", column_type: "int unsigned", is_nullable: "YES" },
      ]],
      [/from information_schema\.statistics/, [
        { table_name: "users", index_name: "PRIMARY", non_unique: 0, column_name: "id", seq: 1 },
        { table_name: "posts", index_name: "PRIMARY", non_unique: 0, column_name: "id", seq: 1 },
        { table_name: "posts", index_name: "idx_user", non_unique: 1, column_name: "user_id", seq: 1 },
      ]],
      [/from information_schema\.key_column_usage/, [
        { table_name: "posts", constraint_name: "fk_user", column_name: "user_id", ref_table: "users", ref_column: "id", pos: 1 },
      ]],
    ];
    const query: MysqlQuery = async (sql) => answers.find(([re]) => re.test(sql))![1];
    const { schema } = catalogToSchema(await introspectMysql(query, "app"));
    expect(schema.tables.users!.columns).toMatchObject({
      id: { type: "integer", primaryKey: true },
      role: { type: "string", enum: ["admin", "user"] },
      active: { type: "boolean" },
    });
    expect(schema.tables.posts!.columns.user_id).toEqual({ type: "integer", nullable: true, ref: "users.id" });
  });

  it.skipIf(!process.env.MOCKDATA_TEST_MYSQL_URL)("reflects a live MySQL/MariaDB (MOCKDATA_TEST_MYSQL_URL)", async () => {
    const { schema } = await inferFromDatabase(process.env.MOCKDATA_TEST_MYSQL_URL!);
    expect(schema.tables.mockdata_orders!.columns.customer_id).toMatchObject({ ref: "mockdata_customers.id" });
  });
});

describe("connection handling", () => {
  it("recognises database targets", () => {
    expect(detectDatabase("postgres://u@h/db")?.kind).toBe("postgres");
    expect(detectDatabase("postgresql://u@h/db")?.kind).toBe("postgres");
    expect(detectDatabase("mysql://u@h/db")?.kind).toBe("mysql");
    expect(detectDatabase("mariadb://u@h/db")?.kind).toBe("mysql");
    expect(detectDatabase("sqlite:./a.db")).toEqual({ kind: "sqlite", path: "./a.db" });
    expect(detectDatabase("data/app.sqlite3")?.kind).toBe("sqlite");
    expect(detectDatabase("orders.csv")).toBeUndefined();
  });

  it("never puts the password in an error, even for an unreachable server", async () => {
    for (const url of ["postgres://alice:s3cret%21pw@127.0.0.1:1/db", "mysql://alice:s3cret%21pw@127.0.0.1:1/db"]) {
      const err = await inferFromDatabase(url).catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain("s3cret");
      expect(err.message).not.toContain("pw");
    }
  });

  it("mysql needs a database name in the URL", async () => {
    await expect(inferFromDatabase("mysql://u@127.0.0.1:1")).rejects.toThrow(/database name/);
  });
});

describe("inferFromSource", () => {
  it("detects sqlite files, openapi files, sample files and sample directories", async () => {
    const sqlite = await inferFromSource(join(dir, "shop.db"));
    expect(Object.keys(sqlite.schema.tables)).toContain("orders");

    writeFileSync(join(dir, "api.json"), JSON.stringify({ openapi: "3.0.0", components: { schemas: { Pet: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } }));
    expect(Object.keys((await inferFromSource(join(dir, "api.json"))).schema.tables)).toEqual(["Pet"]);

    writeFileSync(join(dir, "api.yaml"), "$defs:\n  Cat:\n    type: object\n    required: [id]\n    properties:\n      id: { type: integer }\n");
    expect(Object.keys((await inferFromSource(join(dir, "api.yaml"))).schema.tables)).toEqual(["Cat"]);

    writeFileSync(join(dir, "rows.json"), JSON.stringify([{ id: 1, name: "a" }, { id: 2, name: "b" }]));
    expect(Object.keys((await inferFromSource(join(dir, "rows.json"))).schema.tables)).toEqual(["rows"]);

    const samples = mkdtempSync(join(tmpdir(), "mockdata-samples-"));
    writeFileSync(join(samples, "customers.csv"), "id,name\n1,Ann\n2,Bo\n");
    writeFileSync(join(samples, "orders.csv"), "id,customer_id\n1,1\n2,2\n3,1\n");
    writeFileSync(join(samples, "readme.txt"), "ignored");
    const multi = await inferFromSource(samples);
    expect(Object.keys(multi.schema.tables).sort()).toEqual(["customers", "orders"]);
    expect(multi.schema.tables.orders!.columns.customer_id).toMatchObject({ ref: "customers.id" });

    await expect(inferFromSource(join(dir, "missing.csv"))).rejects.toThrow(/No such file/);
    await expect(inferFromSource(mkdtempSync(join(tmpdir(), "mockdata-empty-")))).rejects.toThrow(/No .csv/);
  });
});
