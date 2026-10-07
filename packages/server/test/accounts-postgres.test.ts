import { describe, expect, it } from "vitest";
import { PASSWORD, bootAccounts } from "./helpers.js";

/**
 * Accounts mode with the account database on Postgres (PGlite, in process), through the real HTTP server: the same
 * journeys as on SQLite. To run every accounts-mode test this way: MOCKDATA_TEST_ACCOUNTS_ENGINE=postgres npm test.
 */
describe("accounts mode on Postgres", () => {
  it("signs up, verifies, signs in and out, and keeps each user's data apart", async () => {
    const app = await bootAccounts({ engine: "postgres" });
    expect(app.accounts.db.dialect).toBe("postgres");
    const ann = await app.signUp("ann@example.com");
    const me = await app.as(ann).get("/api/auth/me");
    expect(me.json.user.email).toBe("ann@example.com");
    // A second sign-up with the same address changes nothing and still answers 202.
    expect((await app.post("/api/auth/register", { email: "ANN@example.com", password: PASSWORD })).status).toBe(202);
    const bob = await app.signUp("bob@example.com");
    expect((await app.as(bob).put("/api/file", { path: "bob.yaml", text: "tables: {}" })).status).toBe(200);
    expect((await app.as(ann).get("/api/files")).json.files).toEqual([]);
    expect((await app.as(ann).post("/api/auth/logout", {})).status).toBe(200);
    expect((await app.as(ann).get("/api/auth/me")).json.user).toBeNull();
    expect((await app.post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("makes, lists and revokes API keys, and stops at the per-user limit", async () => {
    const app = await bootAccounts({ engine: "postgres" });
    const cookie = await app.signUp("keys@example.com");
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => app.as(cookie).post("/api/auth/keys", { name: `k${i}` })));
    expect(made.filter((r) => r.status === 201)).toHaveLength(10);
    expect(made.filter((r) => r.status !== 201).every((r) => r.status === 400 || r.status === 409)).toBe(true);
    const list = (await app.as(cookie).get("/api/auth/keys")).json.keys as { id: number }[];
    expect(list).toHaveLength(10);
    expect((await app.as(cookie).post("/api/auth/keys/revoke", { id: list[0]!.id })).status).toBe(200);
    expect((await app.as(cookie).get("/api/auth/keys")).json.keys).toHaveLength(9);
  });

  it("resets a password with the emailed token and signs every session out", async () => {
    const app = await bootAccounts({ engine: "postgres" });
    const first = await app.signUp("reset@example.com");
    const before = app.sent.length;
    await app.post("/api/auth/forgot-password", { email: "reset@example.com" });
    await new Promise((r) => setTimeout(r, 20)); // mail is queued after the response
    const token = app.tokenOf(app.sent[before]!, "reset_token");
    const reset = await app.post("/api/auth/reset-password", { token, password: "An0ther$trongPassword" });
    expect(reset.status).toBe(200);
    expect((await app.as(first).get("/api/auth/me")).json.user).toBeNull();
    expect((await app.post("/api/auth/reset-password", { token, password: "Y3t$AnotherPassword" })).status).toBe(400);
  });
});
