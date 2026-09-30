import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { localRequestProblem } from "@mockdata/cli";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ServerOptions } from "./server.js";

export interface McpHttpOptions extends ServerOptions {
  /** Default 4748. 0 picks a free port (tests). */
  port?: number;
  /** Open sessions allowed at once (default 20); each holds a server in memory. */
  maxSessions?: number;
  /** Close a session after this many ms without a request (default 30 minutes). */
  sessionIdleMs?: number;
}

const MAX_BODY = 10 * 1024 * 1024;
const MCP_PATH = "/mcp";

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  // JSON-RPC shaped so MCP clients can read the reason.
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * MCP over Streamable HTTP at /mcp, for clients that connect to a URL instead
 * of spawning a process. Same tools and file confinement as stdio. Listens on
 * 127.0.0.1 only and refuses foreign Host/Origin headers: the tools read and
 * write files and can spend LLM credits, so it is not for exposing to a network.
 * Each client session gets its own server, so `get_run_report` is per client.
 */
export async function startMcpHttp(opts: McpHttpOptions = {}): Promise<{ server: http.Server; url: string }> {
  const maxSessions = opts.maxSessions ?? 20;
  const sessionIdleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const lastUsed = new Map<string, number>();
  const sweep = setInterval(() => {
    for (const [id, t] of sessions) {
      if (Date.now() - (lastUsed.get(id) ?? 0) > sessionIdleMs) void t.close();
    }
  }, Math.min(60_000, Math.max(10, sessionIdleMs / 2)));
  sweep.unref();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const problem = localRequestProblem(req.headers.host, req.headers.origin);
    if (problem) return reply(res, 403, problem);
    if (new URL(req.url ?? "/", "http://localhost").pathname !== MCP_PATH) return reply(res, 404, `Not found: MCP is served at ${MCP_PATH}`);

    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && existing) lastUsed.set(sessionId, Date.now());

    if (req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return reply(res, 415, "Send JSON with Content-Type: application/json");
      const text = await readBody(req);
      if (text === undefined) return reply(res, 413, "Request body is too large");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return reply(res, 400, "Body is not valid JSON");
      }
      if (existing) return existing.handleRequest(req, res, body);
      if (sessionId) return reply(res, 404, "Unknown session; initialize again");
      if (!isInitializeRequest(body)) return reply(res, 400, "Send an initialize request first (no Mcp-Session-Id)");
      if (sessions.size >= maxSessions) return reply(res, 503, `Too many open sessions (max ${maxSessions})`);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          lastUsed.set(id, Date.now());
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          lastUsed.delete(transport.sessionId);
        }
      };
      await createServer(opts).connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId) return reply(res, 400, "Missing Mcp-Session-Id header");
      if (!existing) return reply(res, 404, "Unknown session; initialize again");
      return existing.handleRequest(req, res);
    }
    res.setHeader("allow", "GET, POST, DELETE");
    return reply(res, 405, "Method not allowed");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => reply(res, 500, (e as Error).message));
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.on("close", () => clearInterval(sweep));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4748, "127.0.0.1", () => resolve());
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
