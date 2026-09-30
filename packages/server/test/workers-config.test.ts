import { describe, expect, it } from "vitest";
import { poolSettingsFromEnv } from "../src/workers/factory.js";

describe("poolSettingsFromEnv", () => {
  it("defaults to up to 4 threads, leaving a core for the server, a 16-deep queue and a 2-minute limit", () => {
    const s = poolSettingsFromEnv({}, 8);
    expect(s).toEqual({ size: 4, maxQueue: 16, jobTimeoutSecs: 120, heapMb: 2048 });
    expect(poolSettingsFromEnv({}, 2).size).toBe(1);
    expect(poolSettingsFromEnv({}, 1).size).toBe(1);
    expect(poolSettingsFromEnv({}, 3).size).toBe(2);
  });

  it("reads overrides, and 0 workers means generate on the calling thread", () => {
    expect(poolSettingsFromEnv({ MOCKDATA_WORKERS: "2", MOCKDATA_WORKER_QUEUE: "5", MOCKDATA_JOB_TIMEOUT_SECS: "30", MOCKDATA_WORKER_HEAP_MB: "512" }, 8)).toEqual({ size: 2, maxQueue: 5, jobTimeoutSecs: 30, heapMb: 512 });
    expect(poolSettingsFromEnv({ MOCKDATA_WORKERS: "0" }, 8).size).toBe(0);
  });

  it("refuses nonsense, naming the variable and never echoing its value", () => {
    for (const [name, value] of [["MOCKDATA_WORKERS", "many"], ["MOCKDATA_WORKERS", "-1"], ["MOCKDATA_WORKER_QUEUE", "0"], ["MOCKDATA_JOB_TIMEOUT_SECS", "1.5"], ["MOCKDATA_WORKER_HEAP_MB", "10"]] as const) {
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
