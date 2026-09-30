import { createHash, randomBytes } from "node:crypto";
import { clearCookie, oauthCookieName, parseCookies, serializeCookie } from "@mockdata/accounts";
import { HttpError } from "../http.js";
import type { AuthHandler } from "../routes/auth.js";
import { appendSetCookie, startSession } from "./session.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REQUEST_TIMEOUT_MS = 10_000;

const callbackUrl = (origin: string): string => `${origin}/api/auth/google/callback`;

/**
 * Step 1: send the browser to Google. The random `state` is stored hashed on the server together with a PKCE
 * verifier, and bound to this browser by a nonce in a short-lived cookie, so a return from any other browser
 * (login CSRF) is refused. Google sees only the PKCE challenge.
 */
export const googleStart: AuthHandler = async (acc, _caller, req, res) => {
  if (!acc.google) throw new HttpError(501, "Google sign-in is not configured on this server");
  const ip = acc.clientIp(req);
  if (!acc.limiters.oauthIp.hit(ip)) {
    res.setHeader("retry-after", String(Math.max(1, acc.limiters.oauthIp.retryAfterSeconds(ip))));
    throw new HttpError(429, "Too many attempts. Try again later.");
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const { state, nonce } = await acc.oauth.create(verifier);
  appendSetCookie(res, serializeCookie(oauthCookieName(acc.config.publicUrl.secure), nonce, { maxAgeSeconds: 600, secure: acc.config.publicUrl.secure }));
  const params = new URLSearchParams({
    client_id: acc.google.clientId,
    redirect_uri: callbackUrl(acc.config.publicUrl.origin),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  res.writeHead(302, { location: `${AUTH_URL}?${params}`, "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end();
};

interface GoogleProfile {
  sub: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

async function exchange(fetchFn: typeof fetch, acc: Parameters<AuthHandler>[0], code: string, verifier: string): Promise<GoogleProfile | undefined> {
  const tokenRes = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: acc.google!.clientId,
      client_secret: acc.google!.clientSecret,
      redirect_uri: callbackUrl(acc.config.publicUrl.origin),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!tokenRes.ok) return undefined;
  const accessToken = ((await tokenRes.json()) as { access_token?: unknown }).access_token;
  if (typeof accessToken !== "string" || !accessToken) return undefined;

  // The userinfo endpoint (over TLS, with the token we just received) saves verifying a signed ID token by hand.
  const infoRes = await fetchFn(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!infoRes.ok) return undefined;
  const info = (await infoRes.json()) as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown };
  // Only a verified address counts: an unverified one could belong to someone else.
  if (typeof info.sub !== "string" || !info.sub || typeof info.email !== "string" || !info.email || info.email_verified !== true) return undefined;
  const email = info.email.trim().toLowerCase();
  const name = typeof info.name === "string" && info.name.trim() ? info.name.trim() : email.split("@")[0]!;
  const picture = typeof info.picture === "string" && info.picture.startsWith("https://") && info.picture.length <= 500 ? info.picture : null;
  return { sub: info.sub, email, displayName: name.slice(0, 100), avatarUrl: picture };
}

/**
 * Step 2: Google sends the browser back with a code. The state must exist, be unexpired and match the nonce
 * cookie before anything else happens; the code is then exchanged server-side, where the client secret lives.
 * Every failure looks the same to the visitor, and nothing secret is ever put in a URL or logged.
 */
export const googleCallback: AuthHandler = async (acc, _caller, req, res, url) => {
  if (!acc.google) throw new HttpError(501, "Google sign-in is not configured on this server");
  const fail = (why: string): void => {
    process.stderr.write(`google sign-in refused (${why})\n`);
    appendSetCookie(res, clearCookie(oauthCookieName(acc.config.publicUrl.secure), acc.config.publicUrl.secure));
    res.writeHead(302, { location: "/?error=google_failed", "referrer-policy": "no-referrer", "cache-control": "no-store" });
    res.end();
  };
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const nonce = parseCookies(req.headers.cookie)[oauthCookieName(acc.config.publicUrl.secure)];
  if (url.searchParams.has("error") || !state || !code || !nonce) return fail("denied or incomplete");
  const verifier = await acc.oauth.consume(state, nonce);
  if (!verifier) return fail("state");
  let profile: GoogleProfile | undefined;
  try {
    profile = await exchange(acc.config.fetch ?? fetch, acc, code, verifier);
  } catch {
    return fail("google request failed");
  }
  if (!profile) return fail("profile");
  const input = { provider: "google", providerUserId: profile.sub, email: profile.email, displayName: profile.displayName, avatarUrl: profile.avatarUrl };
  // Two callbacks for a brand-new Google user can race to create the account; the loser just finds it on a second try.
  const user = await acc.auth.upsertOAuthUser(input).catch(() => acc.auth.upsertOAuthUser(input));
  await startSession(acc, res, user.id);
  appendSetCookie(res, clearCookie(oauthCookieName(acc.config.publicUrl.secure), acc.config.publicUrl.secure));
  res.writeHead(302, { location: "/", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end();
};
