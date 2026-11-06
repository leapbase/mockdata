import { describe, expect, it } from "vitest";
import type { DataSchemaT } from "@mockdata/core";
import { jobTimeoutMs, llmCellsForJob, poolSettingsFromEnv, type PoolSettings } from "../src/workers/factory.js";
import type { Job } from "../src/workers/job.js";

const settings = (over: Partial<PoolSettings> = {}): PoolSettings => ({
  size: 2,
  maxQueue: 16,
  jobTimeoutSecs: 120,
  llmBatchSecs: 5,
  heapMb: 2048,
  ...over,
});

/** One llm column on a table of `rows` rows. */
const llmSchema = (rows: number, batchSize?: number): DataSchemaT => ({
  ...(batchSize !== undefined ? { llm: { batchSize } } : {}),
  tables: {
    notes: {
      rows,
      columns: {
        id: { type: "integer", primaryKey: true },
        body: { type: "string", llm: true },
      },
    },
  },
});

describe("poolSettingsFromEnv", () => {
  it("defaults to up to 4 threads, leaving a core for the server, a 16-deep queue and a 2-minute limit", () => {
    const s = poolSettingsFromEnv({}, 8);
    expect(s).toEqual({ size: 4, maxQueue: 16, jobTimeoutSecs: 120, llmBatchSecs: 5, heapMb: 2048 });
    expect(poolSettingsFromEnv({}, 2).size).toBe(1);
    expect(poolSettingsFromEnv({}, 1).size).toBe(1);
    expect(poolSettingsFromEnv({}, 3).size).toBe(2);
  });

  it("reads overrides, and 0 workers means generate on the calling thread", () => {
    expect(poolSettingsFromEnv({ MOCKDATA_WORKERS: "2", MOCKDATA_WORKER_QUEUE: "5", MOCKDATA_JOB_TIMEOUT_SECS: "30", MOCKDATA_JOB_TIMEOUT_LLM_BATCH_SECS: "10", MOCKDATA_WORKER_HEAP_MB: "512" }, 8)).toEqual({ size: 2, maxQueue: 5, jobTimeoutSecs: 30, llmBatchSecs: 10, heapMb: 512 });
    expect(poolSettingsFromEnv({ MOCKDATA_WORKERS: "0" }, 8).size).toBe(0);
  });

  it("refuses nonsense, naming the variable and never echoing its value", () => {
    for (const [name, value] of [["MOCKDATA_WORKERS", "many"], ["MOCKDATA_WORKERS", "-1"], ["MOCKDATA_WORKER_QUEUE", "0"], ["MOCKDATA_JOB_TIMEOUT_SECS", "1.5"], ["MOCKDATA_JOB_TIMEOUT_LLM_BATCH_SECS", "0"], ["MOCKDATA_WORKER_HEAP_MB", "10"]] as const) {
      try {
        poolSettingsFromEnv({ [name]: value }, 8);
        expect.unreachable(`${name}=${value}`);
      } catch (e) {
        expect((e as Error).message).toContain(name);
        expect((e as Error).message).not.toContain(value);
      }
    }
  });
});

describe("jobTimeoutMs", () => {
  it("keeps the 120 s default for jobs with no model-written columns", () => {
    const plain: DataSchemaT = {
      tables: { t: { rows: 1000, columns: { id: { type: "integer", primaryKey: true } } } },
    };
    expect(jobTimeoutMs({ kind: "export", schema: plain, format: "json", zip: false, env: {} }, settings())).toBe(120_000);
    expect(jobTimeoutMs({ kind: "preview", schema: llmSchema(2000), previewRows: 50 }, settings())).toBe(120_000);
  });

  it("scales with the model batches an export needs: 2,000 LLM rows at batch 20 is 100 calls", () => {
    const job: Job = { kind: "export", schema: llmSchema(2000), format: "json", zip: false, env: {} };
    expect(llmCellsForJob(job)).toBe(2000);
    // 120 s base + 100 batches x 5 s: the ~150 s run from PERF-H2 now fits.
    expect(jobTimeoutMs(job, settings())).toBe(620_000);
    expect(jobTimeoutMs({ ...job, schema: llmSchema(2000, 50) }, settings())).toBe(120_000 + 40 * 5_000);
  });

  it("counts only the preview subset for a run job", () => {
    const job: Job = { kind: "run", schema: llmSchema(2000), previewRows: 50, env: {} };
    expect(llmCellsForJob(job)).toBe(50);
    expect(jobTimeoutMs(job, settings())).toBe(120_000 + 3 * 5_000);
  });

  it("honours the configured base and per-batch allowance", () => {
    const job: Job = { kind: "export", schema: llmSchema(100), format: "json", zip: false, env: {} };
    expect(jobTimeoutMs(job, settings({ jobTimeoutSecs: 30, llmBatchSecs: 10 }))).toBe(30_000 + 5 * 10_000);
  });
});
