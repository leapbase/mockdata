import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { InlineRunner } from "./inline.js";
import type { JobHooks } from "./job.js";
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

/** MOCKDATA_WORKERS (default: up to 4, always leaving a core for the server), MOCKDATA_WORKER_QUEUE, MOCKDATA_JOB_TIMEOUT_SECS, MOCKDATA_WORKER_HEAP_MB. */
export function poolSettingsFromEnv(env: Record<string, string | undefined>, cores = availableParallelism()): PoolSettings {
  return {
    size: whole(env, "MOCKDATA_WORKERS", Math.min(4, Math.max(1, cores - 1)), 0),
    maxQueue: whole(env, "MOCKDATA_WORKER_QUEUE", 16, 1),
    jobTimeoutSecs: whole(env, "MOCKDATA_JOB_TIMEOUT_SECS", 120, 1),
    heapMb: whole(env, "MOCKDATA_WORKER_HEAP_MB", 2048, 64),
  };
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
    abortGraceMs: 2000,
    createWorker: () => new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: settings.heapMb } }) as unknown as WorkerLike,
  });
}
