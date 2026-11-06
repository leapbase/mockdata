import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { llmColumns } from "@mockdata/core";
import { InlineRunner } from "./inline.js";
import type { Job, JobHooks } from "./job.js";
import { WorkerPool } from "./pool.js";
import type { WorkerLike } from "./protocol.js";
import type { Runner } from "./runner.js";

export interface PoolSettings {
  /** Worker threads; 0 means generate on the calling thread. */
  size: number;
  /** Jobs allowed to wait for a free worker. */
  maxQueue: number;
  /** A job running longer than this many seconds is stopped. */
  jobTimeoutSecs: number;
  /** Seconds allowed per model batch on top of `jobTimeoutSecs` (see `jobTimeoutMs`). */
  llmBatchSecs: number;
  /** Each thread's heap limit in MB, so one pathological job cannot take the server down. */
  heapMb: number;
}

function whole(env: Record<string, string | undefined>, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`);
  return n;
}

/** MOCKDATA_WORKERS (default: up to 4, always leaving a core for the server), MOCKDATA_WORKER_QUEUE, MOCKDATA_JOB_TIMEOUT_SECS, MOCKDATA_JOB_TIMEOUT_LLM_BATCH_SECS, MOCKDATA_WORKER_HEAP_MB. */
export function poolSettingsFromEnv(env: Record<string, string | undefined>, cores = availableParallelism()): PoolSettings {
  return {
    size: whole(env, "MOCKDATA_WORKERS", Math.min(4, Math.max(1, cores - 1)), 0),
    maxQueue: whole(env, "MOCKDATA_WORKER_QUEUE", 16, 1),
    jobTimeoutSecs: whole(env, "MOCKDATA_JOB_TIMEOUT_SECS", 120, 1),
    llmBatchSecs: whole(env, "MOCKDATA_JOB_TIMEOUT_LLM_BATCH_SECS", 5, 1),
    heapMb: whole(env, "MOCKDATA_WORKER_HEAP_MB", 2048, 64),
  };
}

/**
 * Model-written cells a job will actually fill. Preview jobs fill none (their `llm` columns stay pending), run
 * jobs fill only the preview subset (`previewRows` per table), and export/sample jobs fill every row.
 */
export function llmCellsForJob(job: Job): number {
  if (job.kind === "preview") return 0;
  const rowsOf = (table: string) => job.schema.tables[table]?.rows ?? 0;
  const perTable = job.kind === "run" ? (t: string) => Math.min(rowsOf(t), job.previewRows) : rowsOf;
  return llmColumns(job.schema).reduce((n, c) => n + perTable(c.table), 0);
}

/**
 * How long one job may run before the pool stops it. Non-LLM jobs keep the plain `jobTimeoutSecs` (default 120 s),
 * which covers deterministic generation plus serialisation. A job with model-written columns gets that base plus
 * `llmBatchSecs` per model batch (`ceil(llmCells / batchSize)` batches): a 2,000-row LLM run at batch 20 is 100
 * batches, about 150 s at ~1.5 s a call, so the 120 s base alone would kill it. The 5 s-per-batch allowance is
 * roughly 3x that observed latency, leaving room for a slow provider and for retries / unique-value re-asks,
 * which are not counted as extra batches. The allowance is deliberately counted per batch as if batches ran
 * one after another, even though the fill now runs up to 4 batches concurrently (default in @mockdata/llm):
 * that over-estimates the wall time, so a legitimate run is never cut short if concurrency drops or a provider
 * serialises requests. The timeout is still a hard stop — a hung provider call is bounded by the provider's
 * own 120 s request timeout, and a job that never finishes still gets terminated. Wired in
 * `createRunner` via `PoolOptions.jobTimeoutMsFor`, so the pool arms the per-job limit.
 */
export function jobTimeoutMs(job: Job, settings: PoolSettings): number {
  // Defaults mirror poolSettingsFromEnv, so a hand-built settings object missing a field fails safe
  // instead of producing a NaN timeout (which would fire immediately and kill the job).
  const base = (settings.jobTimeoutSecs ?? 120) * 1000;
  const cells = llmCellsForJob(job);
  if (cells === 0) return base;
  const batchSize = job.schema.llm?.batchSize ?? 20;
  return base + Math.ceil(cells / batchSize) * (settings.llmBatchSecs ?? 5) * 1000;
}

export interface RunnerOptions {
  /** Path of the compiled worker entry. Default: worker.js next to this file (so it works from dist only). */
  workerFile?: string;
  /** Test hooks that only the calling thread can use (functions cannot be sent to a worker). */
  llm?: JobHooks["llm"];
}

/** A pool of worker threads, or the calling thread when `size` is 0 or test hooks are given. */
export function createRunner(settings: PoolSettings, opts: RunnerOptions = {}): Runner {
  if (settings.size === 0 || opts.llm?.provider || opts.llm?.fetch || opts.llm?.sleep) return new InlineRunner(opts.llm);
  const file = opts.workerFile ?? fileURLToPath(new URL("./worker.js", import.meta.url));
  return new WorkerPool({
    size: settings.size,
    maxQueue: settings.maxQueue,
    jobTimeoutMs: settings.jobTimeoutSecs * 1000,
    jobTimeoutMsFor: (job) => jobTimeoutMs(job, settings),
    abortGraceMs: 2000,
    createWorker: () => new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: settings.heapMb } }) as unknown as WorkerLike,
  });
}
