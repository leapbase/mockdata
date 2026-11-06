import { describe, expect, it } from "vitest";
import { generate, parseSchema, planGeneration, SchemaError, validate, ValidationError } from "../src/index.js";

describe("SEC-M1: pattern and enum length caps", () => {
  const withPattern = (pattern: string) => ({
    tables: { t: { rows: 1, columns: { s: { type: "string", pattern } } } },
  });
  const withEnum = (entries: string[]) => ({
    tables: { t: { rows: 1, columns: { s: { type: "string", enum: entries } } } },
  });

  it("rejects patterns over 200 characters and accepts exactly 200", () => {
    expect(() => parseSchema(withPattern("a".repeat(201)))).toThrow(/pattern must be at most 200 characters/);
    expect(() => parseSchema(withPattern("a".repeat(200)))).not.toThrow();
  });

  it("rejects enums over 1000 entries and accepts exactly 1000", () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => `v${i}`);
    expect(() => parseSchema(withEnum(tooMany))).toThrow(/enum must have at most 1000 entries/);
    expect(() => parseSchema(withEnum(tooMany.slice(0, 1000)))).not.toThrow();
  });

  it("reports the cap as a SchemaError", () => {
    expect(() => parseSchema(withPattern("a".repeat(201)))).toThrow(SchemaError);
    expect(() => parseSchema(withEnum(Array.from({ length: 1001 }, (_, i) => `v${i}`)))).toThrow(SchemaError);
  });
});

describe("PERF-M1/PERF-M3: precomputed plans do not change output", () => {
  const rich = {
    seed: 11,
    tables: {
      customers: {
        rows: 20,
        columns: {
          id: { type: "integer", primaryKey: true },
          name: { type: "string", faker: "person.fullName" },
          email: { type: "email", unique: true },
          signup_date: { type: "date", min: "2023-01-01", max: "2024-01-01" },
          referrer_id: { type: "integer", ref: "customers.id", nullable: true },
        },
      },
      orders: {
        rows: 50,
        columns: {
          id: { type: "integer", primaryKey: true },
          customer_id: { type: "integer", ref: "customers.id", distribution: "zipf" },
          placed_at: { type: "date", after: "customer_id.signup_date" },
          shipped_at: { type: "date", after: "placed_at", nullable: true },
          code: { type: "string", pattern: "[A-Z]{3}-[0-9]{4}", unique: true },
          status: { type: "string", enum: ["new", "paid", "shipped"] },
        },
      },
    },
  };

  it("generate() with parsed schema + plan is byte-identical to generate() from raw input", () => {
    const parsed = parseSchema(rich);
    const plan = planGeneration(parsed);
    const fromRaw = generate(rich);
    expect(generate(parsed, { parsed, plan })).toEqual(fromRaw);
    expect(generate(rich, { plan })).toEqual(fromRaw);
    // Reusing the same plan a second time is identical too.
    expect(generate(parsed, { parsed, plan })).toEqual(fromRaw);
  });

  it("memoises per-table column orders on the supplied plan", () => {
    const parsed = parseSchema(rich);
    const plan = planGeneration(parsed);
    expect("columnOrders" in plan).toBe(false);
    generate(parsed, { parsed, plan });
    expect(plan.columnOrders).toEqual({
      customers: ["id", "name", "email", "signup_date", "referrer_id"],
      orders: ["id", "customer_id", "placed_at", "shipped_at", "code", "status"],
    });
  });

  it("still parses and plans when no parsed schema or plan is supplied", () => {
    expect(generate(rich)).toEqual(generate(rich));
  });
});

describe("PERF-M2: validate caps the collected violations", () => {
  it("counts beyond the 100-violation cap and shows the first 10", () => {
    const schema = parseSchema({
      tables: { t: { rows: 150, columns: { s: { type: "string", enum: ["a", "b"] } } } },
    });
    const data = { t: Array.from({ length: 150 }, () => ({ s: "zzz" })) };
    let caught: unknown;
    try {
      validate(schema, data);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const err = caught as ValidationError;
    expect(err.violations).toHaveLength(100);
    expect(err.message.startsWith("150 constraint violation(s):\n")).toBe(true);
    expect(err.message).toContain("t[0].s: zzz not in enum");
    expect(err.message).toContain("t[9].s: zzz not in enum");
    expect(err.message).not.toContain("t[10].s");
  });

  it("keeps the exact message for few violations", () => {
    const schema = parseSchema({
      tables: { t: { rows: 2, columns: { s: { type: "string", enum: ["a", "b"] } } } },
    });
    expect(() => validate(schema, { t: [{ s: "zzz" }, { s: "yyy" }] })).toThrowError(
      "2 constraint violation(s):\n  t[0].s: zzz not in enum\n  t[1].s: yyy not in enum",
    );
  });

  it("keeps the exact after/within messages", () => {
    const schema = parseSchema({
      tables: {
        stays: {
          rows: 1,
          columns: {
            id: { type: "integer", primaryKey: true },
            start: { type: "date" },
            end: { type: "date", after: "start", within: 7 },
          },
        },
      },
    });
    expect(() =>
      validate(schema, { stays: [{ id: 1, start: "2024-01-01", end: "2024-02-01" }] }),
    ).toThrowError("1 constraint violation(s):\n  stays[0].end: 2024-02-01 is more than 7 days after start");
  });
});
