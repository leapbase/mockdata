import { describe, expect, it } from "vitest";
import { boot, SHOP_YAML } from "./helpers.js";

describe("POST /api/validate", () => {
  it("summarises a valid schema with its generation order", async () => {
    const { post } = await boot();
    const r = await post("/api/validate", { text: SHOP_YAML });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      order: [["customers"], ["orders"]],
      deferred: [],
      llmColumns: [],
      tables: [
        { name: "customers", rows: 6, columns: ["id", "name"] },
        { name: "orders", rows: 15, columns: ["id", "customer_id", "total"] },
      ],
    });
  });

  it("reports a broken reference as an error, not a failure", async () => {
    const { post } = await boot();
    const text = SHOP_YAML.replace("customers.id", "nobody.id");
    const r = await post("/api/validate", { text });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.errors[0].message).toMatch(/nobody/);
  });

  it("gives the line of a YAML syntax error", async () => {
    const { post } = await boot();
    const r = await post("/api/validate", { text: "tables:\n  a:\n    rows: [1\n" });
    expect(r.json.ok).toBe(false);
    expect(r.json.errors[0].line).toBeGreaterThan(0);
  });

  it.each(["", "null", "[]", "42", "just words", "tables: 5"])("turns %j into errors, never a 500", async (text) => {
    const { post } = await boot();
    const r = await post("/api/validate", { text });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.errors.length).toBeGreaterThan(0);
  });

  it("reports an FK cycle that cannot be broken", async () => {
    const { post } = await boot();
    const text = `tables:
  a:
    rows: 2
    columns:
      id: { type: integer, primaryKey: true }
      b_id: { type: integer, ref: b.id }
  b:
    rows: 2
    columns:
      id: { type: integer, primaryKey: true }
      a_id: { type: integer, ref: a.id }
`;
    const r = await post("/api/validate", { text });
    expect(r.json.ok).toBe(false);
    expect(r.json.errors[0].message).toMatch(/cycle/i);
  });

  it("needs text and JSON", async () => {
    const { post, url } = await boot();
    expect((await post("/api/validate", {})).status).toBe(400);
    const res = await fetch(`${url}/api/validate`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
  });
});

describe("POST /api/generate", () => {
  it("returns capped preview rows, counts and FK metadata", async () => {
    const { post } = await boot();
    const r = await post("/api/generate", { text: SHOP_YAML, previewRows: 4 });
    expect(r.status).toBe(200);
    expect(r.json.seed).toBe(7);
    expect(r.json.counts).toEqual({ customers: 6, orders: 15 });
    expect(r.json.tables.orders.rows).toHaveLength(4);
    expect(r.json.tables.orders.columns).toEqual(["id", "customer_id", "total"]);
    expect(r.json.tables.orders.refs).toEqual({ customer_id: "customers.id" });
    expect(r.json.pending).toEqual([]);
  });

  it("is deterministic per seed and the seed can be overridden", async () => {
    const { post } = await boot();
    const a = await post("/api/generate", { text: SHOP_YAML, seed: 1 });
    const b = await post("/api/generate", { text: SHOP_YAML, seed: 1 });
    const c = await post("/api/generate", { text: SHOP_YAML, seed: 2 });
    expect(a.json.tables).toEqual(b.json.tables);
    expect(a.json.tables).not.toEqual(c.json.tables);
    expect(c.json.seed).toBe(2);
  });

  it("applies the row override to every table and can limit the tables returned", async () => {
    const { post } = await boot();
    const r = await post("/api/generate", { text: SHOP_YAML, rows: 3, tables: ["orders"] });
    expect(r.json.counts).toEqual({ customers: 3, orders: 3 });
    expect(Object.keys(r.json.tables)).toEqual(["orders"]);
  });

  it("refuses a huge row count instead of hanging", async () => {
    const { post } = await boot();
    const r = await post("/api/generate", { text: SHOP_YAML, rows: 10_000_000 });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/200000/);
    const inSchema = await post("/api/generate", { text: SHOP_YAML.replace("rows: 15", "rows: 900000") });
    expect(inSchema.status).toBe(400);
  });

  it("leaves llm columns pending (null) and lists them", async () => {
    const { post } = await boot();
    const text = `tables:
  notes:
    rows: 3
    columns:
      id: { type: integer, primaryKey: true }
      body: { type: string, llm: true }
`;
    const r = await post("/api/generate", { text });
    expect(r.status).toBe(200);
    expect(r.json.pending).toEqual(["notes.body"]);
    expect(r.json.tables.notes.rows.map((x: any) => x.body)).toEqual([null, null, null]);
  });

  it("answers an invalid schema with a 400 and the reason", async () => {
    const { post } = await boot();
    const r = await post("/api/generate", { text: "tables: 5" });
    expect(r.status).toBe(400);
    expect(r.json.error.name).toBe("SchemaError");
  });

  it("rejects bad field types", async () => {
    const { post } = await boot();
    expect((await post("/api/generate", { text: SHOP_YAML, seed: "x" })).status).toBe(400);
    expect((await post("/api/generate", { text: SHOP_YAML, tables: "orders" })).status).toBe(400);
  });
});
