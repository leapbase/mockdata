import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountsDb, QuotaError, RateLimiter, RunGate, SqliteAuthAdapter, UsageStore, assertWithinDiskQuota, directoryBytes, limitsFromEnv } from "../src/index.js";

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
    expect(limitsFromEnv({})).toEqual({ llmDailyRows: 2000, maxRuns: 4, userQuotaBytes: 50 * 1024 * 1024, maxRows: 200_000 });
    expect(limitsFromEnv({ MOCKDATA_LLM_DAILY_ROWS: "10", MOCKDATA_MAX_RUNS: "1", MOCKDATA_USER_QUOTA_MB: "2", MOCKDATA_MAX_ROWS: "500" })).toEqual({
      llmDailyRows: 10, maxRuns: 1, userQuotaBytes: 2 * 1024 * 1024, maxRows: 500,
    });
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

describe("UsageStore", () => {
  it("counts LLM rows per user per UTC day", async () => {
    const accounts = await AccountsDb.open(":memory:");
    const adapter = new SqliteAuthAdapter(accounts);
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
});

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
