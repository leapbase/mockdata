import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSchemaPath, dbEnvNames, inferConfined, isEnvFile, resolveInside, toYaml, UserError } from "../src/cli.js";

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

describe("toYaml", () => {
  it("quotes date-like strings so other YAML parsers keep them strings", () => {
    expect(toYaml({ d: "2024-01-01" })).toContain('"2024-01-01"');
  });
});
