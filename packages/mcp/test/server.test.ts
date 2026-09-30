import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "../src/index.js";

const schema = {
  seed: 7,
  tables: {
    customers: { rows: 6, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string", faker: "person.fullName" } } },
    orders: {
      rows: 15,
      columns: { id: { type: "integer", primaryKey: true }, customer_id: { type: "integer", ref: "customers.id" }, total: { type: "float", min: 1, max: 9 } },
    },
  },
};

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "mockdata-mcp-")));

async function start(opts: ServerOptions = {}) {
  const root = opts.root ?? tmp();
  const server = createServer({ env: {}, ...opts, root });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const body = r.content[0]!.text;
    return { isError: !!r.isError, body, json: () => JSON.parse(body) };
  };
  return { client, call, root };
}

describe("mcp server", () => {
  it("lists the tools", async () => {
    const { client } = await start();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["describe_schema_format", "generate_data", "get_run_report", "infer_schema", "validate_schema"]);
  });

  it("describe_schema_format returns the reference", async () => {
    const { call } = await start();
    expect((await call("describe_schema_format")).body).toMatch(/ref: parent_table\.column/);
  });

  it("validate_schema summarises a good schema, from an object or from YAML text", async () => {
    const { call } = await start();
    const fromObject = await call("validate_schema", { schema });
    expect(fromObject.json()).toMatchObject({ ok: true, tables: { orders: { rows: 15 } }, llmColumns: [] });
    const yaml = "tables:\n  t:\n    rows: 2\n    columns:\n      id: { type: integer, primaryKey: true }\n";
    expect((await call("validate_schema", { schema: yaml })).json().tables.t.rows).toBe(2);
  });

  it("validate_schema reports problems as tool errors, not crashes", async () => {
    const { call } = await start();
    const bad = { tables: { a: { rows: 1, columns: { x: { type: "integer", ref: "nope.id" } } } } };
    const r = await call("validate_schema", { schema: bad });
    expect(r.isError).toBe(true);
    expect(r.body).toMatch(/unknown table "nope"/);
    expect((await call("validate_schema", {})).body).toMatch(/exactly one of/);
    expect((await call("validate_schema", { schema, schemaPath: "x.yaml" })).isError).toBe(true);
  });

  it("generate_data returns counts, a capped preview and a run report", async () => {
    const { call } = await start();
    expect((await call("get_run_report")).body).toMatch(/No generate_data run yet/);
    const r = (await call("generate_data", { schema, previewRows: 2 })).json();
    expect(r.rows).toEqual({ customers: 6, orders: 15 });
    expect(r.preview.orders).toHaveLength(2);
    expect(r.seed).toBe(7);
    const ids = new Set((await call("generate_data", { schema, previewRows: 50 })).json().preview.customers.map((c: any) => c.id));
    expect(ids.size).toBe(6);
    const report = (await call("get_run_report")).json();
    expect(report).toMatchObject({ seed: 7, rows: { customers: 6, orders: 15 } });
    expect(report.llm).toBeUndefined();
  });

  it("same seed gives the same data through the tool", async () => {
    const { call } = await start();
    const a = (await call("generate_data", { schema, seed: 3, previewRows: 50 })).json().preview;
    const b = (await call("generate_data", { schema, seed: 3, previewRows: 50 })).json().preview;
    expect(a).toEqual(b);
  });

  it("reads schemaPath from the root", async () => {
    const { call, root } = await start();
    writeFileSync(join(root, "shop.json"), JSON.stringify(schema));
    expect((await call("generate_data", { schemaPath: "shop.json" })).json().rows.orders).toBe(15);
    expect((await call("generate_data", { schemaPath: "missing.yaml" })).body).toMatch(/No such file/);
  });
});

describe("mcp file safety", () => {
  it("writes files inside the root and refuses to overwrite by default", async () => {
    const { call, root } = await start();
    const first = (await call("generate_data", { schema, outputDir: "out", format: "csv" })).json();
    expect(first.files.sort()).toEqual(["out/customers.csv", "out/orders.csv"]);
    expect(readFileSync(join(root, "out/orders.csv"), "utf8").split("\n")[0]).toBe("id,customer_id,total");

    const again = await call("generate_data", { schema, outputDir: "out", format: "csv" });
    expect(again.isError).toBe(true);
    expect(again.body).toMatch(/Refusing to overwrite existing files: out\/customers\.csv/);

    expect((await call("generate_data", { schema, outputDir: "out", format: "csv", overwrite: true })).isError).toBe(false);
  });

  it("rejects paths outside the root: .., absolute, and symlink escapes", async () => {
    const { call, root } = await start();
    const outside = tmp();
    symlinkSync(outside, join(root, "link"));
    for (const outputDir of ["../escape", "a/../../escape", "/tmp/escape", "link/sub"]) {
      const r = await call("generate_data", { schema, outputDir });
      expect(r.isError, outputDir).toBe(true);
      expect(r.body, outputDir).toMatch(/outside the server root|must be relative/);
    }
    expect(existsSync(join(outside, "sub"))).toBe(false);
    expect((await call("validate_schema", { schemaPath: "link/../../x.yaml" })).isError).toBe(true);
  });

  it("will not read .env (or other non-schema files) as a schema", async () => {
    const { call, root } = await start();
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-super-secret\n");
    writeFileSync(join(root, "notes.txt"), "hi");
    for (const schemaPath of [".env", "sub/.env.yaml", "notes.txt"]) {
      const r = await call("validate_schema", { schemaPath });
      expect(r.isError, schemaPath).toBe(true);
      expect(r.body).not.toContain("sk-super-secret");
    }
  });

  it("rejects table names that could escape as file names", async () => {
    const { call } = await start();
    const evil = { tables: { "../evil": { rows: 1, columns: { id: { type: "integer" } } } } };
    expect((await call("generate_data", { schema: evil, outputDir: "out" })).isError).toBe(true);
  });

  it("checks for conflicts before spending LLM calls", async () => {
    let calls = 0;
    const provider = { name: "fake", async complete() { calls++; return { text: "[]", usage: { inputTokens: 0, outputTokens: 0 } }; } };
    const { call, root } = await start({ llm: { provider } });
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out/t.json"), "keep");
    const withLlm = { tables: { t: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, note: { type: "string", llm: true } } } } };
    const r = await call("generate_data", { schema: withLlm, outputDir: "out" });
    expect(r.isError).toBe(true);
    expect(calls).toBe(0);
    expect(readFileSync(join(root, "out/t.json"), "utf8")).toBe("keep");
  });
});

describe("mcp with llm columns", () => {
  const withLlm = {
    seed: 1,
    tables: { t: { rows: 3, columns: { id: { type: "integer", primaryKey: true }, note: { type: "string", llm: { prompt: "a note" } } } } },
  };

  it("takes provider settings from .env in the root and reports token usage", async () => {
    const root = tmp();
    writeFileSync(join(root, ".env"), "AI_PROVIDER=ollama\nOLLAMA_MODEL=llama3\nOLLAMA_BASE_URL=http://h:11434\n");
    let url = "";
    const fetch = (async (u: string, init: RequestInit) => {
      url = u;
      const body = JSON.parse(init.body as string);
      const n = Number(/exactly (\d+) strings/.exec(body.messages[1].content)![1]);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(Array.from({ length: n }, (_, i) => `note ${i}`)) } }], usage: { prompt_tokens: 9, completion_tokens: 4 } }));
    }) as unknown as typeof globalThis.fetch;
    const { call } = await start({ root, llm: { fetch, sleep: async () => {} } });
    const r = (await call("generate_data", { schema: withLlm })).json();
    expect(url).toBe("http://h:11434/v1/chat/completions");
    expect(r.preview.t.map((x: any) => x.note)).toEqual(["note 0", "note 1", "note 2"]);
    expect(r.llm).toMatchObject({ calls: 1, inputTokens: 9, outputTokens: 4 });
    expect((await call("get_run_report")).json().llm.calls).toBe(1);
  });

  it("explains a missing provider without leaking anything", async () => {
    const root = tmp();
    const { call } = await start({ root });
    const r = await call("generate_data", { schema: withLlm });
    expect(r.isError).toBe(true);
    expect(r.body).toMatch(/AI_PROVIDER/);
  });
});

describe("mcp infer_schema", () => {
  const customersCsv = "id,name\n1,Ann\n2,Bo\n3,Cy\n";
  const ordersCsv = "id,customer_id,total\n1,1,9.5\n2,2,3\n3,1,7\n";

  function sqliteFile(root: string, name = "shop.db") {
    const file = join(root, name);
    const db = new DatabaseSync(file);
    db.exec(`
      create table customers (id integer primary key, email text not null unique);
      create table orders (id integer primary key, customer_id integer not null references customers(id));
      insert into customers values (1, 'secret-row@example.com');
    `);
    db.close();
    return file;
  }

  it("infers from a SQLite file under the root, and the result feeds straight into generate_data", async () => {
    const { call, root } = await start();
    sqliteFile(root);
    const r = (await call("infer_schema", { path: "shop.db", rows: 9 })).json();
    expect(r.tables.sort()).toEqual(["customers", "orders"]);
    expect(r.schema.tables.orders.columns.customer_id).toMatchObject({ ref: "customers.id" });
    expect(JSON.stringify(r)).not.toContain("secret-row");
    const gen = (await call("generate_data", { schema: r.schema })).json();
    expect(gen.rows).toEqual({ customers: 9, orders: 9 });
  });

  it("infers from inline OpenAPI and inline sample text", async () => {
    const { call } = await start();
    const api = JSON.stringify({ openapi: "3.0.0", components: { schemas: { Pet: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } });
    expect((await call("infer_schema", { content: api })).json().tables).toEqual(["Pet"]);
    const sample = (await call("infer_schema", { content: ordersCsv, name: "orders.csv" })).json();
    expect(sample.schema.tables.orders.columns.total).toMatchObject({ type: "float", min: 3, max: 9.5 });
    expect((await call("infer_schema", { content: '[{"a":1},{"a":2}]', kind: "sample" })).json().tables).toEqual(["data"]);
  });

  it("infers from a folder of sample files and links them", async () => {
    const { call, root } = await start();
    mkdirSync(join(root, "samples"));
    writeFileSync(join(root, "samples/customers.csv"), customersCsv);
    writeFileSync(join(root, "samples/orders.csv"), ordersCsv);
    const r = (await call("infer_schema", { path: "samples" })).json();
    expect(r.schema.tables.orders.columns.customer_id).toMatchObject({ ref: "customers.id" });
  });

  it("connectionEnv reads a database URL from the environment or .env, never from the caller", async () => {
    const root = tmp();
    const file = sqliteFile(root);
    const viaEnv = await start({ root, env: { APP_DATABASE_URL: `sqlite:${file}` } });
    expect((await viaEnv.call("infer_schema", { connectionEnv: "APP_DATABASE_URL" })).json().tables.sort()).toEqual(["customers", "orders"]);

    const root2 = tmp();
    writeFileSync(join(root2, ".env"), `MY_DB_URL=sqlite:${sqliteFile(root2)}\n`);
    const viaDotenv = await start({ root: root2, env: {} });
    expect((await viaDotenv.call("infer_schema", { connectionEnv: "MY_DB_URL" })).isError).toBe(false);

    const missing = await viaDotenv.call("infer_schema", { connectionEnv: "OTHER_DB_URL" });
    expect(missing.isError).toBe(true);
    expect(missing.body).toMatch(/OTHER_DB_URL is not set/);
  });

  it("refuses connectionEnv names that are not database config, and never echoes values", async () => {
    const { call } = await start({ env: { ANTHROPIC_API_KEY: "sk-super-secret", DB_NOTES: "sk-also-secret", APP_DATABASE_URL: "https://example.com/not-a-db" } });
    const key = await call("infer_schema", { connectionEnv: "ANTHROPIC_API_KEY" });
    expect(key.isError).toBe(true);
    expect(key.body).not.toContain("sk-super-secret");
    const notUrl = await call("infer_schema", { connectionEnv: "DB_NOTES" });
    expect(notUrl.body).toMatch(/does not hold a supported database URL/);
    expect(notUrl.body).not.toContain("sk-also-secret");
    expect((await call("infer_schema", { connectionEnv: "APP_DATABASE_URL" })).body).not.toContain("example.com");
    expect((await call("infer_schema", { connectionEnv: "postgres://u:pw@h/db" })).isError).toBe(true);
  });

  it("does not leak a database password from a failing connection", async () => {
    const { call } = await start({ env: { APP_DATABASE_URL: "postgres://alice:s3cret@127.0.0.1:1/db" } });
    const r = await call("infer_schema", { connectionEnv: "APP_DATABASE_URL" });
    expect(r.isError).toBe(true);
    expect(r.body).not.toContain("s3cret");
  });

  it("keeps path access inside the root and away from .env", async () => {
    const { call, root } = await start();
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-super-secret\n");
    const outside = tmp();
    writeFileSync(join(outside, "leak.csv"), "id\n1\n");
    symlinkSync(outside, join(root, "link"));
    for (const path of ["../leak.csv", "/etc/hosts", "link/leak.csv", ".env", "sub/.env"]) {
      const r = await call("infer_schema", { path });
      expect(r.isError, path).toBe(true);
      expect(r.body, path).not.toContain("sk-super-secret");
    }
    expect((await call("infer_schema", { path: "missing.csv" })).body).toMatch(/No such file/);
  });

  it("requires exactly one source and rejects oversized inline content", async () => {
    const { call } = await start();
    expect((await call("infer_schema", {})).body).toMatch(/exactly one of/);
    expect((await call("infer_schema", { path: "a.csv", content: "x" })).body).toMatch(/exactly one of/);
    expect((await call("infer_schema", { content: "a\n" + "x".repeat(6 * 1024 * 1024), name: "big.csv" })).body).toMatch(/larger than 5 MB/);
  });
});
