import type { LlmProgress } from "@mockdata/llm";
import type { WireError } from "./errors.js";
import type { Job, JobResults } from "./job.js";

/** Messages from the main thread to a worker. */
export type ToWorker = { type: "job"; id: number; job: Job } | { type: "abort"; id: number };

/** Messages from a worker to the main thread. `id` names the job they answer, so a late message cannot reach the wrong one. */
export type FromWorker =
  /** Sent once when the worker's code has loaded and it can take a job. */
  | { type: "ready" }
  | { type: "progress"; id: number; progress: LlmProgress }
  | { type: "result"; id: number; result: JobResults[Job["kind"]] }
  | { type: "error"; id: number; error: WireError };

/** The part of a `worker_threads` Worker the pool uses, so tests can drive a fake one. */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): Promise<number>;
  unref(): void;
  on(event: "message", listener: (message: FromWorker) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
}
