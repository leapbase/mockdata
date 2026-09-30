import { describe, expect, it } from "vitest";
import { generate, parseSchema } from "@mockdata/core";
import { inferFromSampleFiles, inferFromSamples, parseCsv, parseSample } from "../src/index.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF, embedded newlines and a BOM", () => {
    const csv = '﻿a,b,c\r\n1,"hello, world","say ""hi"""\r\n2,"line1\nline2",\r\n';
    expect(parseCsv(csv)).toEqual([["a", "b", "c"], ["1", "hello, world", 'say "hi"'], ["2", "line1\nline2", ""]]);
  });
  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/unterminated/);
  });
});

describe("parseSample", () => {
  it("reads csv, ndjson, json arrays and json objects of arrays", () => {
    expect(parseSample("id,name\n1,a\n", "people.csv").people).toEqual([{ id: "1", name: "a" }]);
    expect(parseSample('{"id":1}\n{"id":2}\n', "t.ndjson").t).toHaveLength(2);
    expect(parseSample('[{"id":1}]', "t.json").t).toEqual([{ id: 1 }]);
    expect(Object.keys(parseSample('{"users":[{"id":1}],"orders":[{"id":2}]}', "db.json"))).toEqual(["users", "orders"]);
    expect(() => parseSample("[1,2]", "t.json")).toThrow(/array of objects/);
  });
});

const days = (n: number) => new Date(Date.UTC(2024, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

describe("inferFromSamples: single table", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: String(i + 1),
    email: `user${i}@example.com`,
    age: String(20 + (i % 30)),
    score: (i * 1.5).toFixed(1),
    active: i % 2 ? "true" : "false",
    joined: days(i),
    status: ["new", "paid", "shipped", "returned"][i % 4],
    nickname: i % 4 === 0 ? "" : `nick-${i}`,
    full_name: `Person Number ${i}`,
  }));

  it("infers types, ranges, nulls, enums, keys and faker hints from CSV-like text", () => {
    const { schema } = inferFromSamples({ people: rows }, { textual: true });
    const c = schema.tables.people!.columns;
    expect(schema.tables.people!.rows).toBe(40);
    expect(c.id).toEqual({ type: "integer", primaryKey: true });
    expect(c.email).toMatchObject({ type: "email", unique: true });
    expect(c.age).toMatchObject({ type: "integer", min: 20, max: 49 });
    expect(c.score).toMatchObject({ type: "float", min: 0, max: 58.5 });
    expect(c.active).toMatchObject({ type: "boolean" });
    expect(c.joined).toMatchObject({ type: "date", min: "2024-01-01", max: days(39) });
    expect(c.status).toMatchObject({ type: "string", enum: ["new", "paid", "returned", "shipped"] });
    expect(c.nickname).toMatchObject({ nullable: true, nullRate: 0.25 });
    expect(c.full_name).toMatchObject({ type: "string", faker: "person.fullName" });
  });

  it("does not copy free-text values, and can turn enums off", () => {
    const { schema } = inferFromSamples({ people: rows }, { textual: true });
    expect(JSON.stringify(schema)).not.toContain("Person Number");
    expect(JSON.stringify(schema)).not.toContain("nick-");
    const off = inferFromSamples({ people: rows }, { textual: true, enums: false }).schema.tables.people!.columns.status!;
    expect(off.enum).toBeUndefined();
  });

  it("keeps JSON strings as strings but reads JSON numbers as numbers", () => {
    const { schema } = inferFromSamples({ t: [{ code: "007", n: 5 }, { code: "042", n: 6.5 }] }, { textual: false });
    expect(schema.tables.t!.columns.code!.type).toBe("string");
    expect(schema.tables.t!.columns.n).toMatchObject({ type: "float", min: 5, max: 6.5 });
  });

  it("respects a rows override", () => {
    expect(inferFromSamples({ t: [{ a: 1 }] }, { rows: 500 }).schema.tables.t!.rows).toBe(500);
  });
});

describe("inferFromSamples: relationships and rules", () => {
  const customers = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), signup: days(i * 3) }));
  // Skewed: most orders belong to the first few customers. Each order is placed after signup and shipped after being placed.
  const orders = Array.from({ length: 120 }, (_, i) => {
    const cust = i < 80 ? (i % 4) + 1 : (i % 30) + 1;
    const placed = 100 + i;
    return { id: String(i + 1), customer_id: String(cust), placed_at: days(placed), shipped_at: days(placed + 1 + (i % 5)) };
  });
  const result = inferFromSamples({ customers, orders }, { textual: true });
  const o = result.schema.tables.orders!.columns;

  it("finds the foreign key by name and the skew of its children", () => {
    expect(o.customer_id).toMatchObject({ type: "integer", ref: "customers.id", distribution: "zipf" });
    expect(o.customer_id!.min).toBeUndefined();
  });

  it("infers date ordering that holds in every row, within the table and through the foreign key", () => {
    expect(o.shipped_at).toMatchObject({ after: "placed_at" });
    expect(o.shipped_at!.max).toBeUndefined();
    expect(o.placed_at).toMatchObject({ after: "customer_id.signup" });
    expect(result.warnings.some((w) => w.includes('orders.shipped_at: inferred "after placed_at"'))).toBe(true);
  });

  it("does not invent rules with too few rows or when ordering is violated", () => {
    const few = inferFromSamples({ t: [{ a: days(1), b: days(0) }, { a: days(3), b: days(2) }] }).schema.tables.t!.columns;
    expect(few.a!.after).toBeUndefined();
    const mixed = Array.from({ length: 40 }, (_, i) => ({ a: days(i), b: days(i % 2 ? i - 1 : i + 1) }));
    expect(inferFromSamples({ t: mixed }).schema.tables.t!.columns.a!.after).toBeUndefined();
  });

  it("detects one-to-one foreign keys and warns when the parent sample is partial", () => {
    const users = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    const profiles = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, user_id: i + 1 }));
    expect(inferFromSamples({ users, profiles }).schema.tables.profiles!.columns.user_id).toMatchObject({ ref: "users.id", unique: true });
    const orphaned = inferFromSamples({ users: users.slice(0, 3), profiles }).warnings;
    expect(orphaned.some((w) => w.includes("not present in users.id"))).toBe(true);
  });

  it("round trip: a schema inferred from generated data can generate data again", () => {
    const original = {
      seed: 5,
      tables: {
        customers: { rows: 40, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string", faker: "person.fullName" }, signup_date: { type: "date", min: "2023-01-01", max: "2023-12-31" } } },
        orders: {
          rows: 150,
          columns: {
            id: { type: "integer", primaryKey: true },
            customer_id: { type: "integer", ref: "customers.id", distribution: "zipf" },
            placed_at: { type: "date", after: "customer_id.signup_date" },
            status: { type: "string", enum: ["new", "paid", "shipped"] },
            total: { type: "float", min: 5, max: 500 },
          },
        },
      },
    };
    const data = generate(original);
    const inferred = inferFromSamples(data as never).schema;
    expect(() => parseSchema(inferred)).not.toThrow();
    expect(inferred.tables.orders!.columns.customer_id).toMatchObject({ ref: "customers.id" });
    expect(inferred.tables.orders!.columns.placed_at).toMatchObject({ after: "customer_id.signup_date" });
    const again = generate(inferred);
    expect(again.orders).toHaveLength(150);
    expect(new Set(again.orders!.map((r) => r.status))).toEqual(new Set(["new", "paid", "shipped"]));
  });
});

describe("inferFromSampleFiles", () => {
  it("links several files into one schema", () => {
    const { schema } = inferFromSampleFiles([
      { name: "customers.csv", text: "id,name\n1,Ann\n2,Bo\n3,Cy\n" },
      { name: "orders.csv", text: "id,customer_id,total\n1,1,9.5\n2,1,3\n3,2,7\n" },
    ]);
    expect(schema.tables.orders!.columns.customer_id).toMatchObject({ ref: "customers.id" });
    expect(schema.tables.orders!.columns.total).toMatchObject({ type: "float" });
  });
});
