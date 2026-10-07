import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountsDb, BusyError, QuotaError, RateLimiter, RunGate, Semaphore, SqlAuthAdapter, UsageStore, assertWithinDiskQuota, directoryBytes, directoryUsage, limitsFromEnv } from "../src/index.js";
import { eachEngine, openDb } from "./engines.js";

describe("RateLimiter", () => {
  it("allows max hits per window, then refuses until the window slides past", () => {
    const now = { t: 0 };
    const rl = new RateLimiter({ max: 3, windowMs: 1000, now: () => now.t });
    expect([rl.hit("k"), rl.hit("k"), rl.hit("k"), rl.hit("k")]).toEqual([true, true, true, false]);
    expect(rl.hit("other")).toBe(true);
    expect(rl.retryAfterSeconds("k")).toBe(1);
    now.t = 1001;
    expect(rl.hit("k")).toBe(true);
  });

  it("can count failures separately from checking (failed logins only)", () => {
    const now = { t: 0 };
    const rl = new RateLimiter({ max: 2, windowMs: 1000, now: () => now.t });
    expect(rl.isLimited("a")).toBe(false);
    rl.record("a");
    rl.record("a");
    expect(rl.isLimited("a")).toBe(true);
    rl.reset("a");
    expect(rl.isLimited("a")).toBe(false);
  });

  it("does not grow without bound", () => {
    const now = { t: 0 };
    const rl = new RateLimiter({ max: 1, windowMs: 10, now: () => now.t, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) {
      now.t += 20;
      rl.hit(`k${i}`);
    }
    expect(rl.size()).toBeLessThanOrEqual(100);
  });
});

describe("limitsFromEnv", () => {
  it("uses defaults, reads overrides, and names the variable (not the value) on bad input", () => {
    expect(limitsFromEnv({})).toEqual({ llmDailyRows: 2000, llmGlobalDailyRows: 20_000, maxRuns: 4, userQuotaBytes: 50 * 1024 * 1024, maxRows: 200_000, maxCells: 500_000, maxFiles: 500 });
    expect(
      limitsFromEnv({ MOCKDATA_LLM_DAILY_ROWS: "10", MOCKDATA_LLM_GLOBAL_DAILY_ROWS: "99", MOCKDATA_MAX_RUNS: "1", MOCKDATA_USER_QUOTA_MB: "2", MOCKDATA_MAX_ROWS: "500", MOCKDATA_MAX_CELLS: "7", MOCKDATA_USER_MAX_FILES: "3" }),
    ).toEqual({ llmDailyRows: 10, llmGlobalDailyRows: 99, maxRuns: 1, userQuotaBytes: 2 * 1024 * 1024, maxRows: 500, maxCells: 7, maxFiles: 3 });
    try {
      limitsFromEnv({ MOCKDATA_MAX_RUNS: "lots" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/MOCKDATA_MAX_RUNS/);
      expect((e as Error).message).not.toContain("lots");
    }
    expect(() => limitsFromEnv({ MOCKDATA_MAX_RUNS: "0" })).toThrow(/MOCKDATA_MAX_RUNS/);
  });
});

eachEngine(() => describe("UsageStore", () => {
  it("counts LLM rows per user per UTC day", async () => {
    const accounts = await openDb();
    const adapter = new SqlAuthAdapter(accounts);
    const make = (email: string) => adapter.createUserWithPasswordIdentity({ normalizedEmail: email, passwordHash: "h", displayName: email });
    const [a, b] = [await make("a@example.com"), await make("b@example.com")];
    const day = { d: "2026-01-01" };
    const usage = new UsageStore(accounts, { today: () => day.d });
    expect(await usage.llmRowsToday(a.id)).toBe(0);
    await usage.addLlmRows(a.id, 30);
    await usage.addLlmRows(a.id, 12);
    await usage.addLlmRows(b.id, 5);
    expect(await usage.llmRowsToday(a.id)).toBe(42);
    expect(await usage.llmRowsToday(b.id)).toBe(5);
    day.d = "2026-01-02";
    expect(await usage.llmRowsToday(a.id)).toBe(0);
  });
}));

describe("RunGate", () => {
  it("allows one run per user and a global maximum, and frees slots on release", () => {
    const gate = new RunGate(2);
    const a = gate.tryStart(1);
    expect(a).toBeTypeOf("function");
    expect(gate.tryStart(1)).toBeUndefined(); // same user already running
    const b = gate.tryStart(2);
    expect(b).toBeTypeOf("function");
    expect(gate.tryStart(3)).toBeUndefined(); // global cap of 2
    a!();
    a!(); // releasing twice is harmless
    const c = gate.tryStart(3);
    expect(c).toBeTypeOf("function"); // user 1's slot is free again
    expect(gate.tryStart(1)).toBeUndefined(); // but 2 and 3 fill the global cap
    b!();
    expect(gate.tryStart(1)).toBeTypeOf("function");
  });
});

describe("disk quota", () => {
  it("sums file sizes, skips symlinks, and refuses writes that would pass the quota", () => {
    const root = mkdtempSync(join(tmpdir(), "mockdata-quota-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.yaml"), "x".repeat(100));
    writeFileSync(join(root, "sub", "b.yaml"), "y".repeat(50));
    const outside = mkdtempSync(join(tmpdir(), "mockdata-quota-out-"));
    writeFileSync(join(outside, "big.bin"), "z".repeat(10_000));
    symlinkSync(join(outside, "big.bin"), join(root, "link.bin"));
    expect(directoryBytes(root)).toBe(150);
    expect(() => assertWithinDiskQuota(root, 40, 200)).not.toThrow();
    expect(() => assertWithinDiskQuota(root, 60, 200)).toThrow(QuotaError);
    expect(() => assertWithinDiskQuota(root, 60, 200)).toThrow(/storage/i);
  });
});

describe("RateLimiter eviction", () => {
  it("drops the quietest keys when full and never forgets one that is over its limit", () => {
    const now = { t: 0 };
    const rl = new RateLimiter({ max: 2, windowMs: 100_000, now: () => now.t, maxKeys: 50 });
    rl.record("victim");
    rl.record("victim");
    expect(rl.isLimited("victim")).toBe(true);
    for (let i = 0; i < 500; i++) {
      now.t += 1;
      rl.hit(`flood${i}`);
    }
    expect(rl.size()).toBeLessThanOrEqual(50);
    expect(rl.isLimited("victim")).toBe(true); // a flood of unique keys cannot lift a lockout
  });
});

describe("Semaphore", () => {
  it("runs at most `max` jobs at once, queues the rest, and refuses when the queue is full", async () => {
    const sem = new Semaphore(2, 2);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const job = () =>
      sem.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((r) => releases.push(r));
        running--;
        return "ok";
      });
    const results = [job(), job(), job(), job()]; // 2 running, 2 queued
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(2);
    await expect(job()).rejects.toBeInstanceOf(BusyError); // queue of 2 is full
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await Promise.all(results)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(peak).toBe(2);
    expect(await sem.run(async () => "again")).toBe("again"); // and it recovers
  });

  it("frees its slot when a job throws", async () => {
    const sem = new Semaphore(1, 1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await sem.run(async () => 1)).toBe(1);
  });
});

eachEngine(() => describe("server-wide usage and file counts", () => {
  it("totals LLM rows across users for the day", async () => {
    const accounts = await openDb();
    const adapter = new SqlAuthAdapter(accounts);
    const a = await adapter.createUserWithPasswordIdentity({ normalizedEmail: "a@example.com", passwordHash: "h", displayName: "a" });
    const b = await adapter.createUserWithPasswordIdentity({ normalizedEmail: "b@example.com", passwordHash: "h", displayName: "b" });
    const usage = new UsageStore(accounts, { today: () => "2026-01-01" });
    await usage.addLlmRows(a.id, 30);
    await usage.addLlmRows(b.id, 12);
    expect(await usage.llmRowsAllUsersToday()).toBe(42);
  });

  it("counts files and refuses a write that would pass the file limit", () => {
    const root = mkdtempSync(join(tmpdir(), "mockdata-files-"));
    mkdirSync(join(root, "sub"));
    for (const n of ["a", "b"]) writeFileSync(join(root, `${n}.yaml`), "x");
    writeFileSync(join(root, "sub", "c.yaml"), "x");
    expect(directoryUsage(root)).toEqual({ bytes: 3, files: 3 });
    expect(() => assertWithinDiskQuota(root, 1, 1000, { newFiles: 1, maxFiles: 4 })).not.toThrow();
    expect(() => assertWithinDiskQuota(root, 1, 1000, { newFiles: 2, maxFiles: 4 })).toThrow(QuotaError);
    expect(() => assertWithinDiskQuota(root, 1, 1000, { newFiles: 2, maxFiles: 4 })).toThrow(/files/i);
  });
}));

eachEngine(() => describe("UsageStore.reserveLlmRows", () => {
  it("checks both limits and charges in one step, so concurrent runs cannot overshoot", async () => {
    const accounts = await openDb();
    const adapter = new SqlAuthAdapter(accounts);
    const users = [];
    for (const n of ["a", "b", "c"]) users.push(await adapter.createUserWithPasswordIdentity({ normalizedEmail: `${n}@example.com`, passwordHash: "h", displayName: n }));
    const usage = new UsageStore(accounts, { today: () => "2026-01-01" });
    // three users each ask for 6 at once against a server-wide 15: exactly two can be served
    const results = await Promise.all(users.map((u) => usage.reserveLlmRows(u.id, 6, 100, 15)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "server" });
    expect(await usage.llmRowsAllUsersToday()).toBe(12);
    // the per-user limit is reported with what is left
    expect(await usage.reserveLlmRows(users[0]!.id, 10, 8, 1000)).toEqual({ ok: false, reason: "user", left: 2 });
    expect(await usage.llmRowsToday(users[0]!.id)).toBe(6); // a refused reservation charges nothing
  });
}));

describe("RateLimiter trimming is amortised", () => {
  it("makes room in bulk so a stream of new keys does not sort the table on every hit", () => {
    const now = { t: 0 };
    const rl = new RateLimiter({ max: 1, windowMs: 1_000_000, now: () => now.t, maxKeys: 1000 });
    for (let i = 0; i <= 1000; i++) {
      now.t++;
      rl.hit(`k${i}`);
    }
    expect(rl.size()).toBeLessThanOrEqual(900); // trimmed to 90%, not by one
  });
});
