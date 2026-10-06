import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootAccounts, SHOP_YAML } from "./helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type Booted = Awaited<ReturnType<typeof bootAccounts>>;

/** Sign up and make an API key: the key, the cookie, and the user's private folder. */
async function keyFor(app: Booted, email: string) {
  const cookie = await app.signUp(email);
  const made = await app.as(cookie).post("/api/auth/keys", { name: "laptop" });
  expect(made.status).toBe(201);
  const key = made.json.key as string;
  const user = (await app.accounts.apiKeys.lookup(key))!;
  return { key, cookie, root: app.accounts.userRoot(user) };
}

async function connect(app: Booted, key: string) {
  const c = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
  await c.connect(transport);
  closers.push(() => c.close());
  return { client: c, sessionId: transport.sessionId! };
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

function mcpPost(app: Booted, headers: Record<string, string>, body: unknown = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }) {
  return fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("API keys", () => {
  it("are made, listed without the secret, and revoked by their owner only", async () => {
    const app = await bootAccounts();
    const ann = await keyFor(app, "ann@example.com");
    const bob = await app.signUp("bob@example.com");
    const list = await app.as(ann.cookie).get("/api/auth/keys");
    expect(list.json.keys).toEqual([{ id: expect.any(Number), name: "laptop", prefix: ann.key.slice(0, 10), createdAt: expect.any(Number), lastUsedAt: expect.any(Number) }]);
    expect(list.raw).not.toContain(ann.key);
    const id = list.json.keys[0].id;
    expect((await app.as(bob).post("/api/auth/keys/revoke", { id })).status).toBe(404);
    expect((await app.as(ann.cookie).post("/api/auth/keys/revoke", { id })).status).toBe(200);
    expect((await mcpPost(app, { authorization: `Bearer ${ann.key}` })).status).toBe(401);
  });

  it("need a signed-in user", async () => {
    const app = await bootAccounts();
    expect((await app.get("/api/auth/keys")).status).toBe(401);
    expect((await app.post("/api/auth/keys", { name: "x" })).status).toBe(401);
  });

  it("stop working when the password is reset", async () => {
    const app = await bootAccounts();
    const ann = await keyFor(app, "ann@example.com");
    await app.post("/api/auth/forgot-password", { email: "ann@example.com" });
    await new Promise((r) => setTimeout(r, 20)); // mail is queued after the response
    const reset = await app.post("/api/auth/reset-password", { token: app.tokenOf(app.sent.at(-1)!, "reset_token"), password: "An0ther$ecretPassw0rd" });
    expect(reset.status).toBe(200);
    expect(await app.accounts.apiKeys.lookup(ann.key)).toBeNull();
  });
});

describe("hosted MCP at /mcp", () => {
  it("asks for an API key, and does not accept the session cookie instead", async () => {
    const app = await bootAccounts();
    const ann = await keyFor(app, "ann@example.com");
    const none = await mcpPost(app, {});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await none.json()).error.message).toMatch(/API key/);
    expect((await mcpPost(app, { cookie: ann.cookie })).status).toBe(401);
    expect((await mcpPost(app, { authorization: "Bearer md_" + "x".repeat(43) })).status).toBe(401);
  });

  it("slows down an address sending wrong keys", async () => {
    const app = await bootAccounts();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await mcpPost(app, { authorization: `Bearer md_${String(i).padStart(43, "0")}` })).status;
    expect(last).toBe(429);
  });

  it("runs the tools in the user's own folder, with the operator's settings", async () => {
    const app = await bootAccounts();
    const ann = await keyFor(app, "ann@example.com");
    writeFileSync(join(ann.root, "shop.yaml"), SHOP_YAML);
    const { client } = await connect(app, ann.key);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["describe_schema_format", "validate_schema", "infer_schema", "generate_data", "get_run_report"]));

    const checked = await client.callTool({ name: "validate_schema", arguments: { schemaPath: "shop.yaml" } });
    expect(JSON.parse(textOf(checked)).ok).toBe(true);

    const run = await client.callTool({ name: "generate_data", arguments: { schemaPath: "shop.yaml", previewRows: 2, outputDir: "out", format: "csv" } });
    expect(run.isError).toBeFalsy();
    const result = JSON.parse(textOf(run));
    expect(result.files).toEqual(expect.arrayContaining(["out/customers.csv", "out/orders.csv"]));
    expect(result.preview.customers).toHaveLength(2);
    expect(readFileSync(join(ann.root, "out", "customers.csv"), "utf8").split("\n")[0]).toContain("id");
    expect(existsSync(join(app.configRoot, "out"))).toBe(false);

    const report = await client.callTool({ name: "get_run_report", arguments: {} });
    expect(JSON.parse(textOf(report)).rows.customers).toBeGreaterThan(0);
  });

  it("keeps users apart: no reading another user's files, no using their session", async () => {
    const app = await bootAccounts();
    const ann = await keyFor(app, "ann@example.com");
    const bob = await keyFor(app, "bob@example.com");
    writeFileSync(join(ann.root, "private.yaml"), SHOP_YAML);
    const { client: bobClient } = await connect(app, bob.key);
    const read = await bobClient.callTool({ name: "validate_schema", arguments: { schemaPath: "private.yaml" } });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toMatch(/No such file/);

    const { sessionId } = await connect(app, ann.key);
    const hijack = await mcpPost(app, { authorization: `Bearer ${bob.key}`, "mcp-session-id": sessionId }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(hijack.status).toBe(404);
  });

  it("applies the account limits: row cap, no database inference, storage quota", async () => {
    const app = await bootAccounts({ limits: { maxRows: 50, userQuotaBytes: 2_000 }, env: { DATABASE_URL: "sqlite:/tmp/x.db" } });
    const ann = await keyFor(app, "ann@example.com");
    const { client } = await connect(app, ann.key);

    const big = await client.callTool({ name: "generate_data", arguments: { schema: SHOP_YAML.replace(/rows: \d+/g, "rows: 40") } });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toMatch(/limit/i);

    const db = await client.callTool({ name: "infer_schema", arguments: { connectionEnv: "DATABASE_URL" } });
    expect(db.isError).toBe(true);
    expect(textOf(db)).toMatch(/not available on this server/);
    expect(textOf(db)).not.toContain("/tmp/x.db");

    const many = SHOP_YAML.replace(/rows: \d+/g, "rows: 25");
    const files = await client.callTool({ name: "generate_data", arguments: { schema: many, outputDir: "out", format: "json" } });
    expect(files.isError).toBe(true);
    expect(textOf(files)).toMatch(/storage|quota|space/i);
    expect(existsSync(join(ann.root, "out", "customers.json"))).toBe(false);
  });

  it("never shows a hosted caller a raw file system error or a server path", async () => {
    const app = await bootAccounts();
    const ann = await keyFor(app, "ann@example.com");
    mkdirSync(join(ann.root, "out", "customers.csv"), { recursive: true }); // a folder where a file must be written
    const { client } = await connect(app, ann.key);
    const r = await client.callTool({ name: "generate_data", arguments: { schema: SHOP_YAML, outputDir: "out", format: "csv", overwrite: true } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain(app.dataDir);
    expect(textOf(r)).not.toMatch(/EISDIR|ENOTDIR|\/users\//);
    expect(textOf(r)).toMatch(/Something went wrong/);
  });

  it("caps open sessions per user", async () => {
    const app = await bootAccounts();
    const ann = await keyFor(app, "ann@example.com");
    for (let i = 0; i < 5; i++) await connect(app, ann.key);
    const sixth = await mcpPost(app, { authorization: `Bearer ${ann.key}` });
    expect(sixth.status).toBe(429);
  });
});
