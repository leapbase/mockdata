import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, needsToken, peerAllowed, presentedToken, TOKEN_COOKIE, tokensEqual, type NetworkAccess } from "@mockdata/cli";
import { assertLocal, HttpError, sendJson, setBodyLimit, type Ctx, type Handler } from "./http.js";
import { publicMessage, statusFor } from "./errors.js";
import { serveStatic } from "./static.js";
import type { HostedPlugin } from "./hosted.js";
import { InlineRunner } from "./workers/inline.js";
import type { Runner } from "./workers/runner.js";
import { meWithoutAccounts } from "./routes/me.js";
import { getConfig } from "./routes/config.js";
import { listFiles, readFile, renameFile, writeFile } from "./routes/files.js";
import { exportRoute } from "./routes/export.js";
import { inferRoute } from "./routes/infer.js";
import { generateRoute, streamRoute, validateRoute } from "./routes/run.js";

export interface AppOptions {
  /** Directory schemas live in and all paths are confined to; .env is read from here. Default: cwd. */
  root?: string;
  /** Environment (default process.env); .env under root is merged beneath it. */
  env?: Record<string, string | undefined>;
  /** Test hooks for the LLM layer. */
  llm?: Ctx["llm"];
  /** Set when listening beyond localhost (see startServer): who may reach the server. */
  access?: NetworkAccess;
  /** Where heavy jobs run. Default: the calling thread for now (a worker pool replaces this). */
  runner?: Runner;
  /** Hosted mode (see HostedPlugin): every API call is authenticated by the plugin and runs in the caller's own folder. */
  hosted?: HostedPlugin;
  /** Built web app (default: packages/web/dist next to this package). */
  staticDir?: string;
}

const ROUTES: Record<string, Handler> = {
  "GET /api/config": getConfig,
  "GET /api/files": listFiles,
  "GET /api/file": readFile,
  "PUT /api/file": writeFile,
  "POST /api/file/rename": renameFile,
  "POST /api/validate": validateRoute,
  "POST /api/generate": generateRoute,
  "POST /api/generate/stream": streamRoute,
  "POST /api/infer": inferRoute,
  "POST /api/export": exportRoute,
  "GET /api/auth/me": (_ctx, _req, res) => Promise.resolve(meWithoutAccounts(res)),
};

function sendError(res: ServerResponse, e: unknown, hideInternals: boolean): void {
  const err = e as Error;
  if (res.headersSent) {
    res.end();
    return;
  }
  // Error messages in this codebase name variables, never values.
  const status = statusFor(e);
  sendJson(res, status, { error: { name: hideInternals && status >= 500 ? "Error" : err.name, message: publicMessage(e, hideInternals), ...(e instanceof HttpError && e.code ? { code: e.code } : {}) } });
}

export function createApp(opts: AppOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(opts.root ?? process.cwd());
  const baseEnv = opts.env ?? process.env;
  const staticDir = opts.staticDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const ctx: Ctx = { root, env: () => loadEnv(root, baseEnv), llm: opts.llm ?? {}, runner: opts.runner ?? new InlineRunner(opts.llm) };
  // A hosted layer may also serve MCP at /mcp for its own callers.
  const hosted = opts.hosted;
  const mcp = hosted?.mcp(ctx);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    assertLocal(req, opts.access);
    if (!peerAllowed(opts.access, req.socket.remoteAddress)) throw new HttpError(403, "Address not allowed");
    if (hosted) for (const [name, value] of Object.entries(hosted.responseHeaders())) res.setHeader(name, value);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (needsToken(opts.access, req.socket.remoteAddress) && !tokensEqual(presentedToken(req.headers), opts.access!.token)) {
      // A browser arrives once with ?token=: trade it for a cookie and a URL that no longer carries it.
      if (req.method === "GET" && !url.pathname.startsWith("/api/") && tokensEqual(url.searchParams.get("token") ?? undefined, opts.access!.token)) {
        url.searchParams.delete("token");
        res.writeHead(302, {
          location: url.pathname + url.search,
          "set-cookie": `${TOKEN_COOKIE}=${opts.access!.token}; HttpOnly; SameSite=Strict; Path=/`,
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
        });
        res.end();
        return;
      }
      res.setHeader("www-authenticate", 'Bearer realm="mockdata"');
      throw new HttpError(401, "A token is required: send Authorization: Bearer <token>, or open the UI once with ?token=<token>");
    }
    // For uptime monitors and reverse proxies: says only that the process answers, after the same host and token checks as everything else.
    if (url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.setHeader("cache-control", "no-store");
      return sendJson(res, 200, { ok: true });
    }
    if (mcp && url.pathname === "/mcp") return mcp.handle(req, res);
    if (hosted && url.pathname.startsWith("/api/")) {
      if (Number(req.headers["content-length"]) > hosted.bodyMax) throw new HttpError(413, "Request body is too large"); // refused before it is read
      setBodyLimit(req, hosted.bodyMax); // and capped while it is read, for a body with no Content-Length
      if (await hosted.handleApi(req, res, url)) return;
    }
    if (url.pathname.startsWith("/api/")) {
      const route = ROUTES[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "No such API route");
      // Hosted: the plugin names the caller (a session is required for everything, even from localhost, since a reverse proxy connects from there).
      return route(hosted ? await hosted.contextFor(ctx, req) : ctx, req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    serveStatic(staticDir, url.pathname, res);
  }

  return (req, res) => {
    handle(req, res).catch((e) => sendError(res, e, !!opts.hosted));
  };
}
