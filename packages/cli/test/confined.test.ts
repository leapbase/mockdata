import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotEnv, assertNotSymlink, checkSchemaPath, dbEnvNames, inferConfined, isEnvFile, readFileConfined, readPrefixConfined, resolveInside, toYaml, UserError } from "../src/cli.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "mockdata-confined-")));

describe("resolveInside", () => {
  it("accepts paths inside the root, including ones that do not exist yet", () => {
    const root = tmp();
    expect(resolveInside(root, "a/b.yaml")).toBe(join(root, "a/b.yaml"));
  });
  it("rejects absolute paths, .. escapes and symlinks that leave the root", () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, "link"));
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(UserError);
    expect(() => resolveInside(root, "../x")).toThrow(/outside/);
    expect(() => resolveInside(root, "link/x.yaml")).toThrow(/outside/);
  });
  it("refuses an over-long path quickly instead of walking it", () => {
    const root = tmp();
    expect(resolveInside(root, "a/".repeat(500) + "x.yaml")).toBe(join(root, "a/".repeat(500) + "x.yaml"));
    const started = Date.now();
    expect(() => resolveInside(root, "a/".repeat(500_000) + "x.yaml")).toThrow(/longer than 1024/);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe("checkSchemaPath / isEnvFile", () => {
  it("allows schema extensions only, never .env files", () => {
    expect(checkSchemaPath("a/b.YAML")).toBe(".yaml");
    expect(checkSchemaPath("b.json")).toBe(".json");
    expect(() => checkSchemaPath("b.txt")).toThrow(/schemaPath must be a \.yaml/);
    expect(() => checkSchemaPath(".env.json")).toThrow(UserError);
    expect(isEnvFile("x/.env.local")).toBe(true);
    expect(isEnvFile("x/env.yaml")).toBe(false);
  });
});

describe("dbEnvNames", () => {
  it("lists database-looking variables that hold a supported URL, never other secrets", () => {
    const env = {
      DATABASE_URL: "postgres://u:pw@h/db",
      MY_MYSQL: "mysql://u@h/db",
      DB_NOTE: "not a url",
      ANTHROPIC_API_KEY: "postgres://sneaky",
      lower_db: "postgres://x",
    };
    expect(dbEnvNames(env)).toEqual(["DATABASE_URL", "MY_MYSQL"]);
  });
});

describe("inferConfined", () => {
  it("rejects a connectionEnv that is not database-shaped or holds no database URL, without echoing values", async () => {
    const root = tmp();
    await expect(inferConfined(root, { OPENAI_API_KEY: "sk-secret" }, { connectionEnv: "OPENAI_API_KEY" })).rejects.toThrow(/connectionEnv must be/);
    const err = await inferConfined(root, { DATABASE_URL: "sk-secret" }, { connectionEnv: "DATABASE_URL" }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(UserError);
    expect(String(err.message)).not.toContain("sk-secret");
    await expect(inferConfined(root, {}, { connectionEnv: "DATABASE_URL" })).rejects.toThrow(/DATABASE_URL is not set/);
  });
  it("never offers the operator's own MOCKDATA_ settings, such as the account database, as a source", async () => {
    const root = tmp();
    const env = { MOCKDATA_ACCOUNTS_DB: "postgres://ops:hunter2@db.internal/accounts", SHOP_DATABASE_URL: "postgres://app@localhost/shop" };
    expect(dbEnvNames(env)).toEqual(["SHOP_DATABASE_URL"]);
    const err = await inferConfined(root, env, { connectionEnv: "MOCKDATA_ACCOUNTS_DB" }).catch((e) => e as Error);
    expect(String(err.message)).toMatch(/connectionEnv must be/);
    expect(String(err.message)).not.toContain("hunter2");
  });
  it("requires exactly one source, refuses .env paths and escapes", async () => {
    const root = tmp();
    await expect(inferConfined(root, {}, {})).rejects.toThrow(/exactly one/);
    writeFileSync(join(root, ".env"), "A=1");
    await expect(inferConfined(root, {}, { path: ".env" })).rejects.toThrow(/\.env/);
    await expect(inferConfined(root, {}, { path: "../x.csv" })).rejects.toThrow(/outside/);
  });
  it("infers from inline sample rows and from a file under root", async () => {
    const root = tmp();
    const inline = await inferConfined(root, {}, { content: "id,name\n1,a\n2,b\n", name: "people.csv" });
    expect(Object.keys(inline.schema.tables)).toEqual(["people"]);
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d/orders.csv"), "id,total\n1,5\n2,6\n");
    const fromFile = await inferConfined(root, {}, { path: "d/orders.csv" });
    expect(Object.keys(fromFile.schema.tables)).toEqual(["orders"]);
  });
});

describe("readFileConfined / readPrefixConfined", () => {
  it("reads a normal file inside the root", () => {
    const root = tmp();
    writeFileSync(join(root, "a.yaml"), "tables:\n");
    expect(readFileConfined(root, join(root, "a.yaml"))).toBe("tables:\n");
    expect(readPrefixConfined(root, join(root, "a.yaml"), 4)).toBe("tabl");
  });

  it("refuses a symlink inside the root that points at a file outside it, without leaking its content", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.yaml"), "SECRET-CONTENT");
    symlinkSync(join(outside, "secret.yaml"), join(root, "s.yaml"));
    expect(() => readFileConfined(root, join(root, "s.yaml"))).toThrow(UserError);
    expect(() => readPrefixConfined(root, join(root, "s.yaml"), 16)).toThrow(UserError);
    let err: unknown;
    try {
      readFileConfined(root, join(root, "s.yaml"));
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).not.toContain("SECRET-CONTENT");
  });

  it("refuses a symlink to a .env file inside the root", () => {
    const root = tmp();
    writeFileSync(join(root, ".env"), "SECRET=1");
    symlinkSync(join(root, ".env"), join(root, "cfg.yaml"));
    expect(() => readFileConfined(root, join(root, "cfg.yaml"))).toThrow(/\.env/);
  });

  it("refuses a path that escapes the root", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "x.yaml"), "x");
    expect(() => readFileConfined(root, join(outside, "x.yaml"))).toThrow(/outside/);
  });

  it("readPrefixConfined reads only the first bytes", () => {
    const root = tmp();
    const text = "tables:\n" + "x".repeat(1000);
    writeFileSync(join(root, "a.yaml"), text);
    const prefix = readPrefixConfined(root, join(root, "a.yaml"), 16);
    expect(prefix).toBe(text.slice(0, 16));
    expect(prefix.length).toBe(16);
  });
});

describe("inferConfined confined reads", () => {
  it("refuses a symlinked sample file that points outside the root", async () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "leak.csv"), "id\n1\n");
    symlinkSync(join(outside, "leak.csv"), join(root, "leak.csv"));
    await expect(inferConfined(root, {}, { path: "leak.csv" })).rejects.toThrow(UserError);
  });

  it("infers from a directory, skipping symlinked children with a warning", async () => {
    const root = tmp();
    const outside = tmp();
    mkdirSync(join(root, "samples"));
    writeFileSync(join(root, "samples", "people.csv"), "id,name\n1,a\n2,b\n");
    writeFileSync(join(outside, "other.csv"), "id\n9\n");
    symlinkSync(join(outside, "other.csv"), join(root, "samples", "other.csv"));
    const result = await inferConfined(root, {}, { path: "samples" });
    expect(Object.keys(result.schema.tables)).toEqual(["people"]);
    expect(result.warnings.join(" ")).toMatch(/Skipped other\.csv: symlinks/);
  });

  it("infers from a JSON Schema file and a plain JSON sample file through the confined read", async () => {
    const root = tmp();
    writeFileSync(join(root, "api.json"), JSON.stringify({ type: "object", properties: { id: { type: "integer" } } }));
    const fromSchema = await inferConfined(root, {}, { path: "api.json", kind: "json-schema" });
    expect(Object.keys(fromSchema.schema.tables)).toEqual(["root"]);
    writeFileSync(join(root, "rows.json"), JSON.stringify([{ id: 1 }, { id: 2 }]));
    const fromSample = await inferConfined(root, {}, { path: "rows.json" });
    expect(Object.keys(fromSample.schema.tables)).toEqual(["rows"]);
  });
});

describe("toYaml", () => {
  it("quotes date-like strings so other YAML parsers keep them strings", () => {
    expect(toYaml({ d: "2024-01-01" })).toContain('"2024-01-01"');
  });
});

describe("symlink safety", () => {
  it("resolveInside rejects a dangling symlink and a symlinked directory that leads outside", () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(join(outside, "missing.yaml"), join(root, "evil.yaml"));
    expect(() => resolveInside(root, "evil.yaml")).toThrow(UserError);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    expect(resolveInside(root, "alias/x.yaml")).toContain("alias");
  });
  it("assertNotEnv refuses a file that is (or links to) a .env file", () => {
    const root = tmp();
    writeFileSync(join(root, ".env"), "SECRET=1");
    symlinkSync(join(root, ".env"), join(root, "cfg.yaml"));
    writeFileSync(join(root, "ok.yaml"), "tables: {}");
    expect(() => assertNotEnv(join(root, "cfg.yaml"))).toThrow(/\.env/);
    expect(() => assertNotEnv(join(root, "ok.yaml"))).not.toThrow();
    expect(() => assertNotEnv(join(root, "missing.yaml"))).not.toThrow();
  });
  it("assertNotSymlink refuses any existing symlink, live or dangling", () => {
    const root = tmp();
    writeFileSync(join(root, "a.yaml"), "x");
    symlinkSync(join(root, "a.yaml"), join(root, "live.yaml"));
    symlinkSync(join(root, "nope"), join(root, "dangling.yaml"));
    expect(() => assertNotSymlink(join(root, "live.yaml"))).toThrow(UserError);
    expect(() => assertNotSymlink(join(root, "dangling.yaml"))).toThrow(UserError);
    expect(() => assertNotSymlink(join(root, "a.yaml"))).not.toThrow();
    expect(() => assertNotSymlink(join(root, "absent.yaml"))).not.toThrow();
  });
});
