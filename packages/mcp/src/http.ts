import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dropForeignConnections, listenPlan, localRequestProblem, needsToken, presentedToken, remoteAllowed, tokensEqual, type ListenOptions } from "@mockdata/cli";
import { createServer, type ServerOptions } from "./server.js";
import { MCP_PATH, McpSessions, mcpReply as reply } from "./sessions.js";

export interface McpHttpOptions extends ServerOptions, ListenOptions {
  /** Default 4748. 0 picks a free port (tests). */
  port?: number;
  /** Open sessions allowed at once (default 20); each holds a server in memory. */
  maxSessions?: number;
  /** Close a session after this many ms without a request (default 30 minutes). */
  sessionIdleMs?: number;
}

/**
 * MCP over Streamable HTTP at /mcp, for clients that connect to a URL instead
 * of spawning a process. Same tools and file confinement as stdio. Listens on
 * 127.0.0.1 only (or, with `allow`, also serves those private ranges) and refuses
 * foreign Host/Origin headers: the tools read and
 * write files and can spend LLM credits, so it is not for exposing to a network
 * (a hosted layer serves its own signed-in endpoint at the web server's /mcp, through HostedPlugin).
 * Each client session gets its own server, so `get_run_report` is per client.
 */
export async function startMcpHttp(opts: McpHttpOptions = {}): Promise<{ server: http.Server; url: string; token?: string; tokenGenerated: boolean }> {
  const { host, access, tokenGenerated } = listenPlan(opts);
  const sessions = new McpSessions({ maxSessions: opts.maxSessions, sessionIdleMs: opts.sessionIdleMs });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const problem = localRequestProblem(req.headers.host, req.headers.origin, access);
    if (problem) return reply(res, 403, problem);
    if (access && !remoteAllowed(req.socket.remoteAddress, access.allow)) return reply(res, 403, "Address not allowed");
    if (needsToken(access, req.socket.remoteAddress) && !tokensEqual(presentedToken(req.headers, { cookie: false }), access!.token)) {
      res.setHeader("www-authenticate", 'Bearer realm="mockdata"');
      return reply(res, 401, "A token is required: send Authorization: Bearer <token>");
    }
    if (new URL(req.url ?? "/", "http://localhost").pathname !== MCP_PATH) return reply(res, 404, `Not found: MCP is served at ${MCP_PATH}`);
    // Everyone who gets this far holds the same token, so they are one owner.
    return sessions.handle(req, res, "local", () => createServer(opts));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => reply(res, 500, (e as Error).message));
  });
  dropForeignConnections(server, access);
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.on("close", () => void sessions.close());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4748, host, () => resolve());
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: access?.token, tokenGenerated };
}
