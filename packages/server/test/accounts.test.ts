import { describe, expect, it } from "vitest";
import { bootAccounts, boot, PASSWORD, rawRequest } from "./helpers.js";

describe("accounts: sign up, verify, sign in", () => {
  it("reports accounts on, and nobody signed in", async () => {
    const { get } = await bootAccounts();
    const r = await get("/api/auth/me");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ user: null, auth: { accountsEnabled: true, googleConfigured: false, emailEnabled: true } });
  });

  it("reports accounts off in local mode, so the UI skips the login screen", async () => {
    const { get } = await boot();
    expect((await get("/api/auth/me")).json).toEqual({ user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } });
  });

  it("register answers 202 for a new address and for one already registered, and mails a link to the address", async () => {
    const { post, sent, signUp } = await bootAccounts();
    const first = await post("/api/auth/register", { email: "Ann@Example.com", password: PASSWORD });
    const again = await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD }); // still unverified: a fresh link
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(again.raw).toBe(first.raw);
    expect(first.json).toEqual({ pending: true });
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.to === "ann@example.com")).toBe(true);
    await signUp("bob@example.com");
    const before = sent.length;
    const verified = await post("/api/auth/register", { email: "bob@example.com", password: PASSWORD }); // verified: same answer, no mail
    expect(verified.raw).toBe(first.raw);
    expect(sent).toHaveLength(before);
    expect(sent[0]!.to).toBe("ann@example.com");
    expect(sent[0]!.subject).toMatch(/verify/i);
    expect(sent[0]!.text).toContain("https://mockdata.example.com/app#verify_token=");
  });

  it("rejects a bad email, a weak password and an oversized body without echoing input", async () => {
    const { post } = await bootAccounts();
    const badEmail = await post("/api/auth/register", { email: "not-an-email", password: PASSWORD });
    expect(badEmail.status).toBe(400);
    expect(badEmail.raw).not.toContain("not-an-email");
    const weak = await post("/api/auth/register", { email: "a@example.com", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.raw).not.toContain("short\"");
    const big = await post("/api/auth/register", { email: "a@example.com", password: "x".repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it("refuses sign-in before the email is verified, with no difference between wrong password and unknown email", async () => {
    const { post } = await bootAccounts();
    await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    const unverified = await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD });
    expect(unverified.status).toBe(403);
    expect(unverified.json.error.code).toBe("email_unverified");
    const wrong = await post("/api/auth/login", { email: "ann@example.com", password: "Wr0ng$ecretPassw0rd" });
    const unknown = await post("/api/auth/login", { email: "nobody@example.com", password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.raw).toBe(wrong.raw);
    expect(wrong.headers.getSetCookie()).toEqual([]);
  });

  it("links to a confirm screen through the URL fragment, so the token never reaches a server log or a mail scanner", async () => {
    const { post, sent, linkIn } = await bootAccounts();
    await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    const link = new URL(linkIn(sent[0]!));
    expect(link.origin).toBe("https://mockdata.example.com");
    expect(link.pathname).toBe("/app");
    expect(link.search).toBe("");
    expect(link.hash).toMatch(/^#verify_token=[A-Za-z0-9_-]{40,}$/);
  });

  it("verifies only when the mailbox owner also gives the sign-up password, then signs them in; the link works once", async () => {
    const { post, sent, tokenOf, as, cookieOf } = await bootAccounts();
    await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    const token = tokenOf(sent[0]!);
    const wrong = await post("/api/auth/verify-email", { token, password: "Wr0ng$ecretPassw0rd" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe("verify_password");
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect((await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).json.error.code).toBe("email_unverified"); // a wrong guess did not verify anything
    const ok = await post("/api/auth/verify-email", { token, password: PASSWORD }); // and did not burn the link
    expect(ok.status).toBe(200);
    expect(ok.json.user.email).toBe("ann@example.com");
    expect((await as(cookieOf(ok.headers)).get("/api/auth/me")).json.user.email).toBe("ann@example.com");
    const replay = await post("/api/auth/verify-email", { token, password: PASSWORD });
    expect(replay.status).toBe(400);
    expect(replay.json.error.code).toBe("verify_invalid");
    expect((await post("/api/auth/verify-email", { token: "nope", password: PASSWORD })).json.error.code).toBe("verify_invalid");
  });

  it("no longer verifies on a plain GET (a mail scanner opening the link changes nothing)", async () => {
    const { get, post, sent, tokenOf } = await bootAccounts();
    await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    expect((await get(`/api/auth/verify-email?token=${tokenOf(sent[0]!)}`)).status).toBe(404);
    expect((await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).status).toBe(403); // still unverified
  });

  it("signs in with a session cookie (HttpOnly, SameSite=Lax, Secure), which me and logout honour", async () => {
    const { post, get, signUp, as, call } = await bootAccounts();
    const login = await (async () => {
      await signUp("ann@example.com");
      return post("/api/auth/login", { email: "ann@example.com", password: PASSWORD });
    })();
    expect(login.status).toBe(200);
    expect(login.json.user).toMatchObject({ email: "ann@example.com", displayName: "ann" });
    expect(login.json.user.dirId).toBeUndefined(); // the private folder name never leaves the server
    const setCookie = login.headers.getSetCookie().find((c) => /^(__Host-)?mockdata_session=/.test(c))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/Path=\//);
    const cookie = setCookie.split(";")[0]!;
    expect((await as(cookie).get("/api/auth/me")).json.user.email).toBe("ann@example.com");
    expect((await get("/api/auth/me")).json.user).toBeNull();
    const out = await as(cookie).post("/api/auth/logout", {});
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join()).toMatch(/__Host-mockdata_session=;.*Max-Age=0/);
    expect((await as(cookie).get("/api/auth/me")).json.user).toBeNull(); // the session is gone server-side
    void call;
  });

  it("omits Secure for a plain-http localhost public URL (development)", async () => {
    const { post, signUp } = await bootAccounts({ publicUrl: "http://localhost:4747" });
    await signUp("ann@example.com");
    const login = await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD });
    expect(login.headers.getSetCookie().find((c) => /^(__Host-)?mockdata_session=/.test(c))).not.toMatch(/Secure/);
  });

  it("refuses sign-up when no email can be sent", async () => {
    const { post, sent } = await bootAccounts({ emailEnabled: false });
    const r = await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    expect(r.status).toBe(503);
    expect(sent).toHaveLength(0);
    expect((await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).status).toBe(401);
    expect((await (await bootAccounts({ emailEnabled: false })).get("/api/auth/me")).json.auth.emailEnabled).toBe(false);
  });
});

describe("accounts: the session is the only gate", () => {
  it("answers API calls without a session with 401, even from localhost", async () => {
    const { get, post } = await bootAccounts();
    for (const r of [await get("/api/files"), await get("/api/config"), await post("/api/validate", { text: "x" })]) {
      expect(r.status).toBe(401);
      expect(r.json.error.message).toMatch(/sign in/i);
    }
  });

  it("lets a signed-in user through, and serves the page itself without one", async () => {
    const { signUp, as, get } = await bootAccounts();
    const cookie = await signUp("ann@example.com");
    expect((await as(cookie).get("/api/files")).status).toBe(200);
    expect((await get("/")).status).not.toBe(401); // the static shell carries the login screen
  });

  it("ignores a forged or garbage session cookie", async () => {
    const { call } = await bootAccounts();
    for (const cookie of ["__Host-mockdata_session=", "__Host-mockdata_session=abc", `__Host-mockdata_session=${"A".repeat(43)}`, "mockdata_session=abc", "mockdata_token=whatever"]) {
      expect((await call("GET", "/api/files", undefined, { cookie })).status, cookie).toBe(401);
    }
  });

  it("accepts the public host name and refuses other names; sends HSTS for an https URL", async () => {
    const { url } = await bootAccounts();
    const good = await rawRequest(url, "/api/auth/me", { host: "mockdata.example.com" });
    expect(good.status).toBe(200);
    expect((await rawRequest(url, "/api/auth/me", { host: "evil.example" })).status).toBe(403);
    const res = await fetch(`${url}/api/auth/me`);
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    const dev = await bootAccounts({ publicUrl: "http://localhost:4747" });
    expect((await fetch(`${dev.url}/api/auth/me`)).headers.get("strict-transport-security")).toBeNull();
  });

  it("is not opened by the old shared token or a loopback peer", async () => {
    const { call } = await bootAccounts();
    expect((await call("GET", "/api/files", undefined, { authorization: "Bearer anything-at-all-0123456789" })).status).toBe(401);
  });
});

describe("accounts: rate limits", () => {
  it("blocks a mailbox after repeated failed sign-ins, even with the right password", async () => {
    const { post, signUp } = await bootAccounts();
    await signUp("ann@example.com");
    for (let i = 0; i < 10; i++) {
      expect((await post("/api/auth/login", { email: "ann@example.com", password: "Wr0ng$ecretPassw0rd" })).status).toBe(401);
    }
    const blocked = await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("limits sign-ups per address", async () => {
    const { post } = await bootAccounts();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post("/api/auth/register", { email: `u${i}@example.com`, password: PASSWORD })).status);
    expect(codes.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it("uses the last X-Forwarded-For entry only when told to trust the proxy, and only from loopback", async () => {
    const off = await bootAccounts({ trustProxy: false });
    for (let i = 0; i < 6; i++) await off.call("POST", "/api/auth/register", { email: `a${i}@example.com`, password: PASSWORD }, { "x-forwarded-for": `203.0.113.${i}` });
    expect((await off.call("POST", "/api/auth/register", { email: "z@example.com", password: PASSWORD }, { "x-forwarded-for": "203.0.113.99" })).status).toBe(429); // header ignored: one client
    const on = await bootAccounts({ trustProxy: true });
    for (let i = 0; i < 6; i++) await on.call("POST", "/api/auth/register", { email: `a${i}@example.com`, password: PASSWORD }, { "x-forwarded-for": "198.51.100.1, 203.0.113.7" });
    expect((await on.call("POST", "/api/auth/register", { email: "z@example.com", password: PASSWORD }, { "x-forwarded-for": "198.51.100.1, 203.0.113.8" })).status).toBe(202); // different last hop
    expect((await on.call("POST", "/api/auth/register", { email: "y@example.com", password: PASSWORD }, { "x-forwarded-for": "9.9.9.9, 203.0.113.7" })).status).toBe(429); // same last hop: spoofed first entry does not help
  });
});

describe("accounts: passwords", () => {
  it("forgot-password answers the same for known and unknown emails and mails only the known", async () => {
    const { post, signUp, sent } = await bootAccounts();
    await signUp("ann@example.com");
    const before = sent.length;
    const known = await post("/api/auth/forgot-password", { email: "ann@example.com" });
    const unknown = await post("/api/auth/forgot-password", { email: "nobody@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.raw).toBe(known.raw);
    expect(known.json).toEqual({ ok: true });
    expect(sent.length - before).toBe(1);
    expect(sent.at(-1)!.to).toBe("ann@example.com");
    expect(sent.at(-1)!.text).toMatch(/\/app#reset_token=/); // a fragment never reaches a proxy log or a Referer header
  });

  it("resets a password with the emailed token: signs out everywhere, signs in fresh, token works once", async () => {
    const { post, signUp, as, sent, cookieOf } = await bootAccounts();
    const oldCookie = await signUp("ann@example.com");
    await post("/api/auth/forgot-password", { email: "ann@example.com" });
    const token = new URL(sent.at(-1)!.text!.match(/https?:\/\/[^\s]+/)![0]).hash.replace("#reset_token=", "");
    const reset = await post("/api/auth/reset-password", { token, password: "N3w$ecretPassw0rd!" });
    expect(reset.status).toBe(200);
    expect(reset.json.user.email).toBe("ann@example.com");
    expect((await as(oldCookie).get("/api/auth/me")).json.user).toBeNull(); // every old session revoked
    expect((await as(cookieOf(reset.headers)).get("/api/auth/me")).json.user.email).toBe("ann@example.com");
    expect((await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).status).toBe(401);
    expect((await post("/api/auth/login", { email: "ann@example.com", password: "N3w$ecretPassw0rd!" })).status).toBe(200);
    const replay = await post("/api/auth/reset-password", { token, password: "An0ther$ecretPassw0rd" });
    expect(replay.status).toBe(400);
    expect(replay.json.error.code).toBe("reset_invalid");
  });

  it("rejects a weak new password without burning the token", async () => {
    const { post, signUp, sent } = await bootAccounts();
    await signUp("ann@example.com");
    await post("/api/auth/forgot-password", { email: "ann@example.com" });
    const token = new URL(sent.at(-1)!.text!.match(/https?:\/\/[^\s]+/)![0]).hash.replace("#reset_token=", "");
    expect((await post("/api/auth/reset-password", { token, password: "weak" })).status).toBe(400);
    expect((await post("/api/auth/reset-password", { token, password: "N3w$ecretPassw0rd!" })).status).toBe(200);
  });

  it("changes a password only with the current one, and keeps only the current session", async () => {
    const { post, signUp, as } = await bootAccounts();
    const first = await signUp("ann@example.com");
    const second = (await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).headers
      .getSetCookie()
      .find((c) => /^(__Host-)?mockdata_session=/.test(c))!
      .split(";")[0]!;
    expect((await post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "N3w$ecretPassw0rd!" })).status).toBe(401); // needs a session
    expect((await as(first).post("/api/auth/change-password", { currentPassword: "Wr0ng$ecretPassw0rd", newPassword: "N3w$ecretPassw0rd!" })).status).toBe(400);
    expect((await as(first).post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "N3w$ecretPassw0rd!" })).status).toBe(200);
    expect((await as(first).get("/api/auth/me")).json.user.email).toBe("ann@example.com");
    expect((await as(second).get("/api/auth/me")).json.user).toBeNull();
    expect((await post("/api/auth/login", { email: "ann@example.com", password: "N3w$ecretPassw0rd!" })).status).toBe(200);
  });

  it("resend-verification mails an unverified account again and says nothing either way", async () => {
    const { post, sent } = await bootAccounts();
    await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    const r = await post("/api/auth/resend-verification", { email: "ann@example.com" });
    const unknown = await post("/api/auth/resend-verification", { email: "nobody@example.com" });
    expect(r.json).toEqual({ ok: true });
    expect(unknown.raw).toBe(r.raw);
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.to === "ann@example.com")).toBe(true);
  });
});
