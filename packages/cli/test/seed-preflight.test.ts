import { describe, expect, it } from "vitest";
import { parseSchema } from "@mockdata/core";
import type { RawTable } from "@mockdata/inputs";
import { prepareSeedPlan, SeedPreflightError } from "../src/seed/preflight.js";

const catalog: RawTable[] = [
  { name: "orders", columns: [
    { name: "id", dataType: "integer", nullable: false },
    { name: "customer_id", dataType: "integer", nullable: false },
  ], primaryKey: ["id"], uniques: [], foreignKeys: [{ columns: ["customer_id"], refTable: "customers", refColumns: ["id"] }] },
  { name: "customers", columns: [
    { name: "id", dataType: "integer", nullable: false },
    { name: "email", dataType: "character varying", nullable: false },
  ], primaryKey: ["id"], uniques: [["email"]], foreignKeys: [] },
];

const schema = parseSchema({ tables: {
  orders: { rows: 4, columns: { id: { type: "integer", primaryKey: true }, customer_id: { type: "integer", ref: "customers.id" } } },
  customers: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, email: { type: "email", unique: true } } },
} });

describe("seed preflight", () => {
  it("preserves exact identifiers and orders parents first", () => {
    expect(prepareSeedPlan(schema, catalog, "postgres")).toEqual({ tables: [
      { name: "customers", columns: ["id", "email"], rows: 2 },
      { name: "orders", columns: ["id", "customer_id"], rows: 4 },
    ] });
  });

  it("rejects a sanitized or renamed catalog column", () => {
    const changed = structuredClone(catalog);
    changed[1]!.columns[1]!.name = "E-mail";
    expect(() => prepareSeedPlan(schema, changed, "postgres")).toThrow(SeedPreflightError);
  });

  it("rejects unsupported mapped types and composite constraints", () => {
    const changed = structuredClone(catalog);
    changed[1]!.columns[1]!.dataType = "jsonb";
    expect(() => prepareSeedPlan(schema, changed, "postgres")).toThrow(/unsupported/i);
    changed[1]!.columns[1]!.dataType = "character varying";
    changed[1]!.uniques = [["id", "email"]];
    expect(() => prepareSeedPlan(schema, changed, "postgres")).toThrow(/composite/i);
  });

  it("rejects a foreign key outside the schema", () => {
    const changed = structuredClone(catalog);
    changed[0]!.foreignKeys[0]!.refTable = "other";
    expect(() => prepareSeedPlan(schema, changed, "postgres")).toThrow(/outside/i);
  });

  it("rejects a deferred table cycle", () => {
    const cyclic = parseSchema({ tables: {
      a: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, b_id: { type: "integer", nullable: true, ref: "b.id" } } },
      b: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, a_id: { type: "integer", nullable: true, ref: "a.id" } } },
    } });
    const tables: RawTable[] = [
      { name: "a", columns: [{ name: "id", dataType: "integer", nullable: false }, { name: "b_id", dataType: "integer", nullable: true }], primaryKey: ["id"], uniques: [], foreignKeys: [{ columns: ["b_id"], refTable: "b", refColumns: ["id"] }] },
      { name: "b", columns: [{ name: "id", dataType: "integer", nullable: false }, { name: "a_id", dataType: "integer", nullable: true }], primaryKey: ["id"], uniques: [], foreignKeys: [{ columns: ["a_id"], refTable: "a", refColumns: ["id"] }] },
    ];
    expect(() => prepareSeedPlan(cyclic, tables, "sqlite")).toThrow(/cycle/i);
  });
});
