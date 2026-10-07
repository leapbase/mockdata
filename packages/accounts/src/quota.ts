import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AccountsDb } from "./db.js";

/** Thrown when a user's limit is reached; the message is safe to show to that user. */
export class QuotaError extends Error {}

export interface Limits {
  /** LLM-written cells one user may request per UTC day. */
  llmDailyRows: number;
  /** LLM-written cells all users together may request per UTC day (the operator's overall ceiling). */
  llmGlobalDailyRows: number;
  /** Generations running at once across all users. */
  maxRuns: number;
  /** Bytes a user's private folder may hold. */
  userQuotaBytes: number;
  /** Rows one run may build. */
  maxRows: number;
  /** Rows times columns, summed over tables, that one run may build. */
  maxCells: number;
  /** Files one user's folder may hold. */
  maxFiles: number;
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
    llmGlobalDailyRows: positiveInt(env, "MOCKDATA_LLM_GLOBAL_DAILY_ROWS", 20_000),
    maxRuns: positiveInt(env, "MOCKDATA_MAX_RUNS", 4),
    userQuotaBytes: positiveInt(env, "MOCKDATA_USER_QUOTA_MB", 50) * 1024 * 1024,
    maxRows: positiveInt(env, "MOCKDATA_MAX_ROWS", 200_000),
    maxCells: positiveInt(env, "MOCKDATA_MAX_CELLS", 500_000),
    maxFiles: positiveInt(env, "MOCKDATA_USER_MAX_FILES", 500),
  };
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);
const UPSERT_USAGE = "insert into usage (user_id, day, llm_rows) values (?, ?, ?) on conflict (user_id, day) do update set llm_rows = usage.llm_rows + excluded.llm_rows";

/** LLM cells requested per user per UTC day. */
export class UsageStore {
  constructor(
    private readonly accounts: AccountsDb,
    private readonly opts: { today?: () => string } = {},
  ) {}
  private day(): string {
    return this.opts.today?.() ?? utcDay();
  }

  async llmRowsToday(userId: number): Promise<number> {
    const r = await this.accounts.one<{ llm_rows: number }>("select llm_rows from usage where user_id = ? and day = ?", [userId, this.day()]);
    return Number(r?.llm_rows ?? 0);
  }

  /** LLM cells requested today by everyone. */
  async llmRowsAllUsersToday(): Promise<number> {
    const r = await this.accounts.one<{ n: number }>("select coalesce(sum(llm_rows), 0) as n from usage where day = ?", [this.day()]);
    return Number(r?.n ?? 0);
  }

  /**
   * Check the user's and the server's daily budgets and charge the rows in one transaction holding the day's usage
   * lock, so runs started at the same moment (on any server) cannot each see room that only one of them can have.
   * A refusal charges nothing.
   */
  reserveLlmRows(userId: number, rows: number, userLimit: number, serverLimit: number): Promise<{ ok: true } | { ok: false; reason: "user"; left: number } | { ok: false; reason: "server" }> {
    const day = this.day();
    return this.accounts.transaction(async (tx) => {
      await tx.lock(`llm_usage:${day}`);
      const mine = Number((await tx.one<{ llm_rows: number }>("select llm_rows from usage where user_id = ? and day = ?", [userId, day]))?.llm_rows ?? 0);
      const userLeft = userLimit - mine;
      if (rows > userLeft) return { ok: false as const, reason: "user" as const, left: Math.max(0, userLeft) };
      const all = Number((await tx.one<{ n: number }>("select coalesce(sum(llm_rows), 0) as n from usage where day = ?", [day]))?.n ?? 0);
      if (rows > serverLimit - all) return { ok: false as const, reason: "server" as const };
      await tx.run(UPSERT_USAGE, [userId, day, rows]);
      return { ok: true as const };
    });
  }

  async addLlmRows(userId: number, rows: number): Promise<void> {
    await this.accounts.run(UPSERT_USAGE, [userId, this.day(), rows]);
  }
}

/** Thrown when the server has too much queued work to take more right now. */
export class BusyError extends Error {}

/**
 * Bounds how many expensive jobs (password hashing) run at once so they cannot starve the rest of the server,
 * and how many may wait. Anything beyond the queue is refused at once instead of piling up.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxQueue) throw new BusyError("The server is busy");
      await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed over by the job ahead
    } else {
      this.active++;
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Where a run takes its slot: `tryStart` resolves to a release function, or undefined when full. Await it. */
export interface RunSlots {
  tryStart(userId: number): Promise<(() => void) | undefined>;
}

/** At most one run per user and `maxRuns` overall, in this server's memory (one server). */
export class RunGate implements RunSlots {
  private readonly users = new Set<number>();
  constructor(private readonly maxRuns: number) {}

  async tryStart(userId: number): Promise<(() => void) | undefined> {
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

/** Bytes and file count of everything under `root`, never following symlinks. */
export function directoryUsage(root: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        bytes += stat.size;
        files++;
      }
    }
  };
  walk(root);
  return { bytes, files };
}

/** Total bytes of regular files under `root`, never following symlinks. */
export const directoryBytes = (root: string): number => directoryUsage(root).bytes;

export function assertWithinDiskQuota(root: string, incomingBytes: number, quotaBytes: number, files?: { newFiles: number; maxFiles: number }): void {
  const used = directoryUsage(root);
  if (used.bytes + incomingBytes > quotaBytes) {
    throw new QuotaError(`Your storage limit of ${Math.round(quotaBytes / 1024 / 1024)} MB would be exceeded; delete some files first`);
  }
  if (files && used.files + files.newFiles > files.maxFiles) {
    throw new QuotaError(`Your limit of ${files.maxFiles} files would be exceeded; delete some files first`);
  }
}
