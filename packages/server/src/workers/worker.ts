import { parentPort } from "node:worker_threads";
import { encodeError } from "./errors.js";
import { runJob } from "./job.js";
import type { FromWorker, ToWorker } from "./protocol.js";

/**
 * The worker thread's entry point: run one job at a time and answer with a small result. Jobs are told apart by id, so
 * an abort that arrives after its job finished is ignored.
 */
const port = parentPort;
if (!port) throw new Error("worker.ts must run in a worker thread");

const post = (msg: FromWorker, transfer: ArrayBuffer[] = []) => port.postMessage(msg, transfer);
let current: { id: number; abort: AbortController } | undefined;

port.on("message", async (msg: ToWorker) => {
  if (msg.type === "abort") {
    if (current?.id === msg.id) current.abort.abort();
    return;
  }
  const abort = new AbortController();
  current = { id: msg.id, abort };
  try {
    const result = await runJob(msg.job, { signal: abort.signal, onProgress: (progress) => post({ type: "progress", id: msg.id, progress }) });
    const transfer: ArrayBuffer[] = [];
    if ("archive" in result && result.archive) {
      // Give the archive a buffer of its own (a Buffer may share one with others), then hand it over without copying.
      const own = result.archive.byteOffset === 0 && result.archive.buffer.byteLength === result.archive.byteLength ? result.archive : new Uint8Array(result.archive);
      result.archive = own;
      transfer.push(own.buffer as ArrayBuffer);
    }
    post({ type: "result", id: msg.id, result }, transfer);
  } catch (e) {
    post({ type: "error", id: msg.id, error: encodeError(e) });
  } finally {
    if (current?.id === msg.id) current = undefined;
  }
});
