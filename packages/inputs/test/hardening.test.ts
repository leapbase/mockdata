import { describe, expect, it } from "vitest";
import { fromJsonSchema, inferFromSampleFiles, inferFromSamples, InferError, mapDbType, parseCsv, parseSample } from "../src/index.js";

describe("parseCsv on files without \\r", () => {
  it("gives the same rows for LF, CRLF and CR line endings, quotes included", () => {
    const lines = ["a,b,c", '1,"x, y",', '2,"say ""hi""",z', ',"multi', 'line",q', "3,,"];
    const expected = [["a", "b", "c"], ["1", "x, y", ""], ["2", 'say "hi"', "z"], ["", "multi\nline", "q"], ["3", "", ""]];
    expect(parseCsv(lines.join("\n") + "\n")).toEqual(expected);
    expect(parseCsv(lines.join("\r\n").replace("multi\r\nline", "multi\nline") + "\r\n")).toEqual(expected);
    expect(parseCsv(lines.join("\r").replace("multi\rline", "multi\nline"))).toEqual(expected);
    expect(parseCsv("one\ntwo\nthree")).toEqual([["one"], ["two"], ["three"]]);
  });

  it("is linear: 200,000 LF rows parse in well under the 100 s they used to take", () => {
    const text = "id,name,city\n" + "12345,Ann Example,Springfield\n".repeat(200_000);
    const start = performance.now();
    expect(parseCsv(text)).toHaveLength(200_001);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe("sample inference limits", () => {
  it("refuses rows that each bring their own column instead of analysing them all", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ [`k${i}`]: 1 }));
    const start = performance.now();
    expect(() => inferFromSamples({ t: rows })).toThrow(/more than 1000 different columns/);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("refuses a CSV with too many columns and a JSON document with too many tables", () => {
    expect(() => parseSample(Array.from({ length: 1001 }, (_, i) => `c${i}`).join(",") + "\n", "wide.csv")).toThrow(/1001 columns; the limit is 1000/);
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`t${i}`, [{ id: 1 }]]));
    expect(() => parseSample(JSON.stringify(many), "many.json")).toThrow(/1001 tables; the limit is 1000/);
  });

  it("does not run the type patterns over a very long cell", () => {
    const cell = "a@" + ".".repeat(200_000) + "@";
    const start = performance.now();
    const { schema } = inferFromSamples({ t: [{ v: cell }, { v: "b" }] });
    expect(schema.tables.t!.columns.v!.type).toBe("string");
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("accepts a sample file named after an Object.prototype member", () => {
    const { schema } = inferFromSampleFiles([{ name: "valueOf.csv", text: "id,name\n1,Ann\n2,Bo\n" }]);
    expect(Object.keys(schema.tables)).toEqual(["valueOf"]);
  });
});

describe("fromJsonSchema on hostile documents", () => {
  it("stops an allOf/$ref fan-out instead of expanding it for minutes", () => {
    const $defs: Record<string, unknown> = { l9: { type: "object", properties: { id: { type: "integer" } } } };
    for (let level = 8; level >= 0; level--) $defs[`l${level}`] = { allOf: Array.from({ length: 8 }, () => ({ $ref: `#/$defs/l${level + 1}` })) };
    const start = performance.now();
    expect(() => fromJsonSchema({ $defs })).toThrow(/too many times/);
    expect(performance.now() - start).toBeLessThan(5000);
  });

  it("reports a malformed document as InferError, not a TypeError", () => {
    for (const doc of [{ $defs: { a: null } }, { $defs: { a: { type: "object", properties: { x: { type: "string" } }, allOf: [{ required: 5 }] } } }, { $defs: { a: { type: "object", properties: { x: 7 } } } }]) {
      let thrown: unknown;
      let result: unknown;
      try {
        result = fromJsonSchema(doc as never);
      } catch (e) {
        thrown = e;
      }
      if (thrown !== undefined) expect(thrown, JSON.stringify(doc)).toBeInstanceOf(InferError);
      else expect(result).toBeDefined();
    }
  });

  it("drops a pattern the generator cannot produce, with a warning", () => {
    const { schema, warnings } = fromJsonSchema({ $defs: { item: { type: "object", properties: { id: { type: "integer" }, code: { type: "string", pattern: "^\\d{3}-(a|b)$" }, sku: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$" } } } } });
    expect(schema.tables.item!.columns.code!.pattern).toBeUndefined();
    expect(schema.tables.item!.columns.sku!.pattern).toBe("[A-Z]{3}-[0-9]{4}");
    expect(warnings.join("\n")).toMatch(/item\.code: pattern .* dropped/);
  });
});

describe("mapDbType", () => {
  it("is not slowed by an absurd declared type", () => {
    const start = performance.now();
    expect(mapDbType("(".repeat(200_000)).type).toBe("string");
    expect(mapDbType("int" + " ".repeat(200_000) + "x").type).toBeDefined();
    expect(performance.now() - start).toBeLessThan(500);
    expect(mapDbType("VARCHAR(255)").type).toBe("string");
    expect(mapDbType("BIGINT UNSIGNED").type).toBe("integer");
  });
});
