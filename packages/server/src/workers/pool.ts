import { BusyError } from "@mockdata/accounts";
import { LlmCancelledError, type LlmProgress } from "@mockdata/llm";
import { decodeError, JobTimeoutError } from "./errors.js";
import type { Job, JobHooks, ResultOf } from "./job.js";
import type { FromWorker, WorkerLike } from "./protocol.js";
import type { Runner } from "./runner.js";

export interface PoolOptions {
  /** Most worker threads running at once. */
  size: number;
  /** Jobs that may wait for a free worker; more than this is refused with BusyError. */
  maxQueue: number;
  /** A job running longer than this is stopped and its worker replaced. */
  jobTimeoutMs: number;
  /** After a cancel, how long a worker gets to stop by itself before it is terminated. */
  abortGraceMs: number;
  createWorker: () => WorkerLike;
}

interface Active {
  id: number;
  resolve: (result: never) => void;
  reject: (error: Error) => void;
  onProgress?: (p: LlmProgress) => void;
  /** Armed once the worker is ready, so loading the code does not count against the job. */
  timeout?: NodeJS.Timeout;
  grace?: NodeJS.Timeout;
  detach: () => void;
}

interface Slot {
  worker: WorkerLike;
  /** The worker has loaded its code and said so. */
  ready: boolean;
  active?: Active;
}

interface Waiting {
  job: Job;
  hooks: Pick<JobHooks, "signal" | "onProgress">;
  resolve: (result: never) => void;
  reject: (error: Error) => void;
  detach: () => void;
}

/**
 * Runs jobs in worker threads so generation never blocks the server's event loop. Threads start when first needed and
 * are reused; work beyond the pool's size waits in a bounded queue. A job that runs too long, or a worker that crashes,
 * costs only that job and one replacement thread.
 */
export class WorkerPool implements Runner {
  private readonly slots: Slot[] = [];
  private readonly queue: Waiting[] = [];
  private nextId = 1;
  private closed = false;

  constructor(private readonly opts: PoolOptions) {}

  stats(): { workers: number; busy: number; queued: number } {
    return { workers: this.slots.length, busy: this.slots.filter((s) => s.active).length, queued: this.queue.length };
  }

  run<J extends Job>(job: J, hooks: Pick<JobHooks, "signal" | "onProgress"> = {}): Promise<ResultOf<J>> {
    if (this.closed) return Promise.reject(new Error("The server is shutting down"));
    if (hooks.signal?.aborted) return Promise.reject(new LlmCancelledError());
    return new Promise<ResultOf<J>>((resolve, reject) => {
      const waiting: Waiting = { job, hooks, resolve: resolve as (r: never) => void, reject, detach: () => undefined };
      const slot = this.idleSlot();
      if (slot) return this.start(slot, waiting);
      if (this.queue.length >= this.opts.maxQueue) return reject(new BusyError("The server is busy"));
      const onAbort = () => {
        const i = this.queue.indexOf(waiting);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new LlmCancelledError());
      };
      hooks.signal?.addEventListener("abort", onAbort, { once: true });
      waiting.detach = () => hooks.signal?.removeEventListener("abort", onAbort);
      this.queue.push(waiting);
    });
  }

  private idleSlot(): Slot | undefined {
    const idle = this.slots.find((s) => !s.active);
    if (idle) return idle;
    if (this.slots.length < this.opts.size) return this.spawn();
    return undefined;
  }

  private spawn(): Slot {
    const worker = this.opts.createWorker();
    worker.unref(); // an idle worker must not keep a process alive
    const slot: Slot = { worker, ready: false };
    this.slots.push(slot);
    worker.on("message", (msg: FromWorker) => this.onMessage(slot, msg));
    // A crash, or an exit nobody asked for: fail the job that was running and forget this thread.
    const gone = () => this.lose(slot, new Error("A worker stopped unexpectedly"));
    worker.on("error", gone);
    worker.on("exit", gone);
    return slot;
  }

  private start(slot: Slot, waiting: Waiting): void {
    waiting.detach();
    const { job, hooks } = waiting;
    if (hooks.signal?.aborted) {
      waiting.reject(new LlmCancelledError());
      return this.next();
    }
    const id = this.nextId++;
    const onAbort = () => {
      const active = slot.active;
      if (!active || active.id !== id) return;
      slot.worker.postMessage({ type: "abort", id });
      // A worker busy in synchronous work cannot hear this; after the grace period stop the thread itself.
      active.grace = setTimeout(() => this.lose(slot, new LlmCancelledError(), true), this.opts.abortGraceMs);
    };
    hooks.signal?.addEventListener("abort", onAbort, { once: true });
    slot.active = {
      id,
      resolve: waiting.resolve,
      reject: waiting.reject,
      onProgress: hooks.onProgress,
      detach: () => hooks.signal?.removeEventListener("abort", onAbort),
    };
    if (slot.ready) this.armTimeout(slot);
    slot.worker.postMessage({ type: "job", id, job });
  }

  private armTimeout(slot: Slot): void {
    const active = slot.active;
    if (!active || active.timeout) return;
    active.timeout = setTimeout(() => this.lose(slot, new JobTimeoutError(Math.round(this.opts.jobTimeoutMs / 1000)), true), this.opts.jobTimeoutMs);
  }

  private onMessage(slot: Slot, msg: FromWorker): void {
    if (msg.type === "ready") {
      slot.ready = true;
      this.armTimeout(slot); // a job already waiting on this worker starts its clock now
      return;
    }
    const active = slot.active;
    if (!active || active.id !== msg.id) return; // late or stray: that job is already over
    if (msg.type === "progress") return void active.onProgress?.(msg.progress);
    this.finish(slot);
    if (msg.type === "result") active.resolve(msg.result as never);
    else active.reject(decodeError(msg.error));
    this.next();
  }

  /** The job on this slot is over (cleanly or not): clear its timers and free the slot. */
  private finish(slot: Slot): Active | undefined {
    const active = slot.active;
    if (!active) return undefined;
    if (active.timeout) clearTimeout(active.timeout);
    if (active.grace) clearTimeout(active.grace);
    active.detach();
    slot.active = undefined;
    return active;
  }

  /** This worker is finished (crashed, timed out, or cancelled while stuck): fail its job and drop the thread. */
  private lose(slot: Slot, error: Error, terminate = false): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return; // already dealt with (a terminate also emits "exit")
    this.slots.splice(i, 1);
    if (terminate) void slot.worker.terminate().catch(() => undefined);
    this.finish(slot)?.reject(error);
    this.next();
  }

  private next(): void {
    while (this.queue.length > 0 && !this.closed) {
      const slot = this.idleSlot();
      if (!slot) return;
      this.start(slot, this.queue.shift()!);
    }
  }

  /** Stop every worker, fail queued and running jobs, and refuse new ones. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stopping = new Error("The server is shutting down");
    for (const waiting of this.queue.splice(0)) {
      waiting.detach();
      waiting.reject(stopping);
    }
    const slots = this.slots.splice(0);
    await Promise.all(
      slots.map((slot) => {
        this.finish(slot)?.reject(stopping);
        return slot.worker.terminate().catch(() => undefined);
      }),
    );
  }
}
