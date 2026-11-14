import { describe, expect, it } from "vitest";
import { compilePattern, generate, isoDate, isoDateTime, MAX_COLUMNS, MAX_TABLES, parseIsoDate, parseSchema, PatternError, SchemaError } from "../src/index.js";

const withPattern = (pattern: string, rows = 1) => ({ tables: { t: { rows, columns: { s: { type: "string", pattern } } } } });

describe("pattern dialect", () => {
  it("accepts what the generator can produce, and the values match", () => {
    for (const pattern of ["[A-Z]{3}-[0-9]{4}", "SKU-[0-9A-F]{6}", "a.b", "[^a-y]{3}", "[a-c]+x?", "US-2024-[0-9]{6}", "éé", "a b", "[a-z]{2,5}[0-9]*"]) {
      const rows = generate(withPattern(pattern, 200), { seed: 3 }).t!;
      const re = new RegExp(`^(?:${pattern})$`);
      for (const r of rows) expect(re.test(String(r.s)), `${pattern} -> ${String(r.s)}`).toBe(true);
    }
  });

  it("refuses syntax the generator would write out literally", () => {
    for (const pattern of ["a\\d", "(ab){2}", "a|b", "^ab$", "\\w{3}", "[\\d]{2}", "a{1,}", "a{3", "[a-z]{2,4}?", "-+", "[]]", "a{5,2}"]) {
      expect(() => parseSchema(withPattern(pattern)), pattern).toThrow(SchemaError);
      expect(() => compilePattern(pattern), pattern).toThrow(PatternError);
    }
    expect(() => parseSchema(withPattern("a\\d"))).toThrow(/write a class such as \[0-9\]/);
  });

  it("caps counts, so a short pattern cannot ask for megabyte values", () => {
    expect(() => parseSchema(withPattern("a{101}"))).toThrow(/at most 100/);
    expect(() => parseSchema(withPattern("[a-z]{1,30000000}"))).toThrow(/at most 100/);
    expect(() => parseSchema(withPattern("a{100}"))).not.toThrow();
  });

  it("matches in linear time where a RegExp backtracks for minutes", () => {
    // 14 adjacent a+ terms then a character that is not there: the old anchored RegExp re-check never finished.
    const evil = compilePattern("a+".repeat(60) + "b");
    const start = performance.now();
    expect(evil.test("a".repeat(5000))).toBe(false);
    expect(evil.test("a".repeat(5000) + "b")).toBe(true);
    expect(evil.test("a".repeat(59) + "b")).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("agrees with RegExp on random strings", () => {
    const patterns = ["[a-c]+x?", "a*b+c?", "[0-9]{2,4}-[a-b]*", ".{2}[^0-9]+", "ab{2}c", "a?a?a?b", "[a-b]{0,3}[b-c]{1,2}"];
    const alphabet = "abcx0-9\n";
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const pattern of patterns) {
      const mine = compilePattern(pattern);
      const re = new RegExp(`^(?:${pattern})$`);
      for (let i = 0; i < 3000; i++) {
        let s = "";
        for (let n = Math.floor(next() * 7); n > 0; n--) s += alphabet[Math.floor(next() * alphabet.length)];
        expect(mine.test(s), `${pattern} on ${JSON.stringify(s)}`).toBe(re.test(s));
      }
    }
  });
});

describe("schema size limits and reserved names", () => {
  const table = { rows: 1, columns: { id: { type: "integer" } } };

  it("refuses more tables or columns than the limits, before doing any other work", () => {
    const tables = Object.fromEntries(Array.from({ length: MAX_TABLES + 1 }, (_, i) => [`t${i}`, table]));
    expect(() => parseSchema({ tables })).toThrow(/1001 tables; the limit is 1000/);
    const columns = Object.fromEntries(Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => [`c${i}`, { type: "integer" }]));
    expect(() => parseSchema({ tables: { t: { rows: 1, columns } } })).toThrow(/1001 columns; the limit is 1000/);
  });

  it("refuses names that every object already has, as a SchemaError rather than a crash", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => parseSchema(JSON.parse(`{"tables": {"${name}": {"rows": 1, "columns": {"id": {"type": "integer"}}}}}`)), name).toThrow(/cannot be used as a table name/);
      expect(() => parseSchema(JSON.parse(`{"tables": {"t": {"rows": 1, "columns": {"${name}": {"type": "integer"}}}}}`)), name).toThrow(/cannot be used as a column name/);
    }
    expect(() => parseSchema({ tables: { t: { rows: 1, columns: { x: { type: "integer", ref: "valueOf.name" } } } } })).toThrow(/unknown table/);
  });
});

describe("fast date helpers", () => {
  it("write exactly what toISOString writes, and parse exactly what Date.parse parses", () => {
    const samples = [0, 1, -1, 86_399_999, 86_400_000, Date.UTC(2024, 1, 29), Date.UTC(2100, 1, 28, 23, 59, 59, 999), Date.UTC(1000, 0, 1), Date.UTC(9999, 11, 31), Date.UTC(999, 11, 31), Date.UTC(10000, 0, 1), 1.5, -62_198_755_200_000];
    for (let i = 0; i < 20_000; i++) samples.push(Math.floor((Math.sin(i) * 0.5 + 0.3) * 6e13));
    for (const ms of samples) {
      const iso = new Date(ms).toISOString();
      expect(isoDateTime(ms)).toBe(iso);
      expect(isoDate(ms)).toBe(iso.slice(0, 10));
      expect(parseIsoDate(iso.slice(0, 10))).toBe(Date.parse(iso.slice(0, 10)));
    }
    for (const s of ["2024-02-30", "2024-13-01", "abcd-ef-gh", "0999-01-01", "2024-1-01", "2024-01-01T00:00:00.000Z", "", "2024-01-31"]) {
      expect(Object.is(parseIsoDate(s), Date.parse(s)), s).toBe(true);
    }
  });
});
