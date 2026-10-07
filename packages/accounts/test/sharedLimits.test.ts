import { expect, it } from "vitest";
import { describe } from "vitest";
import { AccountsDb, SqlAuthAdapter, SqlRateLimiter, SqlRunSlots, pgPoolDriver, purgeRateEvents } from "../src/index.js";
import { eachEngine, liveSchema, openDb } from "./engines.js";

async function users(db: AccountsDb, n: number): Promise<number[]> {
  const adapter = new SqlAuthAdapter(db);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await adapter.createUserWithPasswordIdentity({ normalizedEmail: `s${i}@example.com`, passwordHash: "h", displayName: `s${i}` })).id);
  return out;
}

eachEngine(() => {
  describe("SqlRateLimiter", () => {
    it("allows max events per window, then refuses with a retry time, and forgets them as the window slides", async () => {
      const db = await openDb();
      const clock = { t: 1_000_000 };
      const limit = new SqlRateLimiter(db, "login", { max: 3, windowMs: 60_000, now: () => clock.t });
      for (let i = 0; i < 3; i++) expect(await limit.hit("10.0.0.1")).toBe(true);
      expect(await limit.hit("10.0.0.1")).toBe(false);
      expect(await limit.isLimited("10.0.0.1")).toBe(true);
      expect(await limit.retryAfterSeconds("10.0.0.1")).toBe(60);
      expect(await limit.hit("10.0.0.2")).toBe(true); // another key has its own budget
      clock.t += 30_000;
      expect(await limit.retryAfterSeconds("10.0.0.1")).toBe(30);
      clock.t += 30_001;
      expect(await limit.isLimited("10.0.0.1")).toBe(false);
      expect(await limit.hit("10.0.0.1")).toBe(true);
    });

    it("records failures unconditionally, resets a key, and keeps limiters apart", async () => {
      const db = await openDb();
      const fails = new SqlRateLimiter(db, "fails", { max: 2, windowMs: 60_000 });
      const other = new SqlRateLimiter(db, "other", { max: 2, windowMs: 60_000 });
      await fails.record("ann@example.com");
      await fails.record("ann@example.com");
      await fails.record("ann@example.com");
      expect(await fails.isLimited("ann@example.com")).toBe(true);
      expect(await other.isLimited("ann@example.com")).toBe(false);
      await fails.reset("ann@example.com");
      expect(await fails.isLimited("ann@example.com")).toBe(false);
    });

    it("stores only a hash of each key, and purges old events", async () => {
      const db = await openDb();
      const clock = { t: 5_000_000 };
      const limit = new SqlRateLimiter(db, "signup", { max: 5, windowMs: 60_000, now: () => clock.t });
      await limit.hit("203.0.113.9");
      await limit.hit("bob@example.com");
      const stored = JSON.stringify(await db.all("select * from rate_events"));
      expect(stored).not.toContain("203.0.113.9");
      expect(stored).not.toContain("bob@example.com");
      expect(await purgeRateEvents(db, 60_000, clock.t + 120_000)).toBe(2);
      expect(await db.all("select * from rate_events")).toEqual([]);
    });
  });

  describe("SqlRunSlots", () => {
    it("allows one run per user and a global maximum, and frees a slot on release", async () => {
      const db = await openDb();
      const [a, b, c] = await users(db, 3);
      const slots = new SqlRunSlots(db, 2);
      const ra = await slots.tryStart(a!);
      expect(ra).toBeTypeOf("function");
      expect(await slots.tryStart(a!)).toBeUndefined();
      const rb = await slots.tryStart(b!);
      expect(await slots.tryStart(c!)).toBeUndefined();
      ra!();
      ra!(); // twice is harmless
      await new Promise((r) => setTimeout(r, 30)); // the release is written in the background
      const rc = await slots.tryStart(c!);
      expect(rc).toBeTypeOf("function");
      rb!();
      rc!();
    });

    it("frees the slots of a server that stopped renewing, and a late release cannot free a newer slot", async () => {
      const db = await openDb();
      const [a] = await users(db, 1);
      const clock = { t: 10_000_000 };
      const dead = new SqlRunSlots(db, 1, { leaseMs: 60_000, now: () => clock.t });
      const stale = await dead.tryStart(a!);
      expect(stale).toBeTypeOf("function");
      clock.t += 61_000; // its lease ran out without renewal
      const alive = new SqlRunSlots(db, 1, { leaseMs: 60_000, now: () => clock.t });
      const fresh = await alive.tryStart(a!);
      expect(fresh).toBeTypeOf("function");
      stale!(); // the dead server's late release must not free the new run's slot
      await new Promise((r) => setTimeout(r, 30));
      expect(await alive.tryStart(a!)).toBeUndefined();
      fresh!();
    });
  });
});

/** Several servers (separate connection pools) racing on one limit and on the run slots. */
const LIVE = process.env.MOCKDATA_TEST_POSTGRES_URL;
describe.skipIf(!LIVE)("shared limits across servers (live Postgres)", () => {
  async function servers(n: number): Promise<AccountsDb[]> {
    const url = await liveSchema("md_test_limits");
    const first = await AccountsDb.openPostgres(await pgPoolDriver(url, { max: 5 }));
    return [first, ...(await Promise.all(Array.from({ length: n - 1 }, async () => AccountsDb.openPostgres(await pgPoolDriver(url, { max: 5 })))))];
  }

  it("counts one limit across three servers hit at the same moment", async () => {
    const dbs = await servers(3);
    const limiters = dbs.map((db) => new SqlRateLimiter(db, "loginIp", { max: 10, windowMs: 60_000 }));
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => limiters[i % 3]!.hit("198.51.100.7")));
    expect(results.filter(Boolean)).toHaveLength(10);
    await Promise.all(dbs.map((d) => d.close()));
  });

  it("enforces the global run maximum across servers", async () => {
    const dbs = await servers(2);
    const ids = await users(dbs[0]!, 10);
    const slots = dbs.map((db) => new SqlRunSlots(db, 4));
    const got = await Promise.all(ids.map((id, i) => slots[i % 2]!.tryStart(id)));
    expect(got.filter(Boolean)).toHaveLength(4);
    for (const release of got) release?.();
    await new Promise((r) => setTimeout(r, 50));
    await Promise.all(dbs.map((d) => d.close()));
  });
});
