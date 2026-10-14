import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, type IO } from "../src/cli.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(llm = false) {
  const root = mkdtempSync(join(tmpdir(), "mockdata-seed-command-")); roots.push(root);
  const path = join(root, "test.db");
  const schemaPath = join(root, "schema.json");
  const db = new DatabaseSync(path);
  db.exec('create table "customers" ("id" integer primary key, "name" text not null); create table "orders" ("id" integer primary key, "customer_id" integer not null references "customers"("id"))');
  db.close();
  writeFileSync(schemaPath, JSON.stringify({ seed: 1, tables: {
    orders: { rows: 3, columns: { id: { type: "integer", primaryKey: true }, customer_id: { type: "integer", ref: "customers.id" } } },
    customers: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, name: llm ? { type: "string", llm: true } : { type: "string" } } },
  } }));
  return { root, path, schemaPath };
}

async function invoke(args: string[], cwd: string, llm?: IO["llm"]) {
  let out = ""; let err = "";
  const code = await run(args, { out: (text) => { out += text; }, err: (text) => { err += text; }, cwd, llm });
  return { code, out, err };
}

describe("seed CLI", () => {
  it("previews kind, order, counts, and seed without writing", async () => {
    const { root, path, schemaPath } = fixture();
    const before = readFileSync(path);
    const result = await invoke(["seed", schemaPath, "--target", path, "--seed", "42"], root);
    expect(result).toMatchObject({ code: 0 });
    expect(result.out).toMatch(/preview.*sqlite/i);
    expect(result.out).toMatch(/customers.*2[\s\S]*orders.*3/);
    expect(result.out).toMatch(/seed.*42/i);
    const db = new DatabaseSync(path);
    expect(db.prepare("select count(*) as n from customers").get()).toEqual({ n: 0 }); db.close();
    expect(readFileSync(path)).toEqual(before);
  });

  it("applies all rows in dependency order", async () => {
    const { root, path, schemaPath } = fixture();
    const result = await invoke(["seed", schemaPath, "--target", `sqlite:${path}`, "--apply"], root);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/committed/i);
    const db = new DatabaseSync(path);
    expect(db.prepare("select count(*) as n from customers").get()).toEqual({ n: 2 });
    expect(db.prepare("select count(*) as n from orders").get()).toEqual({ n: 3 }); db.close();
  });

  it("rejects nonempty or mismatched targets without writes", async () => {
    const { root, path, schemaPath } = fixture();
    const db = new DatabaseSync(path); db.exec("insert into customers(id, name) values (99, 'existing')"); db.close();
    expect((await invoke(["seed", schemaPath, "--target", path, "--apply"], root)).code).toBe(1);
    const db2 = new DatabaseSync(path);
    expect(db2.prepare("select count(*) as n from customers").get()).toEqual({ n: 1 }); db2.close();
    writeFileSync(schemaPath, JSON.stringify({ tables: { customers: { rows: 1, columns: { id: { type: "integer", primaryKey: true }, renamed: { type: "string" } } } } }));
    expect((await invoke(["seed", schemaPath, "--target", path], root)).err).toMatch(/columns differ/i);
  });

  it("rolls back earlier table inserts when a later insert fails", async () => {
    const { root, path, schemaPath } = fixture();
    const db = new DatabaseSync(path);
    db.exec("create trigger reject_order before insert on orders begin select raise(abort, 'blocked'); end");
    db.close();
    const result = await invoke(["seed", schemaPath, "--target", path, "--apply"], root);
    expect(result.code).toBe(1);
    expect(result.out).not.toMatch(/committed/i);
    const check = new DatabaseSync(path);
    expect(check.prepare("select count(*) as n from customers").get()).toEqual({ n: 0 });
    expect(check.prepare("select count(*) as n from orders").get()).toEqual({ n: 0 });
    check.close();
  });

  it("rejects raw database URLs and repeated or bad arguments before connecting", async () => {
    const { root, schemaPath } = fixture();
    const url = "postgres://user:very-secret@localhost:9/db";
    const result = await invoke(["seed", schemaPath, "--target", url], root);
    expect(result.code).toBe(1);
    expect(result.err).not.toContain("very-secret");
    expect(result.err).toMatch(/Network database URLs/);
    expect((await invoke(["seed", schemaPath, "--target", "missing.db", "--apply", "--apply"], root)).code).toBe(1);
  });

  it("reports LLM usage during preview without inserting rows", async () => {
    const { root, path, schemaPath } = fixture(true);
    const provider = { name: "fake", async complete(req: { user: string }) {
      const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
      return { text: JSON.stringify(Array.from({ length: n }, (_, i) => `name ${i}`)), usage: { inputTokens: 3, outputTokens: 2 } };
    } };
    const result = await invoke(["seed", schemaPath, "--target", path], root, { provider, env: {} });
    expect(result.code).toBe(0);
    expect(result.out + result.err).toMatch(/LLM.*1 call|llm.*1 call/i);
    const db = new DatabaseSync(path);
    expect(db.prepare("select count(*) as n from customers").get()).toEqual({ n: 0 }); db.close();
  });
});
