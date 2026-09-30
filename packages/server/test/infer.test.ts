import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSchema } from "@mockdata/core";
import { parse } from "yaml";
import { boot, tmpRoot } from "./helpers.js";

describe("POST /api/infer", () => {
  it("infers YAML from pasted sample rows", async () => {
    const { post } = await boot();
    const r = await post("/api/infer", { content: "id,name\n1,Ann\n2,Bo\n3,Cy\n", name: "people.csv" });
    expect(r.status).toBe(200);
    expect(r.json.tables).toEqual(["people"]);
    expect(Array.isArray(r.json.warnings)).toBe(true);
    expect(parseSchema(parse(r.json.schemaText)).tables.people).toBeDefined();
  });

  it("infers from a SQLite file under the root, with foreign keys", async () => {
    const root = tmpRoot();
    const db = new DatabaseSync(join(root, "shop.db"));
    db.exec(`create table customers (id integer primary key, name text not null);
             create table orders (id integer primary key, customer_id integer not null references customers(id));`);
    db.close();
    const { post } = await boot({ root });
    const r = await post("/api/infer", { path: "shop.db" });
    expect(r.status).toBe(200);
    expect(r.json.tables.sort()).toEqual(["customers", "orders"]);
    expect(parse(r.json.schemaText).tables.orders.columns.customer_id.ref).toBe("customers.id");
  });

  it("infers from JSON Schema pasted as content", async () => {
    const { post } = await boot();
    const doc = { type: "object", title: "Pet", properties: { id: { type: "integer" }, name: { type: "string" } }, required: ["id", "name"] };
    const r = await post("/api/infer", { content: JSON.stringify(doc), kind: "json-schema" });
    expect(r.status).toBe(200);
    expect(r.json.tables.length).toBe(1);
  });

  it.each([
    [{}, /exactly one/],
    [{ path: "../x.db" }, /outside/],
    [{ path: ".env" }, /\.env/],
    [{ connectionEnv: "OPENAI_API_KEY" }, /connectionEnv must be/],
    [{ connectionEnv: "DATABASE_URL" }, /is not set/],
    [{ path: "a.csv", content: "x" }, /exactly one/],
  ])("refuses %j", async (body, message) => {
    const { post } = await boot();
    const r = await post("/api/infer", body);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(message);
  });

  it("never accepts a raw connection string and never echoes an env value", async () => {
    const { post } = await boot({ env: { DATABASE_URL: "notaurl-hunter2" } });
    const direct = await post("/api/infer", { connectionEnv: "postgres://user:hunter2@host/db" });
    expect(direct.status).toBe(400);
    expect(direct.raw).not.toContain("hunter2");
    const bad = await post("/api/infer", { connectionEnv: "DATABASE_URL" });
    expect(bad.status).toBe(400);
    expect(bad.raw).not.toContain("hunter2");
  });

  it("reads database URLs from .env under the root by name, without echoing them", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, ".env"), "DATABASE_URL=sqlite:missing-file.db\n");
    const { post } = await boot({ root });
    const r = await post("/api/infer", { connectionEnv: "DATABASE_URL" });
    expect(r.raw).not.toContain("DATABASE_URL=");
  });
});
