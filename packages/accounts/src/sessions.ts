import { createHash, randomBytes } from "node:crypto";
import type { AccountsDb } from "./db.js";
import { rowToUser, sessionKey, type AccountUser, type UserRow } from "./sqlAdapter.js";

/**
 * Over https the `__Host-` prefix makes browsers refuse a cookie that is not Secure, scoped to "/" and set by this
 * exact host, so a sibling subdomain cannot plant a session or OAuth nonce here.
 */
export const sessionCookieName = (secure: boolean): string => (secure ? "__Host-mockdata_session" : "mockdata_session");
export const oauthCookieName = (secure: boolean): string => (secure ? "__Host-mockdata_oauth" : "mockdata_oauth");
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** No session lives longer than this, however often it is used. */
export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_SLIDE_AFTER_SECONDS = 60 * 60;

interface Clock {
  now?: () => number;
}
const epoch = (c: Clock): number => c.now?.() ?? Math.floor(Date.now() / 1000);

/**
 * Server-side sessions. The cookie carries a random 256-bit id; only its SHA-256
 * is stored, so a copy of the database cannot be replayed as cookies.
 */
export class SessionStore {
  private readonly ttl: number;
  private readonly slideAfter: number;
  private readonly absolute: number;
  constructor(
    private readonly accounts: AccountsDb,
    private readonly opts: Clock & { ttlSeconds?: number; slideAfterSeconds?: number; absoluteSeconds?: number } = {},
  ) {
    this.ttl = opts.ttlSeconds ?? SESSION_TTL_SECONDS;
    this.slideAfter = opts.slideAfterSeconds ?? DEFAULT_SLIDE_AFTER_SECONDS;
    this.absolute = opts.absoluteSeconds ?? SESSION_MAX_AGE_SECONDS;
  }

  create(userId: number): Promise<{ id: string; expiresAt: number }> {
    const id = randomBytes(32).toString("base64url");
    const now = epoch(this.opts);
    const expiresAt = now + this.ttl;
    return this.accounts
      .run("insert into sessions (id_hash, user_id, created_at, expires_at, last_seen_at) values (?, ?, ?, ?, ?)", [sessionKey(id), userId, now, expiresAt, now])
      .then(() => ({ id, expiresAt }));
  }

  /** The user for a session id, or null if unknown or expired. Slides the expiry forward at most once per `slideAfterSeconds` (default an hour). */
  async lookup(rawId: string | undefined): Promise<AccountUser | null> {
    if (!rawId) return null;
    const now = epoch(this.opts);
    const key = sessionKey(rawId);
    const r = await this.accounts.one<UserRow & { last_seen_at: number }>(
      "select u.*, s.last_seen_at from sessions s join users u on u.id = s.user_id where s.id_hash = ? and s.expires_at > ? and s.created_at > ?",
      [key, now, now - this.absolute],
    );
    if (!r) return null;
    // Two requests may both slide the same session; the later write wins, which is harmless.
    if (now - r.last_seen_at >= this.slideAfter) await this.accounts.run("update sessions set last_seen_at = ?, expires_at = ? where id_hash = ?", [now, now + this.ttl, key]);
    return rowToUser(r);
  }

  destroy(rawId: string | undefined): Promise<void> {
    if (!rawId) return Promise.resolve();
    return this.accounts.run("delete from sessions where id_hash = ?", [sessionKey(rawId)]).then(() => undefined);
  }

  /** Delete expired sessions; returns how many. */
  purgeExpired(): Promise<number> {
    const now = epoch(this.opts);
    return this.accounts.run("delete from sessions where expires_at <= ? or created_at <= ?", [now, now - this.absolute]);
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * One-time OAuth `state` values. A state is only good with the nonce that was
 * put in the browser's own cookie, so a callback replayed from another browser
 * (login CSRF) is refused.
 */
export class OAuthStates {
  private readonly ttl: number;
  constructor(
    private readonly accounts: AccountsDb,
    private readonly opts: Clock & { ttlSeconds?: number } = {},
  ) {
    this.ttl = opts.ttlSeconds ?? 600;
  }

  create(codeVerifier: string): Promise<{ state: string; nonce: string }> {
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const now = epoch(this.opts);
    const expires = now + this.ttl;
    return this.accounts.transaction(async (tx) => {
      await tx.run("delete from oauth_states where expires_at <= ?", [now]); // the start route is unauthenticated: keep the table from growing
      await tx.run("insert into oauth_states (state_hash, nonce_hash, code_verifier, expires_at) values (?, ?, ?, ?)", [sha256(state), sha256(nonce), codeVerifier, expires]);
      return { state, nonce };
    });
  }

  /** The PKCE verifier for this state, consuming it. A wrong nonce, an expired or an unknown state returns null. */
  async consume(state: string, nonce: string): Promise<string | null> {
    const now = epoch(this.opts);
    await this.accounts.run("delete from oauth_states where expires_at <= ?", [now]);
    // Deleting and returning in one statement: two callbacks with the same state cannot both get the verifier.
    const r = await this.accounts.one<{ code_verifier: string }>("delete from oauth_states where state_hash = ? and nonce_hash = ? and expires_at > ? returning code_verifier", [
      sha256(state),
      sha256(nonce),
      now,
    ]);
    return r ? r.code_verifier : null;
  }
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of ([header].flat()[0] ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the raw value */
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

const COOKIE_NAME = /^[A-Za-z0-9_-]+$/;

export function serializeCookie(name: string, value: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  if (!COOKIE_NAME.test(name)) throw new Error("Invalid cookie name");
  const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${opts.maxAgeSeconds}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0, secure });
}
