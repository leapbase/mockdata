import { describe, expect, it } from "vitest";
import { generate, parseSchema } from "@mockdata/core";
import { fromJsonSchema, InferError } from "../src/index.js";

const openapi = {
  openapi: "3.0.3",
  components: {
    schemas: {
      Customer: {
        type: "object",
        required: ["id", "email", "name"],
        properties: {
          id: { type: "integer" },
          email: { type: "string", format: "email" },
          name: { type: "string" },
          signup_date: { type: "string", format: "date" },
          tier: { type: "string", enum: ["free", "pro"] },
          nickname: { type: "string", nullable: true },
        },
      },
      Order: {
        type: "object",
        required: ["id", "customer_id", "total"],
        "x-rows": 40,
        properties: {
          id: { type: "integer" },
          customer_id: { type: "integer" },
          total: { type: "number", minimum: 1, maximum: 500 },
          placed_at: { type: "string", format: "date-time" },
          items: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

describe("fromJsonSchema", () => {
  it("turns OpenAPI schemas into tables, and <thing>_id into a foreign key", () => {
    const { schema, warnings } = fromJsonSchema(openapi, { rows: 30 });
    expect(Object.keys(schema.tables)).toEqual(["Customer", "Order"].map((n) => n));
    const c = schema.tables.Customer!;
    expect(c.rows).toBe(30);
    expect(c.columns.id).toMatchObject({ type: "integer", primaryKey: true });
    expect(c.columns.email).toMatchObject({ type: "email" });
    expect(c.columns.name).toMatchObject({ type: "string" });
    expect(c.columns.name!.nullable).toBeUndefined(); // required
    expect(c.columns.signup_date).toMatchObject({ type: "date", nullable: true }); // optional
    expect(c.columns.tier).toMatchObject({ type: "string", enum: ["free", "pro"] });
    expect(c.columns.nickname!.nullable).toBe(true);

    const o = schema.tables.Order!;
    expect(o.rows).toBe(40); // x-rows wins
    expect(o.columns.customer_id).toMatchObject({ type: "integer", ref: "Customer.id" });
    expect(o.columns.total).toMatchObject({ type: "float", min: 1, max: 500 });
    expect(o.columns.placed_at).toMatchObject({ type: "datetime" });
    expect(o.columns.items).toBeUndefined();
    expect(warnings).toContain("Order.items: skipped (array)");
    expect(warnings.filter((w) => w.includes("does not validate"))).toEqual([]);
  });

  it("produces a schema mockdata can generate from", () => {
    const { schema } = fromJsonSchema(openapi);
    const data = generate(schema);
    const ids = new Set(data.Customer!.map((r) => r.id));
    for (const o of data.Order!) expect(ids.has(o.customer_id)).toBe(true);
  });

  it("handles Pydantic-style output: $defs, Optional via anyOf, nested models skipped", () => {
    const doc = {
      title: "Team",
      type: "object",
      required: ["id", "lead"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { anyOf: [{ type: "string" }, { type: "null" }] },
        size: { type: ["integer", "null"], minimum: 1 },
        lead: { $ref: "#/$defs/Person" },
      },
      $defs: {
        Person: { type: "object", required: ["id"], properties: { id: { type: "integer" }, tags: { type: "array", items: { type: "string" } } } },
      },
    };
    const { schema, warnings } = fromJsonSchema(doc);
    expect(Object.keys(schema.tables).sort()).toEqual(["Person", "Team"]);
    expect(schema.tables.Team!.columns.id).toMatchObject({ type: "uuid", primaryKey: true });
    expect(schema.tables.Team!.columns.name).toMatchObject({ type: "string", nullable: true });
    expect(schema.tables.Team!.columns.size).toMatchObject({ type: "integer", nullable: true, min: 1 });
    expect(warnings).toContain("Team.lead: skipped (nested object)");
  });

  it("merges allOf and resolves $ref", () => {
    const doc = {
      $defs: {
        Base: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        Pet: { allOf: [{ $ref: "#/$defs/Base" }, { type: "object", properties: { species: { type: "string", enum: ["cat", "dog"] } }, required: ["species"] }] },
      },
    };
    const { schema } = fromJsonSchema(doc);
    expect(schema.tables.Pet!.columns).toMatchObject({ id: { primaryKey: true }, species: { enum: ["cat", "dog"] } });
  });

  it("supports explicit x-mockdata-ref and strips regex anchors from patterns", () => {
    const doc = {
      $defs: {
        Tenant: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        Site: {
          type: "object",
          required: ["id", "owner", "code"],
          properties: { id: { type: "integer" }, owner: { type: "integer", "x-mockdata-ref": "Tenant.id" }, code: { type: "string", pattern: "^[A-Z]{3}-[0-9]{2}$" } },
        },
      },
    };
    const { schema } = fromJsonSchema(doc);
    expect(schema.tables.Site!.columns.owner!.ref).toBe("Tenant.id");
    expect(schema.tables.Site!.columns.code!.pattern).toBe("[A-Z]{3}-[0-9]{2}");
    expect(generate(schema).Site!.every((r) => /^[A-Z]{3}-[0-9]{2}$/.test(r.code as string))).toBe(true);
  });

  it("does not link a *_id column when no parent has a same-typed key", () => {
    const doc = {
      $defs: {
        User: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        Post: { type: "object", required: ["id", "user_id"], properties: { id: { type: "integer" }, user_id: { type: "integer" } } },
      },
    };
    expect(fromJsonSchema(doc).schema.tables.Post!.columns.user_id!.ref).toBeUndefined();
  });

  it("makes sanitised, unique table names and rejects documents with no tables", () => {
    const { schema } = fromJsonSchema({ $defs: { "My Model": { type: "object", properties: { a: { type: "string" } } }, "My-Model": { type: "object", properties: { a: { type: "string" } } } } });
    expect(Object.keys(schema.tables)).toEqual(["My_Model", "My-Model"]);
    expect(() => parseSchema(schema)).not.toThrow();
    expect(() => fromJsonSchema({ type: "string" })).toThrow(InferError);
    expect(() => fromJsonSchema({ $ref: "nope" } as never)).toThrow(InferError);
  });
});
