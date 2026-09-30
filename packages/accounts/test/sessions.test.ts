import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountsDb, OAuthStates, SessionStore, SqliteAuthAdapter, clearCookie, oauthCookieName, parseCookies, serializeCookie, sessionCookieName } from "../src/index.js";

async function setup(now = { t: 1_000_000 }) {
  const accounts = await AccountsDb.open(":memory:");
  const adapter = new SqliteAuthAdapter(accounts);
  const user = await adapter.createUserWithPasswordIdentity({ normalizedEmail: "ann@example.com", passwordHash: "h", displayName: "ann" });
  return { accounts, user, now, sessions: new SessionStore(accounts, { ttlSeconds: 1000, slideAfterSeconds: 100, now: () => now.t }) };
}

describe("SessionStore", () => {
  it("issues long random ids, stores only their hash, and resolves them to the user", async () => {
    const { accounts, sessions, user } = await setup();
    const s = await sessions.create(user.id);
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await accounts.gated(() => accounts.raw.prepare("select id_hash from sessions").all() as { id_hash: string }[]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id_hash).toBe(createHash("sha256").update(s.id).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(s.id);
    expect((await sessions.lookup(s.id))?.id).toBe(user.id);
    expect(await sessions.lookup("nope")).toBeNull();
    expect(await sessions.lookup("")).toBeNull();
  });

  it("expires sessions, slides the expiry on use, and can destroy them", async () => {
    const { sessions, user, now } = await setup();
    const s = await sessions.create(user.id);
    now.t += 900;
    expect(await sessions.lookup(s.id)).not.toBeNull(); // still valid, expiry slides forward
    now.t += 900;
    expect(await sessions.lookup(s.id)).not.toBeNull(); // would have expired without sliding
    now.t += 1001;
    expect(await sessions.lookup(s.id)).toBeNull();
    const t = await sessions.create(user.id);
    await sessions.destroy(t.id);
    expect(await sessions.lookup(t.id)).toBeNull();
    await sessions.create(user.id);
    now.t += 5000;
    expect(await sessions.purgeExpired()).toBe(2); // the long-expired first session plus the one just made
  });
});

describe("OAuthStates", () => {
  it("consumes a state once, only with the matching nonce, and not after expiry", async () => {
    const now = { t: 1000 };
    const accounts = await AccountsDb.open(":memory:");
    const states = new OAuthStates(accounts, { ttlSeconds: 600, now: () => now.t });
    const a = await states.create("verifier-a");
    expect(await states.consume(a.state, "wrong-nonce")).toBeNull(); // wrong nonce does not burn it...
    expect(await states.consume(a.state, a.nonce)).toBe("verifier-a");
    expect(await states.consume(a.state, a.nonce)).toBeNull(); // single use
    const b = await states.create("verifier-b");
    now.t += 601;
    expect(await states.consume(b.state, b.nonce)).toBeNull();
    expect(await states.consume("unknown", "x")).toBeNull();
  });
});

describe("cookies", () => {
  it("parses a Cookie header and serialises safe attributes", () => {
    expect(parseCookies("a=1; mockdata_session=abc%3D; b=two=2")).toEqual({ a: "1", mockdata_session: "abc=", b: "two=2" });
    expect(parseCookies(undefined)).toEqual({});
    const c = serializeCookie("mockdata_session", "abc", { maxAgeSeconds: 60, secure: true });
    expect(c).toBe("mockdata_session=abc; Max-Age=60; Path=/; HttpOnly; SameSite=Lax; Secure");
    expect(serializeCookie("x", "y", { maxAgeSeconds: 5, secure: false })).not.toMatch(/Secure/);
    expect(clearCookie("mockdata_session", true)).toMatch(/Max-Age=0.*Secure/);
    expect(() => serializeCookie("bad name", "v", { maxAgeSeconds: 1, secure: false })).toThrow();
  });
});

describe("session lifetime and cookie names", () => {
  it("ends a session at an absolute age even if it is used constantly", async () => {
    const now = { t: 1_000_000 };
    const accounts = await AccountsDb.open(":memory:");
    const adapter = new SqliteAuthAdapter(accounts);
    const user = await adapter.createUserWithPasswordIdentity({ normalizedEmail: "a@example.com", passwordHash: "h", displayName: "a" });
    const sessions = new SessionStore(accounts, { ttlSeconds: 1000, slideAfterSeconds: 10, absoluteSeconds: 3000, now: () => now.t });
    const s = await sessions.create(user.id);
    for (let i = 0; i < 5; i++) {
      now.t += 500; // used every 500 s, so the sliding expiry never lapses
      expect(await sessions.lookup(s.id)).not.toBeNull();
    }
    now.t += 600; // 3100 s after creation: past the absolute limit
    expect(await sessions.lookup(s.id)).toBeNull();
  });

  it("uses the __Host- prefix when cookies are Secure (a sibling subdomain cannot plant them)", () => {
    expect(sessionCookieName(true)).toBe("__Host-mockdata_session");
    expect(sessionCookieName(false)).toBe("mockdata_session");
    expect(oauthCookieName(true)).toBe("__Host-mockdata_oauth");
    expect(oauthCookieName(false)).toBe("mockdata_oauth");
    expect(serializeCookie(sessionCookieName(true), "v", { maxAgeSeconds: 1, secure: true })).toMatch(/^__Host-mockdata_session=v; .*Path=\/.*Secure/);
  });

  it("purges expired OAuth states when a new one is created, so the table cannot grow forever", async () => {
    const now = { t: 1000 };
    const accounts = await AccountsDb.open(":memory:");
    const states = new OAuthStates(accounts, { ttlSeconds: 600, now: () => now.t });
    for (let i = 0; i < 20; i++) await states.create("v");
    now.t += 601;
    await states.create("v");
    const { n } = (await accounts.gated(() => accounts.raw.prepare("select count(*) as n from oauth_states").get())) as { n: number };
    expect(n).toBe(1);
  });
});
