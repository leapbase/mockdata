import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, serialize, type IO } from "../src/cli.js";

const example = join(__dirname, "../../../examples/shop.yaml");
const llmExample = join(__dirname, "../../../examples/shop-llm.yaml");

/** Empty directory so a developer's real .env can never leak into a test. */
const emptyDir = mkdtempSync(join(tmpdir(), "mockdata-cwd-"));

async function execIn(cwd: string, llm: IO["llm"], ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (s) => (out += s), err: (s) => (err += s), llm, cwd });
  return { code, out, err };
}
const execWith = (llm: IO["llm"], ...argv: string[]) => execIn(emptyDir, llm, ...argv);
const exec = (...argv: string[]) => execWith({ env: {} }, ...argv);

describe("cli", () => {
  it("validates a schema", async () => {
    expect(await exec("validate", example)).toMatchObject({ code: 0, out: "OK: 2 tables\n" });
  });

  it("prints JSON for all tables by default", async () => {
    const { code, out } = await exec("generate", example);
    const data = JSON.parse(out);
    expect(code).toBe(0);
    expect(data.customers).toHaveLength(20);
    expect(data.orders).toHaveLength(100);
  });

  it("writes one CSV per table with a header row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockdata-"));
    expect((await exec("generate", example, "-o", dir, "-f", "csv")).code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["customers.csv", "orders.csv"]);
    const lines = readFileSync(join(dir, "orders.csv"), "utf8").trim().split("\n");
    expect(lines[0]).toBe("id,customer_id,placed_at,shipped_at,status,total");
    expect(lines).toHaveLength(101);
  });

  it("--seed changes the output and is reproducible", async () => {
    const a = (await exec("generate", example, "-s", "1")).out;
    expect((await exec("generate", example, "-s", "1")).out).toBe(a);
    expect((await exec("generate", example, "-s", "2")).out).not.toBe(a);
  });

  it("rejects bad input with a nonzero code", async () => {
    expect((await exec("generate")).code).toBe(1);
    expect((await exec("nope")).code).toBe(1);
    expect((await exec("generate", example, "-f", "xml")).code).toBe(1);
    expect((await exec("generate", example, "-f", "csv")).err).toMatch(/needs --out/);
    expect((await exec("generate", example, "-s", "abc")).code).toBe(1);
    expect((await exec("validate", "/no/such/file.yaml")).code).toBe(1);
  });
});

describe("cli with llm columns", () => {
  const provider = {
    name: "fake",
    async complete(req: { user: string }) {
      const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
      return { text: JSON.stringify(Array.from({ length: n }, (_, i) => `great product ${i}`)), usage: { inputTokens: 100, outputTokens: 40 } };
    },
  };

  it("validate works without an API key", async () => {
    expect(await execWith({ env: {} }, "validate", llmExample)).toMatchObject({ code: 0, out: "OK: 2 tables\n" });
  });

  it("generate fills llm columns and reports token usage on stderr", async () => {
    const { code, out, err } = await execWith({ provider, sleep: async () => {} }, "generate", llmExample);
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.reviews).toHaveLength(12);
    expect(data.reviews[0].body).toBe("great product 0");
    expect(err).toMatch(/llm: 1 call, 100 input \/ 40 output tokens; filled reviews\.body \(12 rows\)/);
  });

  it("generate says which variable is missing instead of crashing", async () => {
    const { code, err } = await execWith({ env: {} }, "generate", llmExample);
    expect(code).toBe(1);
    expect(err).toMatch(/LlmConfigError: No LLM provider: .*AI_PROVIDER/);
    const noKey = await execWith({ env: { AI_PROVIDER: "anthropic", ANTHROPIC_MODEL: "m" } }, "generate", llmExample);
    expect(noKey.err).toMatch(/Missing API key: set ANTHROPIC_API_KEY/);
  });

  describe("reads provider settings from .env", () => {
    const fakeFetch = (seen: { url?: string; auth?: string | null; body?: any }) =>
      (async (url: string, init: RequestInit) => {
        seen.url = url;
        seen.auth = (init.headers as Record<string, string>).authorization ?? null;
        seen.body = JSON.parse(init.body as string);
        const n = Number(/exactly (\d+) strings/.exec(seen.body.messages[1].content)![1]);
        const text = JSON.stringify(Array.from({ length: n }, (_, i) => `note ${i}`));
        return new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      }) as unknown as typeof fetch;

    it("ollama: provider, model and host come from .env; no key needed; /v1 is added", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mockdata-env-"));
      writeFileSync(join(dir, ".env"), "# comment\nAI_PROVIDER=ollama\nOLLAMA_BASE_URL=http://10.0.0.5:11434\nOLLAMA_MODEL=llama3\n");
      const seen: { url?: string; auth?: string | null; body?: any } = {};
      const { code, out, err } = await execIn(dir, { env: {}, fetch: fakeFetch(seen), sleep: async () => {} }, "generate", llmExample);
      expect(err).not.toMatch(/Error/);
      expect(code).toBe(0);
      expect(seen.url).toBe("http://10.0.0.5:11434/v1/chat/completions");
      expect(seen.auth).toBeNull();
      expect(seen.body.model).toBe("llama3");
      expect(JSON.parse(out).reviews[0].body).toBe("note 0");
    });

    it("the real environment overrides .env", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mockdata-env-"));
      writeFileSync(join(dir, ".env"), "AI_PROVIDER=ollama\nOLLAMA_MODEL=from-dotenv\nOPENAI_MODEL=from-dotenv\n");
      const seen: { url?: string; auth?: string | null; body?: any } = {};
      const env = { AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-real" };
      const { code } = await execIn(dir, { env, fetch: fakeFetch(seen), sleep: async () => {} }, "generate", llmExample);
      expect(code).toBe(0);
      expect(seen.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(seen.auth).toBe("Bearer sk-real");
      expect(seen.body.model).toBe("from-dotenv");
    });

    it("never echoes secret values in errors", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mockdata-env-"));
      writeFileSync(join(dir, ".env"), "AI_PROVIDER=mystery\nOPENAI_API_KEY=sk-super-secret\n");
      const { err } = await execIn(dir, { env: {} }, "generate", llmExample);
      expect(err).toMatch(/Unknown LLM provider "mystery"/);
      expect(err).not.toContain("sk-super-secret");
    });
  });
});

describe("cli infer", () => {
  const work = mkdtempSync(join(tmpdir(), "mockdata-infer-"));
  const dbFile = join(work, "shop.db");
  const db = new DatabaseSync(dbFile);
  db.exec(`
    create table customers (id integer primary key, email text not null unique, name text);
    create table orders (id integer primary key, customer_id integer not null references customers(id), total real not null);
    create table nodes (id integer primary key, parent_id integer not null references nodes(id));
  `);
  db.close();

  it("prints a YAML schema to stdout and warnings to stderr, and the result validates and generates", async () => {
    const r = await execIn(work, { env: {} }, "infer", dbFile);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^tables:\n {2}customers:/);
    expect(r.out).not.toContain("warning");
    expect(r.err).toMatch(/warning: nodes\.parent_id: self-referencing foreign key made nullable/);

    const schemaFile = join(work, "inferred.yaml");
    writeFileSync(schemaFile, r.out);
    expect((await execIn(work, { env: {} }, "validate", schemaFile)).out).toBe("OK: 3 tables\n");
    const gen = await execIn(work, { env: {} }, "generate", schemaFile);
    expect(gen.code).toBe(0);
    expect(JSON.parse(gen.out).orders).toHaveLength(100);
  });

  it("--out writes YAML or JSON and refuses to overwrite without --force", async () => {
    const out = join(work, "out.yaml");
    expect((await execIn(work, { env: {} }, "infer", dbFile, "-o", out, "--rows", "7")).code).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/rows: 7/);
    const again = await execIn(work, { env: {} }, "infer", dbFile, "-o", out);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/Refusing to overwrite/);
    expect((await execIn(work, { env: {} }, "infer", dbFile, "-o", out, "--force")).code).toBe(0);

    const json = join(work, "out.json");
    expect((await execIn(work, { env: {} }, "infer", dbFile, "-o", json)).code).toBe(0);
    expect(JSON.parse(readFileSync(json, "utf8")).tables.customers.rows).toBe(100);
  });

  it("env:VAR takes the connection string from the environment or .env, and names the variable when missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mockdata-infer-env-"));
    writeFileSync(join(cwd, ".env"), `MY_DB=sqlite:${dbFile}\n`);
    const ok = await execIn(cwd, { env: {} }, "infer", "env:MY_DB");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("customers:");
    const missing = await execIn(work, { env: {} }, "infer", "env:NOPE_DB");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/Environment variable NOPE_DB is not set/);
  });

  it("infers from sample files and a directory, and from an OpenAPI file", async () => {
    const samples = mkdtempSync(join(tmpdir(), "mockdata-infer-samples-"));
    writeFileSync(join(samples, "customers.csv"), "id,name\n1,Ann\n2,Bo\n3,Cy\n");
    writeFileSync(join(samples, "orders.csv"), "id,customer_id\n1,1\n2,2\n3,1\n");
    const dir = await execIn(work, { env: {} }, "infer", samples);
    expect(dir.out).toMatch(/ref: customers\.id/);
    const api = join(work, "api.yaml");
    writeFileSync(api, "openapi: 3.0.0\ncomponents:\n  schemas:\n    Pet:\n      type: object\n      required: [id]\n      properties:\n        id: { type: integer }\n");
    expect((await execIn(work, { env: {} }, "infer", api)).out).toMatch(/Pet:/);
  });

  it("quotes date-like strings so any YAML parser reads them as strings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockdata-infer-dates-"));
    writeFileSync(join(dir, "events.csv"), "id,day\n" + Array.from({ length: 5 }, (_, i) => `${i + 1},2024-01-0${i + 1}`).join("\n") + "\n");
    const { out } = await execIn(work, { env: {} }, "infer", join(dir, "events.csv"));
    expect(out).toMatch(/min: "2024-01-01"/);
    expect(out).toMatch(/max: "2024-01-05"/);
  });

  it("rejects bad usage with a nonzero code", async () => {
    for (const argv of [["infer"], ["infer", "a", "b"], ["infer", dbFile, "--from", "xml"], ["infer", dbFile, "--rows", "-3"], ["infer", "/no/such/thing.csv"]]) {
      expect((await execIn(work, { env: {} }, ...argv)).code, argv.join(" ")).toBe(1);
    }
    expect((await execIn(work, { env: {} }, "infer", "--help")).out).toMatch(/mockdata infer/);
  });

  it("never prints a database password", async () => {
    const r = await execIn(work, { env: {} }, "infer", "postgres://alice:s3cret@127.0.0.1:1/db");
    expect(r.code).toBe(1);
    expect(r.err + r.out).not.toContain("s3cret");
  });
});

describe("csv output", () => {
  it("defuses text that a spreadsheet would run as a formula, but leaves numbers alone", () => {
    const rows = [{ a: "=HYPERLINK(\"http://evil\")", b: "+1", c: "-x", d: "@SUM(A1)", e: -5, f: "safe", g: "\tcmd" }];
    const [, line] = serialize(rows, ["a", "b", "c", "d", "e", "f", "g"], "csv").split("\n");
    expect(line).toBe(`"'=HYPERLINK(""http://evil"")",'+1,'-x,'@SUM(A1),-5,safe,'\tcmd`);
  });
});
