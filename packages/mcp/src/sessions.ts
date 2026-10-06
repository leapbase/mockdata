import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const MCP_PATH = "/mcp";
const DEFAULT_BODY = 10 * 1024 * 1024;

export function mcpReply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  // JSON-RPC shaped so MCP clients can read the reason.
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  if (Number(req.headers["content-length"]) > max) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface McpSessionsOptions {
  /** Open sessions allowed at once (default 20); each holds a server in memory. */
  maxSessions?: number;
  /** Open sessions one owner may hold (default: no separate limit). */
  maxPerOwner?: number;
  /** Close a session after this many ms without a request (default 30 minutes). */
  sessionIdleMs?: number;
  /** Largest request body in bytes (default 10 MB). */
  maxBody?: number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  owner: string;
  lastUsed: number;
}

/**
 * Streamable HTTP sessions: one MCP server per client session, so `get_run_report` is per client. A session belongs
 * to whoever opened it; a request for it from anyone else is answered as if it did not exist.
 */
export class McpSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly sweep: NodeJS.Timeout;
  private readonly maxSessions: number;
  private readonly maxPerOwner: number;
  private readonly idleMs: number;
  private readonly maxBody: number;

  constructor(opts: McpSessionsOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 20;
    this.maxPerOwner = opts.maxPerOwner ?? Infinity;
    this.idleMs = opts.sessionIdleMs ?? 30 * 60_000;
    this.maxBody = opts.maxBody ?? DEFAULT_BODY;
    this.sweep = setInterval(() => {
      for (const s of this.sessions.values()) if (Date.now() - s.lastUsed > this.idleMs) void s.transport.close();
    }, Math.min(60_000, Math.max(10, this.idleMs / 2)));
    this.sweep.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Answer one request at /mcp. `create` makes the server for a new session; `owner` names who is calling. */
  async handle(req: IncomingMessage, res: ServerResponse, owner: string, create: () => McpServer): Promise<void> {
    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const found = sessionId ? this.sessions.get(sessionId) : undefined;
    const existing = found && found.owner === owner ? found : undefined;
    if (existing) existing.lastUsed = Date.now();

    if (req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return mcpReply(res, 415, "Send JSON with Content-Type: application/json");
      const text = await readBody(req, this.maxBody);
      if (text === undefined) return mcpReply(res, 413, "Request body is too large");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return mcpReply(res, 400, "Body is not valid JSON");
      }
      if (existing) return existing.transport.handleRequest(req, res, body);
      if (sessionId) return mcpReply(res, 404, "Unknown session; initialize again");
      if (!isInitializeRequest(body)) return mcpReply(res, 400, "Send an initialize request first (no Mcp-Session-Id)");
      if (this.sessions.size >= this.maxSessions) return mcpReply(res, 503, `Too many open sessions (max ${this.maxSessions})`);
      if (this.countFor(owner) >= this.maxPerOwner) return mcpReply(res, 429, `Too many open sessions for you (max ${this.maxPerOwner}); close one or wait for it to expire`);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          this.sessions.set(id, { transport, owner, lastUsed: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await create().connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId) return mcpReply(res, 400, "Missing Mcp-Session-Id header");
      if (!existing) return mcpReply(res, 404, "Unknown session; initialize again");
      return existing.transport.handleRequest(req, res);
    }
    res.setHeader("allow", "GET, POST, DELETE");
    return mcpReply(res, 405, "Method not allowed");
  }

  private countFor(owner: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.owner === owner) n++;
    return n;
  }

  /** Close every session (their servers stop) and stop the idle sweep. */
  async close(): Promise<void> {
    clearInterval(this.sweep);
    await Promise.all([...this.sessions.values()].map((s) => s.transport.close()));
  }
}
