import { parseCookies, sessionCookieName } from "@mockdata/accounts";
import { HttpError, type Ctx } from "../http.js";
import type { HostedPlugin } from "../hosted.js";
import { AUTH_ROUTES } from "../routes/auth.js";
import { createHostedMcp } from "./mcp.js";
import { accountPolicy } from "./policy.js";
import type { AccountsRuntime } from "./runtime.js";

/** Most a signed-in user may send in one request (the saved-file limit is 1 MB; a run carries the schema text). */
const ACCOUNT_BODY_MAX = 2 * 1024 * 1024;

/** The accounts layer as a `HostedPlugin`: sessions, `/api/auth/*`, API-key MCP, per-user folders and limits. */
export function createAccountsPlugin(accounts: AccountsRuntime): HostedPlugin {
  const cookieName = sessionCookieName(accounts.config.publicUrl.secure);
  const sessionOf = (cookie: string | undefined) => parseCookies(cookie)[cookieName];
  return {
    publicUrl: accounts.config.publicUrl,
    bodyMax: ACCOUNT_BODY_MAX,
    responseHeaders() {
      return {
        // A certificate is someone else's job (the reverse proxy), but once people sign in over https the browser should insist on it.
        ...(accounts.config.publicUrl.secure ? { "strict-transport-security": "max-age=31536000" } : {}),
        // Emailed links and OAuth returns carry one-time values: never let a page we serve pass them on in a Referer.
        "referrer-policy": "no-referrer",
      };
    },
    mcp: (base) => createHostedMcp(base, accounts),
    async handleApi(req, res, url) {
      if (!url.pathname.startsWith("/api/auth/")) return false;
      const route = AUTH_ROUTES[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "No such API route");
      const sessionId = sessionOf(req.headers.cookie);
      const user = await accounts.sessions.lookup(sessionId);
      await route(accounts, { user, sessionId: user ? sessionId : undefined }, req, res, url);
      return true;
    },
    async contextFor(base: Ctx, req) {
      // A session is required for everything, even from localhost (a reverse proxy connects from there).
      const user = await accounts.sessions.lookup(sessionOf(req.headers.cookie));
      if (!user) throw new HttpError(401, "Sign in required");
      return { ...base, root: accounts.userRoot(user), policy: accountPolicy(accounts, user) };
    },
  };
}
