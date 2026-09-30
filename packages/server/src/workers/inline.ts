import { runJob, type Job, type JobHooks, type ResultOf } from "./job.js";
import type { Runner } from "./runner.js";

/** Runs a job on the calling thread. Blocks the event loop while it generates, so it is for tests and as a fallback. */
export class InlineRunner implements Runner {
  constructor(private readonly llm?: JobHooks["llm"]) {}

  run<J extends Job>(job: J, hooks: Pick<JobHooks, "signal" | "onProgress"> = {}): Promise<ResultOf<J>> {
    return runJob(job, { ...hooks, llm: this.llm });
  }

  async close(): Promise<void> {}
}
