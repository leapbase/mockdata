import { describe, expect, it } from "vitest";
import { CycleError, generate, generationLevels, parseSchema, planGeneration, SchemaError } from "../src/index.js";

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

describe("pattern", () => {
  const withPattern = (extra: object = {}) => ({
    seed: 3,
    tables: { skus: { rows: 30, columns: { code: { type: "string", pattern: "[A-Z]{3}-[0-9]{4}", unique: true, ...extra } } } },
  });

  it("generates strings matching the regex", () => {
    for (const r of generate(withPattern()).skus!) expect(r.code).toMatch(/^[A-Z]{3}-[0-9]{4}$/);
  });

  it("rejects invalid or misplaced patterns", () => {
    expect(() => parseSchema(withPattern({ pattern: "(" }))).toThrow(SchemaError);
    const onInt = { tables: { t: { rows: 1, columns: { n: { type: "integer", pattern: "[0-9]" } } } } };
    expect(() => parseSchema(onInt)).toThrow(/only applies to string/);
  });
});

describe("cardinality", () => {
  const rel = (child: object, parents = 5, children = 5) => ({
    seed: 9,
    tables: {
      users: { rows: parents, columns: { id: { type: "integer", primaryKey: true } } },
      profiles: { rows: children, columns: { user_id: { type: "integer", ref: "users.id", ...child } } },
    },
  });

  it("unique foreign key is one-to-one", () => {
    const ids = generate(rel({ unique: true })).profiles!.map((p) => p.user_id);
    expect(new Set(ids).size).toBe(5);
  });

  it("maxPerParent caps children even under heavy zipf skew", () => {
    const counts = new Map<unknown, number>();
    for (const p of generate(rel({ maxPerParent: 3, distribution: "zipf" }, 5, 12)).profiles!) {
      counts.set(p.user_id, (counts.get(p.user_id) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  it("fails clearly when capacity is impossible", () => {
    expect(() => generate(rel({ unique: true }, 3, 5))).toThrow(/per-parent limit of 1/);
  });

  it("rejects maxPerParent on non-foreign keys", () => {
    const bad = { tables: { t: { rows: 1, columns: { n: { type: "integer", maxPerParent: 2 } } } } };
    expect(() => parseSchema(bad)).toThrow(/only applies to foreign keys/);
  });
});

describe("cycles", () => {
  const cyc = (aNullable: boolean, bNullable: boolean) => ({
    seed: 5,
    tables: {
      teams: {
        rows: 4,
        columns: {
          id: { type: "integer", primaryKey: true },
          lead_id: { type: "integer", ref: "members.id", nullable: aNullable, nullRate: 0 },
        },
      },
      members: {
        rows: 10,
        columns: {
          id: { type: "integer", primaryKey: true },
          team_id: { type: "integer", ref: "teams.id", nullable: bNullable, nullRate: 0 },
        },
      },
    },
  });

  it("breaks a cycle through a nullable foreign key and fills it afterwards", () => {
    const schema = parseSchema(cyc(true, false));
    expect(planGeneration(schema)).toEqual({ levels: [["teams"], ["members"]], deferred: ["teams.lead_id"] });
    const data = generate(schema);
    const memberIds = new Set(data.members!.map((m) => m.id));
    for (const t of data.teams!) expect(memberIds.has(t.lead_id)).toBe(true);
    const teamIds = new Set(data.teams!.map((t) => t.id));
    for (const m of data.members!) expect(teamIds.has(m.team_id)).toBe(true);
  });

  it("still throws when no foreign key on the cycle is nullable", () => {
    expect(() => generate(cyc(false, false))).toThrow(CycleError);
  });

  it("does not defer nullable keys that are not on a cycle", () => {
    const s = {
      tables: {
        a: { rows: 2, columns: { id: { type: "integer", primaryKey: true } } },
        b: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, a_id: { type: "integer", ref: "a.id", nullable: true } } },
      },
    };
    expect(planGeneration(parseSchema(s)).deferred).toEqual([]);
  });
});

describe("llm columns", () => {
  const llmSchema = (col: object = { type: "string", llm: true }, top: object | null = { provider: "openai", model: "m" }) => ({
    seed: 1,
    ...(top ? { llm: top } : {}),
    tables: { reviews: { rows: 5, columns: { id: { type: "integer", primaryKey: true }, body: col } } },
  });

  it("does not require the top-level llm config (the environment can supply it)", () => {
    expect(() => parseSchema(llmSchema(undefined, null))).not.toThrow();
  });

  it("rejects llm on non-strings and combined with deterministic generators", () => {
    expect(() => parseSchema(llmSchema({ type: "integer", llm: true }))).toThrow(/only applies to string/);
    expect(() => parseSchema(llmSchema({ type: "string", llm: true, pattern: "a" }))).toThrow(/cannot be combined with "pattern"/);
  });

  it("accepts ollama as a provider name and rejects unknown ones", () => {
    expect(() => parseSchema(llmSchema(undefined, { provider: "ollama" }))).not.toThrow();
    expect(() => parseSchema(llmSchema(undefined, { provider: "mystery" }))).toThrow(SchemaError);
  });

  it("plain generate() refuses llm columns; deferLlm leaves them pending", () => {
    expect(() => generate(llmSchema())).toThrow(/generateWithLlm/);
    const rows = generate(llmSchema(), { deferLlm: true }).reviews!;
    expect(rows.every((r) => r.body === undefined && "body" in r)).toBe(true);
  });
});
