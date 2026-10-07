export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
  /** Forget the oldest keys past this many (default 10000) so unique keys cannot exhaust memory. */
  maxKeys?: number;
}

/** In-memory sliding-window limiter, per process: counts reset when the server restarts. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxKeys: number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
  private recent(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Count one event; false when this key is over the limit (and the event is not counted). */
  hit(key: string): boolean {
    const list = this.recent(key);
    if (list.length >= this.opts.max) return false;
    this.record(key);
    return true;
  }

  /** Count an event unconditionally (for failures). */
  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    this.trim();
  }

  isLimited(key: string): boolean {
    return this.recent(key).length >= this.opts.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  retryAfterSeconds(key: string): number {
    const list = this.recent(key);
    if (list.length < this.opts.max) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.opts.windowMs - this.now()) / 1000));
  }

  size(): number {
    return this.hits.size;
  }

  /**
   * Stay under maxKeys without letting a flood of throw-away keys lift anyone's lockout: expired keys go first,
   * then keys that are not over the limit (quietest first), and a limited key only as a last resort.
   */
  private trim(): void {
    if (this.hits.size <= this.maxKeys) return;
    for (const key of [...this.hits.keys()]) this.recent(key); // drops keys whose events have all expired
    if (this.hits.size <= this.maxKeys) return;
    const entries = [...this.hits].map(([key, list]) => ({ key, limited: list.length >= this.opts.max, last: list[list.length - 1] ?? 0 }));
    entries.sort((a, b) => Number(a.limited) - Number(b.limited) || a.last - b.last);
    // Make room in bulk (down to 90%), so a stream of new keys pays for one sort per maxKeys/10 hits, not one per hit.
    const target = Math.floor(this.maxKeys * 0.9);
    for (const { key } of entries) {
      if (this.hits.size <= target) return;
      this.hits.delete(key);
    }
  }
}

/**
 * A rate limit as the server uses it. In memory for one server (`memoryLimiter`); in the account database when several
 * servers share it (`SqlRateLimiter`). Every call must be awaited: a forgotten `await` would test a Promise, which is
 * always truthy, and quietly turn the limit off (server/test/limiter-await.test.ts checks every call site).
 */
export interface Limiter {
  /** Count one event; false when this key is over the limit (and the event is not counted). */
  hit(key: string): Promise<boolean>;
  /** Count an event unconditionally (for failures). */
  record(key: string): Promise<void>;
  isLimited(key: string): Promise<boolean>;
  reset(key: string): Promise<void>;
  retryAfterSeconds(key: string): Promise<number>;
}

/** The in-memory RateLimiter behind the async interface: this server only, reset on restart. */
export function memoryLimiter(opts: RateLimiterOptions): Limiter {
  const r = new RateLimiter(opts);
  return {
    hit: async (key) => r.hit(key),
    record: async (key) => r.record(key),
    isLimited: async (key) => r.isLimited(key),
    reset: async (key) => r.reset(key),
    retryAfterSeconds: async (key) => r.retryAfterSeconds(key),
  };
}
