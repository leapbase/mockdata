import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookies, sessionCookieName } from "@mockdata/accounts";
import { loadEnv, needsToken, peerAllowed, presentedToken, TOKEN_COOKIE, tokensEqual, type NetworkAccess } from "@mockdata/cli";
import { assertLocal, HttpError, sendJson, setBodyLimit, type Ctx, type Handler } from "./http.js";
import { publicMessage, statusFor } from "./errors.js";
import { serveStatic } from "./static.js";
import type { AccountsRuntime } from "./accounts/runtime.js";
import { AUTH_ROUTES, meWithoutAccounts } from "./routes/auth.js";
import { getConfig } from "./routes/config.js";
import { listFiles, readFile, writeFile } from "./routes/files.js";
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
  /** Accounts mode (see createAccounts): every API call needs a session and runs in that user's private folder. */
  accounts?: AccountsRuntime;
  /** Built web app (default: packages/web/dist next to this package). */
  staticDir?: string;
}

/** Most a signed-in user may send in one request (the saved-file limit is 1 MB; a run carries the schema text). */
const ACCOUNT_BODY_MAX = 2 * 1024 * 1024;

const ROUTES: Record<string, Handler> = {
  "GET /api/config": getConfig,
  "GET /api/files": listFiles,
  "GET /api/file": readFile,
  "PUT /api/file": writeFile,
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
  const ctx: Ctx = { root, env: () => loadEnv(root, baseEnv), llm: opts.llm ?? {} };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    assertLocal(req, opts.access);
    if (!peerAllowed(opts.access, req.socket.remoteAddress)) throw new HttpError(403, "Address not allowed");
    const accounts = opts.accounts;
    // A certificate is someone else's job (the reverse proxy), but once people sign in over https the browser should insist on it.
    if (accounts?.config.publicUrl.secure) res.setHeader("strict-transport-security", "max-age=31536000");
    // Emailed links and OAuth returns carry one-time values: never let a page we serve pass them on in a Referer.
    if (accounts) res.setHeader("referrer-policy", "no-referrer");
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
    if (accounts && url.pathname.startsWith("/api/")) {
      if (Number(req.headers["content-length"]) > ACCOUNT_BODY_MAX) throw new HttpError(413, "Request body is too large"); // refused before it is read
      setBodyLimit(req, ACCOUNT_BODY_MAX); // and capped while it is read, for a body with no Content-Length
    }
    if (accounts && url.pathname.startsWith("/api/auth/")) {
      const route = AUTH_ROUTES[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "No such API route");
      const sessionId = parseCookies(req.headers.cookie)[sessionCookieName(accounts.config.publicUrl.secure)];
      const user = await accounts.sessions.lookup(sessionId);
      await route(accounts, { user, sessionId: user ? sessionId : undefined }, req, res, url);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const route = ROUTES[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "No such API route");
      if (!accounts) return route(ctx, req, res, url);
      // Accounts mode: a session is required for everything, even from localhost (a reverse proxy connects from there).
      const user = await accounts.sessions.lookup(parseCookies(req.headers.cookie)[sessionCookieName(accounts.config.publicUrl.secure)]);
      if (!user) throw new HttpError(401, "Sign in required");
      await route({ ...ctx, root: accounts.userRoot(user), accounts, user }, req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    serveStatic(staticDir, url.pathname, res);
  }

  return (req, res) => {
    handle(req, res).catch((e) => sendError(res, e, !!opts.accounts));
  };
}
