import { randomBytes } from "node:crypto";
import { hashOpaqueToken } from "@mockdata/auth-kit";
import type { AccountsDb } from "./db.js";
import { rowToUser, type AccountUser, type UserRow } from "./sqlAdapter.js";

/** Every key starts with this, so a leaked one is easy to recognise (and to search for in a repository). */
export const API_KEY_PREFIX = "md_";
export const MAX_API_KEYS_PER_USER = 10;
export const MAX_API_KEY_NAME = 64;
const SHAPE = /^md_[A-Za-z0-9_-]{43}$/;
/** How often a key's "last used" time is written (it is only shown to the owner). */
const TOUCH_AFTER_SECONDS = 5 * 60;

export interface ApiKeyInfo {
  id: number;
  name: string;
  /** The first characters of the key, enough for the owner to tell keys apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface Clock {
  now?: () => number;
}

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`You can have at most ${MAX_API_KEYS_PER_USER} API keys: revoke one first`);
  }
}

/**
 * Per-user API keys for machine clients (the hosted MCP endpoint). A key is 256 random bits, shown once when it is
 * made; only its SHA-256 is stored, so a copy of the database cannot be used to call the API.
 */
export class ApiKeyStore {
  constructor(
    private readonly accounts: AccountsDb,
    private readonly opts: Clock = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Make a key. The returned `key` is the only time the full value exists outside the caller. */
  create(userId: number, name: string): Promise<{ key: string; info: ApiKeyInfo }> {
    const label = name.trim().slice(0, MAX_API_KEY_NAME) || "API key";
    const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
    const prefix = key.slice(0, 10);
    const now = this.now();
    // Count, then insert, under a per-user lock: two requests at once cannot both take the tenth slot, on any server.
    return this.accounts.transaction(async (tx) => {
      await tx.lock(`api_keys:${userId}`);
      const { n } = (await tx.one<{ n: number }>("select count(*) as n from api_keys where user_id = ?", [userId]))!;
      if (Number(n) >= MAX_API_KEYS_PER_USER) throw new ApiKeyLimitError();
      const r = (await tx.one<{ id: number }>("insert into api_keys (user_id, name, key_hash, prefix, created_at) values (?, ?, ?, ?, ?) returning id", [userId, label, hashOpaqueToken(key), prefix, now]))!;
      return { key, info: { id: r.id, name: label, prefix, createdAt: now, lastUsedAt: null } };
    });
  }

  async list(userId: number): Promise<ApiKeyInfo[]> {
    const rows = await this.accounts.all<{ id: number; name: string; prefix: string; created_at: number; last_used_at: number | null }>(
      "select id, name, prefix, created_at, last_used_at from api_keys where user_id = ? order by id",
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  /** Delete one of the user's keys; false when it is not theirs or does not exist. */
  revoke(userId: number, id: number): Promise<boolean> {
    return this.accounts.run("delete from api_keys where id = ? and user_id = ?", [id, userId]).then((n) => n > 0);
  }

  revokeAll(userId: number): Promise<number> {
    return this.accounts.run("delete from api_keys where user_id = ?", [userId]);
  }

  /** The owner of a key, or null. Anything not shaped like a key is refused without touching the database. */
  async lookup(key: string | undefined): Promise<AccountUser | null> {
    if (!key || !SHAPE.test(key)) return null;
    const now = this.now();
    const r = await this.accounts.one<UserRow & { key_id: number; last_used_at: number | null }>(
      "select u.*, k.id as key_id, k.last_used_at from api_keys k join users u on u.id = k.user_id where k.key_hash = ?",
      [hashOpaqueToken(key)],
    );
    if (!r) return null;
    if (r.last_used_at === null || now - r.last_used_at >= TOUCH_AFTER_SECONDS) await this.accounts.run("update api_keys set last_used_at = ? where id = ?", [now, r.key_id]);
    return rowToUser(r);
  }
}
