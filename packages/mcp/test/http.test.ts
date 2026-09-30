import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttp, type McpHttpOptions } from "../src/http.js";

const SCHEMA = `seed: 7
tables:
  customers:
    rows: 4
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: string, faker: person.fullName }
`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function boot(opts: McpHttpOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mockdata-mcp-http-")));
  writeFileSync(join(root, "shop.yaml"), SCHEMA);
  const { server, url } = await startMcpHttp({ env: {}, ...opts, root, port: 0 });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  async function client() {
    const c = new Client({ name: "test", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    closers.push(() => c.close());
    return c;
  }
  return { root, url, client };
}

const text = (r: any): string => r.content[0].text;

function raw(url: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("mcp over http", () => {
  it("lists the same tools and runs them", async () => {
    const { client } = await boot();
    const c = await client();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["describe_schema_format", "generate_data", "get_run_report", "infer_schema", "validate_schema"]);
    const v = JSON.parse(text(await c.callTool({ name: "validate_schema", arguments: { schemaPath: "shop.yaml" } })));
    expect(v.ok).toBe(true);
    const g = JSON.parse(text(await c.callTool({ name: "generate_data", arguments: { schemaPath: "shop.yaml", previewRows: 2 } })));
    expect(g.rows).toEqual({ customers: 4 });
  });

  it("keeps the last-run report per session", async () => {
    const { client } = await boot();
    const a = await client();
    const b = await client();
    await a.callTool({ name: "generate_data", arguments: { schemaPath: "shop.yaml" } });
    expect(JSON.parse(text(await a.callTool({ name: "get_run_report", arguments: {} }))).rows).toEqual({ customers: 4 });
    const other = (await b.callTool({ name: "get_run_report", arguments: {} })) as any;
    expect(other.isError).toBe(true);
  });

  it("stays confined to the root exactly like stdio", async () => {
    const { client } = await boot();
    const c = await client();
    const r = (await c.callTool({ name: "validate_schema", arguments: { schemaPath: "../x.yaml" } })) as any;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/outside/);
  });

  it("rejects a foreign Host or Origin (DNS rebinding, CSRF)", async () => {
    const { url } = await boot();
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
    expect((await raw(url, "/mcp", { method: "POST", headers: { ...headers, host: "evil.example" }, body })).status).toBe(403);
    expect((await raw(url, "/mcp", { method: "POST", headers: { ...headers, origin: "http://evil.example" }, body })).status).toBe(403);
    expect((await raw(url, "/mcp", { method: "POST", headers, body })).status).toBe(200);
  });

  it("answers bad requests with clear errors, not crashes", async () => {
    const { url } = await boot();
    const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await raw(url, "/other")).status).toBe(404);
    expect((await raw(url, "/mcp", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await raw(url, "/mcp", { method: "POST", headers: json, body: "{not json" })).status).toBe(400);
    expect((await raw(url, "/mcp", { method: "GET", headers: { accept: "text/event-stream" } })).status).toBe(400);
    const notInit = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await raw(url, "/mcp", { method: "POST", headers: json, body: notInit })).status).toBe(400);
    expect((await raw(url, "/mcp", { method: "POST", headers: { ...json, "mcp-session-id": "nope" }, body: notInit })).status).toBe(404);
  });

  it("caps the number of open sessions", async () => {
    const { url, client } = await boot({ maxSessions: 1 });
    await client();
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
    const r = await raw(url, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: init });
    expect(r.status).toBe(503);
  });
});
