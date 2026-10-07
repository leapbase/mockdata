import { PGlite } from "@electric-sql/pglite";
import { EmailTakenError } from "@mockdata/auth-kit";
import { describe, expect, it } from "vitest";
import { liveSchema } from "./engines.js";
import { AccountsDb, ApiKeyLimitError, ApiKeyStore, MAX_API_KEYS_PER_USER, SqlAuthAdapter, UsageStore, isUniqueViolation, numberPlaceholders, pgPoolDriver, pgliteDriver } from "../src/index.js";

describe("SQL helpers", () => {
  it("numbers placeholders for Postgres, leaving question marks in strings alone", () => {
    expect(numberPlaceholders("select * from t where a = ? and b = ? and c = '?'")).toBe("select * from t where a = $1 and b = $2 and c = '?'");
  });
  it("recognises a unique violation from either engine", () => {
    expect(isUniqueViolation({ errcode: 2067 })).toBe(true);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(new Error("UNIQUE constraint failed: users.dir_id"))).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
  });
});

describe("Postgres schema (PGlite)", () => {
  it("creates the schema once, opens it again without changes, and refuses one from a newer build", async () => {
    const pglite = new PGlite({ parsers: { 20: Number } });
    const keep = { ...pgliteDriver(pglite), close: async () => undefined };
    await AccountsDb.openPostgres(keep);
    const again = await AccountsDb.openPostgres(keep);
    expect((await again.one<{ version: number }>("select version from mockdata_schema"))?.version).toBe(3);
    expect((await again.all("select * from mockdata_schema")).length).toBe(1);
    await pglite.exec("update mockdata_schema set version = 99");
    await expect(AccountsDb.openPostgres(keep)).rejects.toThrow(/newer mockdata/);
    await pglite.close();
  });
});

/**
 * Against a real server with a real connection pool, where statements from different requests truly run at the same
 * time (PGlite has one connection). Set MOCKDATA_TEST_POSTGRES_URL to an empty, throwaway database to run these.
 */
const LIVE = process.env.MOCKDATA_TEST_POSTGRES_URL;
if (!LIVE) console.warn("postgres.test.ts: set MOCKDATA_TEST_POSTGRES_URL to run the live Postgres tests");

describe.skipIf(!LIVE)("Postgres (live server, connection pool)", () => {
  async function fresh(): Promise<AccountsDb> {
    return AccountsDb.openPostgres(await pgPoolDriver(await liveSchema("md_test_pg"), { max: 10 }));
  }

  it("migrates once when several servers start together", async () => {
    const url = await liveSchema("md_test_pg");
    const servers = await Promise.all([1, 2, 3].map(async () => AccountsDb.openPostgres(await pgPoolDriver(url, { max: 2 }))));
    expect((await servers[0]!.all("select * from mockdata_schema")).length).toBe(1);
    await Promise.all(servers.map((s) => s.close()));
  });

  it("never lets simultaneous reservations spend past a daily budget", async () => {
    const db = await fresh();
    const adapter = new SqlAuthAdapter(db);
    const users = await Promise.all([1, 2, 3, 4].map((i) => adapter.createUserWithPasswordIdentity({ normalizedEmail: `u${i}@example.com`, passwordHash: "h", displayName: `u${i}` })));
    const usage = new UsageStore(db, { today: () => "2026-10-07" });
    // 20 requests of 10 rows from four users at once; each user may spend 30, the server 100.
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => usage.reserveLlmRows(users[i % 4]!.id, 10, 30, 100)));
    const granted = results.filter((r) => r.ok).length;
    expect(granted).toBe(10); // 4 users x 3 would be 12, but the server stops at 100 rows
    expect(await usage.llmRowsAllUsersToday()).toBe(100);
    for (const u of users) expect(await usage.llmRowsToday(u.id)).toBeLessThanOrEqual(30);
    await db.close();
  });

  it("stops simultaneous key creation at the per-user limit", async () => {
    const db = await fresh();
    const user = await new SqlAuthAdapter(db).createUserWithPasswordIdentity({ normalizedEmail: "keys@example.com", passwordHash: "h", displayName: "keys" });
    const keys = new ApiKeyStore(db);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => keys.create(user.id, "k")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_API_KEYS_PER_USER);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ApiKeyLimitError);
    expect(await keys.list(user.id)).toHaveLength(MAX_API_KEYS_PER_USER);
    await db.close();
  });

  it("turns a duplicate sign-up into EmailTakenError, even when both arrive at once", async () => {
    const db = await fresh();
    const adapter = new SqlAuthAdapter(db);
    const tries = await Promise.allSettled(Array.from({ length: 5 }, () => adapter.createUserWithPasswordIdentity({ normalizedEmail: "same@example.com", passwordHash: "h", displayName: "same" })));
    expect(tries.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of tries) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(EmailTakenError);
    // The losing attempts left no half-made user behind.
    expect((await db.one<{ n: number }>("select count(*) as n from users"))?.n).toBe(1);
    await db.close();
  });
});
