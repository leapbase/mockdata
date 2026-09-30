import type { Job, JobHooks, ResultOf } from "./job.js";

/** Where heavy jobs run: in a worker thread pool, or (tests, and a fallback) on the calling thread. */
export interface Runner {
  run<J extends Job>(job: J, hooks?: Pick<JobHooks, "signal" | "onProgress">): Promise<ResultOf<J>>;
  /** Stop accepting work and release any threads. */
  close(): Promise<void>;
}
