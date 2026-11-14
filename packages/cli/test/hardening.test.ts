import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRowBudget, assertSchemaTextSize, checkSchemaPath, inferConfined, isEnvFile, parseSchemaText, readFileConfined, resolveInside, run, serialize, UserError, writeFileConfined } from "../src/cli.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "mockdata-hardening-")));
const SECRET = "ANTHROPIC_API_KEY=sk-ant-very-secret";

describe(".env files cannot be read back through infer", () => {
  it("treats the name case-insensitively (.ENV opens .env on macOS and Windows) and covers prod.env", () => {
    for (const name of [".env", ".ENV", ".Env.local", "prod.env", "PROD.ENV", "prod.env.json", "config.env.yaml"]) expect(isEnvFile(name), name).toBe(true);
    for (const name of ["environment.yaml", "env.yaml", "shop.yaml", "events.csv"]) expect(isEnvFile(name), name).toBe(false);
  });

  it("refuses .ENV, other env files and anything that is not a sample, schema document or SQLite file", async () => {
    const root = tmp();
    for (const name of [".env", "prod.env", ".npmrc", "notes.txt", "id_rsa"]) writeFileSync(join(root, name), `${SECRET}\nB=2\n`);
    for (const name of [".ENV", ".env", "prod.env", ".npmrc", "notes.txt", "id_rsa"]) {
      const err = await inferConfined(root, {}, { path: name }).catch((e) => e as Error);
      expect(err, name).toBeInstanceOf(Error);
      expect(err.message, name).not.toContain("sk-ant");
    }
    writeFileSync(join(root, "people.csv"), "id,name\n1,Ann\n2,Bo\n");
    expect(Object.keys((await inferConfined(root, {}, { path: "people.csv" })).schema.tables)).toEqual(["people"]);
  });

  it("does not quote a file's content when it is not valid JSON", async () => {
    const root = tmp();
    writeFileSync(join(root, "creds.json"), SECRET);
    const err = await inferConfined(root, {}, { path: "creds.json" }).catch((e) => e as Error);
    expect(err.message).toMatch(/invalid JSON/);
    expect(err.message).not.toMatch(/sk-ant|ANTHROPIC/);
  });

  it("skips env-named files in a sample folder and bounds how many files it reads", async () => {
    const root = tmp();
    mkdirSync(join(root, "samples"));
    writeFileSync(join(root, "samples", "prod.env.csv"), `${SECRET}\n`);
    writeFileSync(join(root, "samples", "people.csv"), "id,name\n1,Ann\n2,Bo\n");
    expect(Object.keys((await inferConfined(root, {}, { path: "samples" })).schema.tables)).toEqual(["people"]);
    for (let i = 0; i < 201; i++) writeFileSync(join(root, "samples", `t${i}.csv`), "id\n1\n");
    await expect(inferConfined(root, {}, { path: "samples" })).rejects.toThrow(/limit is 200/);
  });
});

describe("confined files", () => {
  it("refuses a hard link, which may name a file outside the root", () => {
    const root = tmp();
    const outside = join(tmp(), "secret.yaml");
    writeFileSync(outside, "tables: {}\n");
    linkSync(outside, join(root, "linked.yaml"));
    expect(() => readFileConfined(root, resolveInside(root, "linked.yaml"))).toThrow(/hard link/);
    expect(() => writeFileConfined(root, resolveInside(root, "linked.yaml"), "x", { overwrite: true })).toThrow(/hard link/);
    expect(readFileSync(outside, "utf8")).toBe("tables: {}\n");
  });

  it("limits how deeply a schema path may nest (every missing folder would be created)", () => {
    expect(() => checkSchemaPath("a/b/c/d/e/s.yaml")).not.toThrow();
    expect(() => checkSchemaPath("a/b/c/d/e/f/s.yaml")).toThrow(/nested too deeply/);
    expect(() => checkSchemaPath(Array.from({ length: 200 }, (_, i) => `a${i}`).join("/") + "/s.yaml")).toThrow(UserError);
  });
});

describe("budgets for untrusted schemas", () => {
  it("counts values, not just rows: a wide table is refused", () => {
    const columns = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`c${i}`, {}]));
    expect(() => assertRowBudget({ tables: { t: { rows: 100_000, columns } } })).toThrow(/20000000 values/);
    expect(() => assertRowBudget({ tables: { t: { rows: 50_000, columns } } })).not.toThrow();
  });

  it("caps schema text size", () => {
    expect(() => assertSchemaTextSize("x".repeat(2 * 1024 * 1024 + 1))).toThrow(/larger than 2 MB/);
    expect(() => assertSchemaTextSize("tables: {}")).not.toThrow();
  });
});

describe("schema text parsing", () => {
  it("still refuses duplicate keys, with the line", () => {
    const err = (() => {
      try {
        parseSchemaText("tables:\n  a: 1\n  b: 2\n  a: 3\n");
      } catch (e) {
        return e as Error & { linePos?: { line: number }[] };
      }
    })();
    expect(err?.message).toMatch(/Map keys must be unique/);
    expect(err?.linePos?.[0]?.line).toBe(4);
    expect(parseSchemaText("a: 1\nb: {a: 2}\n")).toEqual({ a: 1, b: { a: 2 } });
    expect(parseSchemaText('{"a": [1, {"b": null}]}')).toEqual({ a: [1, { b: null }] });
    expect(() => parseSchemaText("a: [1, 2")).toThrow();
  });

  it("parses one large map in linear time (the library's own duplicate check is quadratic)", () => {
    let text = "tables:\n  t:\n    rows: 1\n    columns:\n";
    for (let i = 0; i < 40_000; i++) text += `      c${i}: {type: string}\n`;
    const start = performance.now();
    const doc = parseSchemaText(text) as { tables: { t: { columns: object } } };
    expect(Object.keys(doc.tables.t.columns)).toHaveLength(40_000);
    expect(performance.now() - start).toBeLessThan(3000); // was about 6 s
  });
});

describe("csv output", () => {
  it("escapes header names like any other cell", () => {
    const text = serialize([{ '=HYPERLINK("http://x","y")': 1, "a,b\nc": 2 }], ['=HYPERLINK("http://x","y")', "a,b\nc"], "csv");
    expect(text).toBe(`"'=HYPERLINK(""http://x"",""y"")","a,b\nc"\n1,2\n`);
  });

  it("writes the same json and csv files in chunks as in one piece", async () => {
    const dir = tmp();
    const schema = join(dir, "s.json");
    writeFileSync(schema, JSON.stringify({ tables: { t: { rows: 2500, columns: { id: { type: "integer", primaryKey: true }, "we,ird\nname": { type: "string", faker: "person.fullName" } } }, empty: { rows: 0, columns: { id: { type: "integer" } } } } }));
    const io = { out: () => undefined, err: () => undefined, llm: { env: {} }, cwd: dir };
    let all = "";
    expect(await run(["generate", schema], { ...io, out: (s: string) => (all += s) })).toBe(0);
    const data = JSON.parse(all) as Record<string, Record<string, unknown>[]>;
    for (const format of ["json", "csv", "ndjson"] as const) {
      expect(await run(["generate", schema, "-o", join(dir, format), "-f", format], io)).toBe(0);
      for (const table of ["t", "empty"]) {
        expect(readFileSync(join(dir, format, `${table}.${format}`), "utf8"), `${table}.${format}`).toBe(serialize(data[table]!, table === "t" ? ["id", "we,ird\nname"] : ["id"], format));
      }
    }
  });
});

describe("infer env:NAME", () => {
  it("never prints the value of a variable that is not a database URL", async () => {
    let err = "";
    const code = await run(["infer", "env:ANTHROPIC_API_KEY"], { out: () => undefined, err: (s) => (err += s), llm: { env: { ANTHROPIC_API_KEY: "sk-ant-very-secret" } }, cwd: tmp() });
    expect(code).toBe(1);
    expect(err).toMatch(/ANTHROPIC_API_KEY does not hold a supported database URL/);
    expect(err).not.toContain("sk-ant");
  });
});
