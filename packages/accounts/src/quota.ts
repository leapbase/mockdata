import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AccountsDb } from "./db.js";

/** Thrown when a user's limit is reached; the message is safe to show to that user. */
export class QuotaError extends Error {}

export interface Limits {
  /** LLM-written cells one user may request per UTC day. */
  llmDailyRows: number;
  /** Generations running at once across all users. */
  maxRuns: number;
  /** Bytes a user's private folder may hold. */
  userQuotaBytes: number;
  /** Rows one run may build. */
  maxRows: number;
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
}

export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  return {
    llmDailyRows: positiveInt(env, "MOCKDATA_LLM_DAILY_ROWS", 2000),
    maxRuns: positiveInt(env, "MOCKDATA_MAX_RUNS", 4),
    userQuotaBytes: positiveInt(env, "MOCKDATA_USER_QUOTA_MB", 50) * 1024 * 1024,
    maxRows: positiveInt(env, "MOCKDATA_MAX_ROWS", 200_000),
  };
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** LLM cells requested per user per UTC day. */
export class UsageStore {
  constructor(
    private readonly accounts: AccountsDb,
    private readonly opts: { today?: () => string } = {},
  ) {}
  private day(): string {
    return this.opts.today?.() ?? utcDay();
  }

  llmRowsToday(userId: number): Promise<number> {
    return this.accounts.gated(() => {
      const r = this.accounts.raw.prepare("select llm_rows from usage where user_id = ? and day = ?").get(userId, this.day()) as { llm_rows: number } | undefined;
      return r?.llm_rows ?? 0;
    });
  }

  addLlmRows(userId: number, rows: number): Promise<void> {
    return this.accounts.gated(() => {
      this.accounts.raw
        .prepare("insert into usage (user_id, day, llm_rows) values (?, ?, ?) on conflict (user_id, day) do update set llm_rows = llm_rows + excluded.llm_rows")
        .run(userId, this.day(), rows);
    });
  }
}

/** At most one run per user and `maxRuns` overall; `tryStart` returns a release function, or undefined when full. */
export class RunGate {
  private readonly users = new Set<number>();
  constructor(private readonly maxRuns: number) {}

  tryStart(userId: number): (() => void) | undefined {
    if (this.users.has(userId) || this.users.size >= this.maxRuns) return undefined;
    this.users.add(userId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users.delete(userId);
    };
  }
}

/** Total bytes of regular files under `root`, never following symlinks. */
export function directoryBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) total += stat.size;
    }
  };
  walk(root);
  return total;
}

export function assertWithinDiskQuota(root: string, incomingBytes: number, quotaBytes: number): void {
  if (directoryBytes(root) + incomingBytes > quotaBytes) {
    throw new QuotaError(`Your storage limit of ${Math.round(quotaBytes / 1024 / 1024)} MB would be exceeded; delete some files first`);
  }
}
