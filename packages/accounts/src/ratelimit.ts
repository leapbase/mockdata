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
    for (const { key } of entries) {
      if (this.hits.size <= this.maxKeys) return;
      this.hits.delete(key);
    }
  }
}
