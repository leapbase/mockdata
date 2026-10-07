import { createHash, randomBytes } from "node:crypto";
import type { AccountsDb } from "./db.js";
import type { RunSlots } from "./quota.js";
import type { Limiter, RateLimiterOptions } from "./ratelimit.js";

/** Keys are IP addresses and email addresses: only a hash of each is stored. */
const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/**
 * The same sliding window as RateLimiter, kept in the account database so every server counts against one limit.
 * Each check-then-count runs in a transaction holding a lock on that limiter and key.
 */
export class SqlRateLimiter implements Limiter {
  constructor(
    private readonly db: AccountsDb,
    private readonly name: string,
    private readonly opts: Omit<RateLimiterOptions, "maxKeys">,
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async window(q: Pick<AccountsDb, "one">, hash: string, now: number): Promise<{ n: number; first: number | null }> {
    const r = await q.one<{ n: number; first: number | null }>("select count(*) as n, min(at) as first from rate_events where limiter = ? and key_hash = ? and at > ?", [
      this.name,
      hash,
      now - this.opts.windowMs,
    ]);
    return { n: Number(r?.n ?? 0), first: r?.first === null || r?.first === undefined ? null : Number(r.first) };
  }

  hit(key: string): Promise<boolean> {
    const hash = hashKey(key);
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx.lock(`rate:${this.name}:${hash}`);
      if ((await this.window(tx, hash, now)).n >= this.opts.max) return false;
      await tx.run("insert into rate_events (limiter, key_hash, at) values (?, ?, ?)", [this.name, hash, now]);
      return true;
    });
  }

  async record(key: string): Promise<void> {
    await this.db.run("insert into rate_events (limiter, key_hash, at) values (?, ?, ?)", [this.name, hashKey(key), this.now()]);
  }

  async isLimited(key: string): Promise<boolean> {
    return (await this.window(this.db, hashKey(key), this.now())).n >= this.opts.max;
  }

  async reset(key: string): Promise<void> {
    await this.db.run("delete from rate_events where limiter = ? and key_hash = ?", [this.name, hashKey(key)]);
  }

  async retryAfterSeconds(key: string): Promise<number> {
    const now = this.now();
    const { n, first } = await this.window(this.db, hashKey(key), now);
    if (n < this.opts.max || first === null) return 0;
    return Math.max(1, Math.ceil((first + this.opts.windowMs - now) / 1000));
  }
}

/** Drop rate-limit events older than `olderThanMs` (longer than any window); returns how many. */
export function purgeRateEvents(db: AccountsDb, olderThanMs: number, now = Date.now()): Promise<number> {
  return db.run("delete from rate_events where at <= ?", [now - olderThanMs]);
}

/**
 * Run slots shared by every server: at most one run per user and `maxRuns` overall. A slot is a lease that the
 * holding server renews while the run lasts, so a server that dies mid-run frees its slots when the lease expires.
 * Each slot has its own random holder token, so a late release can never free someone else's newer slot.
 */
export class SqlRunSlots implements RunSlots {
  private readonly leaseMs: number;
  constructor(
    private readonly db: AccountsDb,
    private readonly maxRuns: number,
    private readonly opts: { leaseMs?: number; now?: () => number } = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 60_000;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async tryStart(userId: number): Promise<(() => void) | undefined> {
    const holder = randomBytes(12).toString("hex");
    const now = this.now();
    const taken = await this.db.transaction(async (tx) => {
      await tx.lock("run_slots");
      await tx.run("delete from run_slots where expires_at <= ?", [now]);
      if (await tx.one("select 1 as found from run_slots where user_id = ?", [userId])) return false;
      const { n } = (await tx.one<{ n: number }>("select count(*) as n from run_slots"))!;
      if (Number(n) >= this.maxRuns) return false;
      await tx.run("insert into run_slots (user_id, holder, expires_at) values (?, ?, ?)", [userId, holder, now + this.leaseMs]);
      return true;
    });
    if (!taken) return undefined;
    const renew = setInterval(() => {
      void this.db.run("update run_slots set expires_at = ? where user_id = ? and holder = ?", [this.now() + this.leaseMs, userId, holder]).catch(() => undefined);
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renew.unref();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearInterval(renew);
      void this.db.run("delete from run_slots where user_id = ? and holder = ?", [userId, holder]).catch(() => undefined);
    };
  }
}
