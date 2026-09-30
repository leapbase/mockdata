import { describe, expect, it } from "vitest";
import { CycleError, generate, generationLevels, parseSchema, SchemaError } from "../src/index.js";

const schema = {
  seed: 42,
  tables: {
    orders: {
      rows: 50,
      columns: {
        id: { type: "integer", primaryKey: true },
        customer_id: { type: "integer", ref: "customers.id", distribution: "zipf" },
        placed_at: { type: "date", after: "customer_id.signup_date" },
        shipped_at: { type: "date", after: "placed_at", nullable: true },
        status: { type: "string", enum: ["new", "paid", "shipped"] },
      },
    },
    customers: {
      rows: 10,
      columns: {
        id: { type: "integer", primaryKey: true },
        email: { type: "email", unique: true },
        signup_date: { type: "date", min: "2023-01-01", max: "2024-01-01" },
        referrer_id: { type: "integer", ref: "customers.id", nullable: true },
      },
    },
  },
};

describe("generate", () => {
  it("generates parents before children", () => {
    expect(generationLevels(parseSchema(schema))).toEqual([["customers"], ["orders"]]);
  });

  it("has no orphan foreign keys and respects cross-table date rules", () => {
    const data = generate(schema);
    const ids = new Set(data.customers!.map((c) => c.id));
    const signup = new Map(data.customers!.map((c) => [c.id, c.signup_date as string]));
    expect(data.orders).toHaveLength(50);
    for (const o of data.orders!) {
      expect(ids.has(o.customer_id)).toBe(true);
      expect((o.placed_at as string) >= signup.get(o.customer_id)!).toBe(true);
      if (o.shipped_at) expect((o.shipped_at as string) >= (o.placed_at as string)).toBe(true);
    }
  });

  it("supports nullable self references that only point at earlier rows", () => {
    const data = generate(schema);
    data.customers!.forEach((c, i) => {
      if (c.referrer_id !== null) expect(c.referrer_id as number).toBeLessThanOrEqual(i);
    });
  });

  it("is reproducible for the same seed and differs across seeds", () => {
    expect(generate(schema)).toEqual(generate(schema));
    expect(generate(schema, { seed: 7 })).not.toEqual(generate(schema));
  });

  it("gives unique emails", () => {
    const emails = generate(schema).customers!.map((c) => c.email);
    expect(new Set(emails).size).toBe(emails.length);
  });
});

describe("schema errors", () => {
  it("rejects refs to unknown tables", () => {
    const bad = { tables: { a: { rows: 1, columns: { x: { type: "integer", ref: "nope.id" } } } } };
    expect(() => parseSchema(bad)).toThrow(SchemaError);
  });

  it("fails loudly on FK cycles instead of guessing an order", () => {
    const cyc = {
      tables: {
        a: { rows: 1, columns: { id: { type: "integer", primaryKey: true }, b_id: { type: "integer", ref: "b.id" } } },
        b: { rows: 1, columns: { id: { type: "integer", primaryKey: true }, a_id: { type: "integer", ref: "a.id" } } },
      },
    };
    expect(() => generate(cyc)).toThrow(CycleError);
  });
});
