import { EventEmitter } from "node:events";
import { BusyError } from "@mockdata/accounts";
import { UserError } from "@mockdata/cli";
import { LlmCancelledError } from "@mockdata/llm";
import { describe, expect, it } from "vitest";
import { JobTimeoutError } from "../src/workers/errors.js";
import type { PreviewJob } from "../src/workers/job.js";
import { WorkerPool } from "../src/workers/pool.js";
import type { FromWorker, ToWorker, WorkerLike } from "../src/workers/protocol.js";

/** A worker the test drives by hand. */
class FakeWorker extends EventEmitter implements WorkerLike {
  sent: ToWorker[] = [];
  terminated = false;
  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
  }
  async terminate(): Promise<number> {
    if (this.terminated) return 0;
    this.terminated = true;
    queueMicrotask(() => this.emit("exit", 1));
    return 0;
  }
  unref(): void {}
  /** The id of the job this worker was last asked to run. */
  get jobId(): number {
    return (this.sent.findLast((m) => m.type === "job") as { id: number }).id;
  }
  say(msg: FromWorker): void {
    this.emit("message", msg);
  }
  finish(result: unknown = { preview: { ok: true } }): void {
    this.say({ type: "result", id: this.jobId, result: result as never });
  }
}

const job: PreviewJob = { kind: "preview", schema: { tables: {} } as never, previewRows: 5 };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function makePool(opts: { size?: number; queue?: number; timeoutMs?: number; graceMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool({
    size: opts.size ?? 2,
    maxQueue: opts.queue ?? 4,
    jobTimeoutMs: opts.timeoutMs ?? 10_000,
    abortGraceMs: opts.graceMs ?? 10_000,
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { pool, workers };
}

describe("WorkerPool: running jobs", () => {
  it("sends the job to a worker and resolves with what it answers, forwarding progress", async () => {
    const { pool, workers } = makePool();
    const seen: unknown[] = [];
    const p = pool.run(job, { onProgress: (x) => seen.push(x) });
    await tick();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent[0]).toMatchObject({ type: "job", job });
    workers[0]!.say({ type: "progress", id: workers[0]!.jobId, progress: { column: "t.c", done: 1, total: 2 } as never });
    workers[0]!.finish({ preview: { ok: 1 } });
    await expect(p).resolves.toEqual({ preview: { ok: 1 } });
    expect(seen).toEqual([{ column: "t.c", done: 1, total: 2 }]);
  });

  it("starts workers lazily, up to its size, and reuses idle ones", async () => {
    const { pool, workers } = makePool({ size: 2 });
    expect(workers).toHaveLength(0);
    const a = pool.run(job);
    await tick();
    workers[0]!.finish();
    await a;
    const b = pool.run(job); // the first worker is idle again
    await tick();
    expect(workers).toHaveLength(1);
    const c = pool.run(job); // a second job at once needs a second worker
    await tick();
    expect(workers).toHaveLength(2);
    workers[0]!.finish();
    workers[1]!.finish();
    await Promise.all([b, c]);
  });

  it("queues work beyond its size, in order, and starts the next job as soon as a worker frees up", async () => {
    const { pool, workers } = makePool({ size: 1, queue: 4 });
    const order: string[] = [];
    const a = pool.run(job).then(() => order.push("a"));
    const b = pool.run(job).then(() => order.push("b"));
    const c = pool.run(job).then(() => order.push("c"));
    await tick();
    expect(workers[0]!.sent.filter((m) => m.type === "job")).toHaveLength(1); // only the first has started
    workers[0]!.finish();
    await tick();
    expect(workers[0]!.sent.filter((m) => m.type === "job")).toHaveLength(2);
    workers[0]!.finish();
    await tick();
    workers[0]!.finish();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("refuses work with BusyError when the queue is full, without touching a worker", async () => {
    const { pool, workers } = makePool({ size: 1, queue: 1 });
    const a = pool.run(job);
    const b = pool.run(job);
    await expect(pool.run(job)).rejects.toBeInstanceOf(BusyError);
    await tick();
    expect(workers).toHaveLength(1);
    workers[0]!.finish();
    await tick();
    workers[0]!.finish();
    await Promise.all([a, b]);
    expect(pool.stats()).toEqual({ workers: 1, busy: 0, queued: 0 });
  });

  it("rejects with the original kind of error the worker reports, and frees the worker for the next job", async () => {
    const { pool, workers } = makePool({ size: 1 });
    const a = pool.run(job);
    const b = pool.run(job);
    await tick();
    workers[0]!.say({ type: "error", id: workers[0]!.jobId, error: { kind: "user", name: "Error", message: "bad input" } });
    const err = await a.catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe("bad input");
    await tick();
    workers[0]!.finish({ preview: { second: true } });
    await expect(b).resolves.toEqual({ preview: { second: true } });
  });

  it("ignores a late message for a job it no longer owns", async () => {
    const { pool, workers } = makePool({ size: 1 });
    const a = pool.run(job);
    await tick();
    const staleId = workers[0]!.jobId;
    workers[0]!.finish();
    await a;
    const b = pool.run(job);
    await tick();
    workers[0]!.say({ type: "result", id: staleId, result: { preview: { stale: true } } as never });
    workers[0]!.finish({ preview: { fresh: true } });
    await expect(b).resolves.toEqual({ preview: { fresh: true } });
  });
});

describe("WorkerPool: a job that runs too long or a worker that dies", () => {
  it("stops a runaway job at the time limit, rejects with a timeout, and the next job gets a fresh worker", async () => {
    const { pool, workers } = makePool({ size: 1, timeoutMs: 20 });
    const err = await pool.run(job).catch((e) => e);
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect(workers[0]!.terminated).toBe(true);
    const next = pool.run(job);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.finish({ preview: { ok: "after" } });
    await expect(next).resolves.toEqual({ preview: { ok: "after" } });
  });

  it("rejects the running job if its worker crashes, and replaces the worker", async () => {
    const { pool, workers } = makePool({ size: 1 });
    const a = pool.run(job);
    await tick();
    workers[0]!.emit("error", new Error("out of memory at /srv/app/secret/path"));
    const err = await a.catch((e) => e);
    expect(err.message).not.toContain("/srv/app"); // the crash detail stays out of what callers see
    expect(err.message).toMatch(/worker/i);
    const b = pool.run(job);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.finish();
    await b;
  });

  it("rejects the running job if its worker exits on its own", async () => {
    const { pool, workers } = makePool({ size: 1 });
    const a = pool.run(job);
    await tick();
    workers[0]!.emit("exit", 1);
    await expect(a).rejects.toThrow(/worker/i);
  });

  it("replaces an idle worker that dies, without failing anything", async () => {
    const { pool, workers } = makePool({ size: 1 });
    const a = pool.run(job);
    await tick();
    workers[0]!.finish();
    await a;
    workers[0]!.emit("exit", 1);
    const b = pool.run(job);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.finish();
    await b;
  });
});

describe("WorkerPool: cancelling", () => {
  it("rejects at once, without starting a worker, if the signal is already aborted", async () => {
    const { pool, workers } = makePool();
    const ctl = new AbortController();
    ctl.abort();
    await expect(pool.run(job, { signal: ctl.signal })).rejects.toBeInstanceOf(LlmCancelledError);
    expect(workers).toHaveLength(0);
  });

  it("drops a queued job when its signal fires, and never sends it to a worker", async () => {
    const { pool, workers } = makePool({ size: 1, queue: 4 });
    const a = pool.run(job);
    const ctl = new AbortController();
    const b = pool.run(job, { signal: ctl.signal });
    await tick();
    ctl.abort();
    await expect(b).rejects.toBeInstanceOf(LlmCancelledError);
    expect(pool.stats().queued).toBe(0);
    workers[0]!.finish();
    await a;
    await tick();
    expect(workers[0]!.sent.filter((m) => m.type === "job")).toHaveLength(1);
  });

  it("asks a running job to stop, and lets it finish cleanly if it does", async () => {
    const { pool, workers } = makePool({ size: 1, graceMs: 10_000 });
    const ctl = new AbortController();
    const a = pool.run(job, { signal: ctl.signal });
    await tick();
    const id = workers[0]!.jobId;
    ctl.abort();
    await tick();
    expect(workers[0]!.sent.at(-1)).toEqual({ type: "abort", id });
    workers[0]!.say({ type: "error", id, error: { kind: "llmCancelled", name: "LlmCancelledError", message: "LLM generation was cancelled" } });
    await expect(a).rejects.toBeInstanceOf(LlmCancelledError);
    expect(workers[0]!.terminated).toBe(false); // the worker is reused
  });

  it("stops a worker that ignores the request (stuck in synchronous work) after a short grace period", async () => {
    const { pool, workers } = makePool({ size: 1, graceMs: 20 });
    const ctl = new AbortController();
    const a = pool.run(job, { signal: ctl.signal });
    await tick();
    ctl.abort();
    await expect(a).rejects.toBeInstanceOf(LlmCancelledError);
    expect(workers[0]!.terminated).toBe(true);
    const b = pool.run(job);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.finish();
    await b;
  });
});

describe("WorkerPool: shutting down", () => {
  it("stops every worker, fails queued and running jobs, and refuses new ones", async () => {
    const { pool, workers } = makePool({ size: 1, queue: 4 });
    const running = pool.run(job);
    const queued = pool.run(job);
    await tick();
    const closing = pool.close();
    await expect(running).rejects.toThrow(/shutting down/i);
    await expect(queued).rejects.toThrow(/shutting down/i);
    await closing;
    expect(workers.every((w) => w.terminated)).toBe(true);
    await expect(pool.run(job)).rejects.toThrow(/shutting down/i);
    await pool.close(); // closing twice is harmless
  });
});
