import { existsSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { LlmCancelledError } from "@mockdata/llm";
import { parseSchema } from "@mockdata/core";
import { afterAll, describe, expect, it } from "vitest";
import { statusFor } from "../src/errors.js";
import { JobTimeoutError } from "../src/workers/errors.js";
import { createRunner } from "../src/workers/factory.js";
import { InlineRunner } from "../src/workers/inline.js";
import type { ExportJob, PreviewJob, RunJob } from "../src/workers/job.js";
import { boot, SHOP_YAML } from "./helpers.js";

/**
 * These tests start real worker threads, which run the COMPILED code (a worker cannot load this repo's TypeScript
 * source). They need `npm run build` first; without it they are skipped, and the rest of the suite needs no build.
 */
const workerFile = fileURLToPath(new URL("../dist/workers/worker.js", import.meta.url));
const built = existsSync(workerFile);
if (!built) console.warn("workers.dist.test.ts: skipped because packages/server/dist is missing (run `npm run build`)");
const d = built ? describe : describe.skip;

const settings = { size: 2, maxQueue: 4, jobTimeoutSecs: 60, heapMb: 1024 };
const schema = parseSchema({
  seed: 7,
  tables: {
    customers: { rows: 30, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string", faker: "person.fullName" }, joined: { type: "date", min: "2020-01-01", max: "2024-01-01" } } },
    orders: { rows: 120, columns: { id: { type: "integer", primaryKey: true }, customer_id: { type: "integer", ref: "customers.id", distribution: "zipf" }, at: { type: "date", after: "customer_id.joined", within: 40 }, total: { type: "float", min: 1, max: 99 } } },
  },
});
const withModel = parseSchema({ seed: 1, tables: { t: { rows: 4, columns: { id: { type: "integer", primaryKey: true }, note: { type: "string", llm: true } } } } });

/** A stand-in model server: answers with N strings, optionally after a delay. */
async function fakeModel(delayMs = 0) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const n = Number(/exactly (\d+)/.exec(body)?.[1] ?? 1);
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(Array.from({ length: n }, (_, i) => `note ${i}`)) }, finish_reason: "stop" }] }));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, requests: () => requests, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}
const envFor = (url: string) => ({ AI_PROVIDER: "ollama", OLLAMA_MODEL: "m", OLLAMA_BASE_URL: url });

const runners: { close(): Promise<void> }[] = [];
const pool = (s = settings) => {
  const r = createRunner(s, { workerFile });
  runners.push(r);
  return r;
};
afterAll(async () => {
  await Promise.all(runners.map((r) => r.close()));
});

d("real worker threads give the same answers as generating on the calling thread", () => {
  const inline = new InlineRunner();

  it("preview: identical for the same seed", async () => {
    const job: PreviewJob = { kind: "preview", schema, seed: 7, previewRows: 20 };
    expect(await pool().run(job)).toEqual(await inline.run(job));
  });

  it("export: the same text for every format, and a byte-identical zip", async () => {
    for (const format of ["json", "ndjson", "csv"] as const) {
      const job: ExportJob = { kind: "export", schema, seed: 7, format, zip: false, env: {} };
      const [a, b] = [await pool().run(job), await inline.run(job)];
      expect(a.texts, format).toEqual(b.texts);
      expect(a.counts).toEqual({ customers: 30, orders: 120 });
    }
    const zipJob: ExportJob = { kind: "export", schema, seed: 7, format: "csv", zip: true, env: {} };
    const [a, b] = [await pool().run(zipJob), await inline.run(zipJob)];
    expect(Buffer.from(a.archive!).equals(Buffer.from(b.archive!))).toBe(true);
    expect(Buffer.from(a.archive!).subarray(0, 2).toString()).toBe("PK");
  });

  it("keeps cells that are still pending for a model as null in the preview, and lists the column", async () => {
    const r = await pool().run({ kind: "preview", schema: withModel, seed: 1, previewRows: 10 });
    expect(r.preview.pending).toEqual(["t.note"]);
    expect(r.preview.tables.t!.rows.every((row) => row.note === null)).toBe(true);
  });

  it("run: fills model-written columns through the worker's own network access and reports progress", async () => {
    const model = await fakeModel();
    const progress: unknown[] = [];
    const r = await pool().run({ kind: "run", schema: withModel, seed: 1, previewRows: 10, env: envFor(model.url) }, { onProgress: (p) => progress.push(p) });
    await model.close();
    expect(r.preview.pending).toEqual([]);
    expect(r.preview.tables.t!.rows.map((x) => x.note)).toEqual(["note 0", "note 1", "note 2", "note 3"]);
    expect(r.report.calls).toBe(1);
    expect(progress.length).toBeGreaterThan(0);
  });
});

d("errors in a worker map to the same HTTP statuses as before", () => {
  it("reports a missing model provider as a 400-class configuration error", async () => {
    const err = await pool().run({ kind: "run", schema: withModel, seed: 1, previewRows: 5, env: {} }).catch((e) => e);
    expect(err.message).toMatch(/provider/i);
    expect(statusFor(err)).toBe(400);
  });
});

d("cancelling and time limits", () => {
  it("stops a model run when the client goes away, well before the model would have answered", async () => {
    const model = await fakeModel(3000);
    const ctl = new AbortController();
    const p = pool().run({ kind: "run", schema: withModel, seed: 1, previewRows: 5, env: envFor(model.url) }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 300);
    const started = Date.now();
    await expect(p).rejects.toBeInstanceOf(LlmCancelledError);
    expect(Date.now() - started).toBeLessThan(2500);
    await model.close();
  });

  it("terminates a job that runs past its limit, and the pool keeps working afterwards", async () => {
    const model = await fakeModel(5000);
    const runner = pool({ ...settings, size: 1, jobTimeoutSecs: 1 });
    const err = await runner.run({ kind: "run", schema: withModel, seed: 1, previewRows: 5, env: envFor(model.url) }).catch((e) => e);
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect(statusFor(err)).toBe(504);
    const ok = await runner.run({ kind: "preview", schema, seed: 7, previewRows: 3 });
    expect(ok.preview.counts).toEqual({ customers: 30, orders: 120 });
    await model.close();
  }, 15_000);

  it("shuts down cleanly: running work fails and later work is refused", async () => {
    const model = await fakeModel(5000);
    const runner = createRunner(settings, { workerFile });
    const running = runner.run({ kind: "run", schema: withModel, seed: 1, previewRows: 5, env: envFor(model.url) });
    await new Promise((r) => setTimeout(r, 300));
    await runner.close();
    await expect(running).rejects.toThrow(/shutting down/i);
    await expect(runner.run({ kind: "preview", schema, previewRows: 1 })).rejects.toThrow(/shutting down/i);
    await model.close();
  });
});

d("the point: the server stays responsive while it generates", () => {
  const big = parseSchema({ seed: 1, tables: { t: { rows: 150_000, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string", faker: "person.fullName" }, city: { type: "string", faker: "location.city" }, born: { type: "date" }, score: { type: "float", min: 0, max: 9 } } } } });
  /** The longest gap between two ticks of a 5 ms timer while `work` runs. */
  async function worstStall(work: () => Promise<unknown>): Promise<{ stall: number; took: number }> {
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    const start = performance.now();
    await work();
    const took = performance.now() - start;
    await new Promise((r) => setTimeout(r, 30)); // a timer that was blocked only gets to report its lateness now
    clearInterval(timer);
    return { stall: worst, took };
  }

  it("on the calling thread a large preview freezes the event loop; in a worker it does not", async () => {
    const job: PreviewJob = { kind: "preview", schema: big, seed: 1, previewRows: 5 };
    const inline = await worstStall(() => new InlineRunner().run(job));
    const runner = pool();
    await runner.run({ kind: "preview", schema, previewRows: 1 }); // start a worker first so startup is not counted
    const threaded = await worstStall(() => runner.run(job));
    console.log(`event-loop stall: ${Math.round(inline.stall)} ms in-process vs ${Math.round(threaded.stall)} ms with a worker (job took ${Math.round(inline.took)} / ${Math.round(threaded.took)} ms)`);
    expect(inline.stall).toBeGreaterThan(500); // the problem is real
    expect(threaded.stall).toBeLessThan(150); // and the worker removes it
  }, 60_000);
});

d("through the HTTP routes", () => {
  it("serves preview, run and export from worker threads with the same answers", async () => {
    const inline = await boot();
    const threaded = await boot({ workers: { ...settings, workerFile } });
    const a = await inline.post("/api/generate", { text: SHOP_YAML, seed: 3 });
    const b = await threaded.post("/api/generate", { text: SHOP_YAML, seed: 3 });
    expect(b.status).toBe(200);
    expect(b.json).toEqual(a.json);
    const za = await inline.call("POST", "/api/export", { text: SHOP_YAML, seed: 3, zip: true });
    const zb = await threaded.call("POST", "/api/export", { text: SHOP_YAML, seed: 3, zip: true });
    expect(zb.status).toBe(200);
    expect(zb.raw).toBe(za.raw);
    const bad = await threaded.post("/api/generate", { text: "tables: { a: { rows: 1, columns: { x: { type: nope } } } }" });
    expect(bad.status).toBe(400);
  });
});
