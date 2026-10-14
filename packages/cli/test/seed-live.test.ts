import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createConnection } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

const postgresUrl = process.env.MOCKDATA_TEST_POSTGRES_URL;
const mysqlUrl = process.env.MOCKDATA_TEST_MYSQL_URL;

function schemaFile(customers: string, orders: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "mockdata-seed-live-"));
  const path = join(root, "schema.json");
  writeFileSync(path, JSON.stringify({ seed: 7, tables: {
    [orders]: { rows: 3, columns: {
      id: { type: "integer", primaryKey: true },
      customer_id: { type: "integer", ref: `${customers}.id` },
    } },
    [customers]: { rows: 2, columns: {
      id: { type: "integer", primaryKey: true },
      name: { type: "string" },
    } },
  } }));
  return { root, path };
}

async function seed(path: string, root: string, url: string, extra: string[] = []) {
  let out = "";
  let err = "";
  const code = await run(["seed", path, "--target", "env:MOCKDATA_SEED_LIVE_TARGET", ...extra], {
    cwd: root,
    llm: { env: { MOCKDATA_SEED_LIVE_TARGET: url } },
    out: (value) => { out += value; },
    err: (value) => { err += value; },
  });
  return { code, out, err };
}

describe("live PostgreSQL seeding", { timeout: 30_000 }, () => {
  it.skipIf(!postgresUrl)("previews, commits related rows, and rolls back a later failure", async () => {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    const namespace = `md_seed_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const { root, path } = schemaFile("customers", "orders");
    try {
      await client.query(`create schema "${namespace}"`);
      await client.query(`create table "${namespace}".customers (id integer primary key, name text not null)`);
      await client.query(`create table "${namespace}".orders (id integer primary key, customer_id integer not null references "${namespace}".customers(id))`);
      const args = ["--pg-schema", namespace];
      expect((await seed(path, root, postgresUrl!, args)).code).toBe(0);
      expect(Number((await client.query(`select count(*) as n from "${namespace}".customers`)).rows[0]!.n)).toBe(0);
      expect(Number((await client.query(`select count(*) as n from "${namespace}".orders`)).rows[0]!.n)).toBe(0);
      const applied = await seed(path, root, postgresUrl!, [...args, "--apply"]);
      expect(applied).toMatchObject({ code: 0 });
      expect(Number((await client.query(`select count(*) as n from "${namespace}".customers`)).rows[0]!.n)).toBe(2);
      expect(Number((await client.query(`select count(*) as n from "${namespace}".orders`)).rows[0]!.n)).toBe(3);

      await client.query(`truncate "${namespace}".orders, "${namespace}".customers`);
      await client.query(`alter table "${namespace}".orders add constraint reject_generated_ids check (id < 0)`);
      const rejected = await seed(path, root, postgresUrl!, [...args, "--apply"]);
      expect(rejected.code).toBe(1);
      expect(rejected.out).not.toMatch(/committed/i);
      expect(Number((await client.query(`select count(*) as n from "${namespace}".customers`)).rows[0]!.n)).toBe(0);
      expect(Number((await client.query(`select count(*) as n from "${namespace}".orders`)).rows[0]!.n)).toBe(0);
    } finally {
      await client.query(`drop schema if exists "${namespace}" cascade`);
      await client.end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("live MySQL/MariaDB seeding", { timeout: 30_000 }, () => {
  it.skipIf(!mysqlUrl)("previews, commits related rows, and rolls back a later failure", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const customers = `md_customers_${suffix}`;
    const orders = `md_orders_${suffix}`;
    const { root, path } = schemaFile(customers, orders);
    const connection = await createConnection({ uri: mysqlUrl! });
    try {
      await connection.query(`create table \`${customers}\` (id int primary key, name varchar(255) not null) engine=InnoDB`);
      await connection.query(`create table \`${orders}\` (id int primary key, customer_id int not null, foreign key (customer_id) references \`${customers}\`(id)) engine=InnoDB`);
      expect((await seed(path, root, mysqlUrl!)).code).toBe(0);
      const [previewCustomers] = await connection.query(`select count(*) as n from \`${customers}\``);
      const [previewOrders] = await connection.query(`select count(*) as n from \`${orders}\``);
      expect((previewCustomers as { n: number }[])[0]!.n).toBe(0);
      expect((previewOrders as { n: number }[])[0]!.n).toBe(0);
      const applied = await seed(path, root, mysqlUrl!, ["--apply"]);
      expect(applied).toMatchObject({ code: 0 });
      const [customerRows] = await connection.query(`select count(*) as n from \`${customers}\``);
      const [orderRows] = await connection.query(`select count(*) as n from \`${orders}\``);
      expect((customerRows as { n: number }[])[0]!.n).toBe(2);
      expect((orderRows as { n: number }[])[0]!.n).toBe(3);

      await connection.query(`delete from \`${orders}\``);
      await connection.query(`delete from \`${customers}\``);
      await connection.query(`alter table \`${orders}\` add constraint \`reject_${suffix}\` check (id < 0)`);
      const rejected = await seed(path, root, mysqlUrl!, ["--apply"]);
      expect(rejected.code).toBe(1);
      expect(rejected.out).not.toMatch(/committed/i);
      const [afterCustomers] = await connection.query(`select count(*) as n from \`${customers}\``);
      const [afterOrders] = await connection.query(`select count(*) as n from \`${orders}\``);
      expect((afterCustomers as { n: number }[])[0]!.n).toBe(0);
      expect((afterOrders as { n: number }[])[0]!.n).toBe(0);
    } finally {
      await connection.query(`drop table if exists \`${orders}\``);
      await connection.query(`drop table if exists \`${customers}\``);
      await connection.end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
