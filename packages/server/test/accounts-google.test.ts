import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bootAccounts, PASSWORD } from "./helpers.js";

const GOOGLE = { clientId: "client-id-123", clientSecret: "client-secret-xyz" };

interface Profile {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/** A stand-in for Google's token and userinfo endpoints that records what it is sent. */
function fakeGoogle(profile: Profile = { sub: "g-1", email: "gina@example.com", email_verified: true, name: "Gina G", picture: "https://lh3.example/p.png" }, opts: { tokenStatus?: number; userinfoStatus?: number } = {}) {
  const tokenCalls: URLSearchParams[] = [];
  const userinfoCalls: { authorization: string | null }[] = [];
  const all: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    all.push(String(url));
    if (String(url) === "https://oauth2.googleapis.com/token") {
      tokenCalls.push(new URLSearchParams(String(init?.body)));
      if ((opts.tokenStatus ?? 200) !== 200) return new Response("{}", { status: opts.tokenStatus });
      return new Response(JSON.stringify({ access_token: "ya29.access", token_type: "Bearer" }), { status: 200 });
    }
    if (String(url) === "https://openidconnect.googleapis.com/v1/userinfo") {
      userinfoCalls.push({ authorization: new Headers(init?.headers).get("authorization") });
      if ((opts.userinfoStatus ?? 200) !== 200) return new Response("{}", { status: opts.userinfoStatus });
      return new Response(JSON.stringify(profile), { status: 200 });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
  return { fetchFn, tokenCalls, userinfoCalls, all };
}

const b64url = (buf: Buffer) => buf.toString("base64url");

async function begin(app: Awaited<ReturnType<typeof bootAccounts>>) {
  const r = await fetch(`${app.url}/api/auth/google`, { redirect: "manual" });
  const location = new URL(r.headers.get("location")!);
  const oauthCookie = r.headers.getSetCookie().find((c) => c.startsWith("mockdata_oauth="))!;
  return { response: r, location, state: location.searchParams.get("state")!, challenge: location.searchParams.get("code_challenge")!, cookie: oauthCookie.split(";")[0]!, setCookie: oauthCookie };
}

async function callback(app: Awaited<ReturnType<typeof bootAccounts>>, params: Record<string, string>, cookie?: string) {
  const qs = new URLSearchParams(params).toString();
  return fetch(`${app.url}/api/auth/google/callback?${qs}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

const sessionCookieOf = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("mockdata_session=") && !/Max-Age=0/.test(c));

describe("Google sign-in: starting", () => {
  it("redirects to Google with PKCE, a state, the right redirect address, and a short-lived nonce cookie", async () => {
    const app = await bootAccounts({ google: GOOGLE });
    const s = await begin(app);
    expect(s.response.status).toBe(302);
    expect(s.location.origin + s.location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(s.location.searchParams.get("client_id")).toBe(GOOGLE.clientId);
    expect(s.location.searchParams.get("redirect_uri")).toBe("https://mockdata.example.com/api/auth/google/callback");
    expect(s.location.searchParams.get("response_type")).toBe("code");
    expect(s.location.searchParams.get("scope")).toBe("openid email profile");
    expect(s.location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.state).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(s.setCookie).toMatch(/HttpOnly/);
    expect(s.setCookie).toMatch(/SameSite=Lax/);
    expect(s.setCookie).toMatch(/Secure/);
    expect(s.setCookie).toMatch(/Max-Age=600/);
    expect(s.response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(s.location.href).not.toContain(GOOGLE.clientSecret);
  });

  it("answers 501 when Google sign-in is not configured, and reports that to the page", async () => {
    const app = await bootAccounts();
    const r = await fetch(`${app.url}/api/auth/google`, { redirect: "manual" });
    expect(r.status).toBe(501);
    expect((await app.get("/api/auth/me")).json.auth.googleConfigured).toBe(false);
    expect((await (await bootAccounts({ google: GOOGLE })).get("/api/auth/me")).json.auth.googleConfigured).toBe(true);
  });
});

describe("Google sign-in: coming back", () => {
  it("signs a new user in, sends the PKCE verifier and secret server-side only, and reuses the account next time", async () => {
    const google = fakeGoogle();
    const app = await bootAccounts({ google: GOOGLE, fetch: google.fetchFn });
    const s = await begin(app);
    const r = await callback(app, { code: "auth-code-1", state: s.state }, s.cookie);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const session = sessionCookieOf(r)!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(r.headers.getSetCookie().join()).toMatch(/mockdata_oauth=;.*Max-Age=0/); // the nonce cookie is spent

    expect(google.tokenCalls).toHaveLength(1);
    const form = google.tokenCalls[0]!;
    expect(form.get("code")).toBe("auth-code-1");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe(GOOGLE.clientId);
    expect(form.get("client_secret")).toBe(GOOGLE.clientSecret);
    expect(form.get("redirect_uri")).toBe("https://mockdata.example.com/api/auth/google/callback");
    expect(b64url(createHash("sha256").update(form.get("code_verifier")!).digest())).toBe(s.challenge); // PKCE: the verifier matches the challenge Google saw
    expect(google.userinfoCalls).toEqual([{ authorization: "Bearer ya29.access" }]);

    const me = await app.as(session.split(";")[0]!).get("/api/auth/me");
    expect(me.json.user).toMatchObject({ email: "gina@example.com", displayName: "Gina G", avatarUrl: "https://lh3.example/p.png" });

    // a second sign-in is the same account
    const s2 = await begin(app);
    const r2 = await callback(app, { code: "auth-code-2", state: s2.state }, s2.cookie);
    const me2 = await app.as(sessionCookieOf(r2)!.split(";")[0]!).get("/api/auth/me");
    expect(me2.json.user.id).toBe(me.json.user.id);
  });

  it("gives the Google user a private folder, no password to change, and a separate account from the same address by email", async () => {
    const google = fakeGoogle();
    const app = await bootAccounts({ google: GOOGLE, fetch: google.fetchFn });
    const s = await begin(app);
    const r = await callback(app, { code: "c", state: s.state }, s.cookie);
    const gina = app.as(sessionCookieOf(r)!.split(";")[0]!);
    expect((await gina.put("/api/file", { path: "g.yaml", text: "tables: {}\n" })).status).toBe(200);
    const change = await gina.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "N3w$ecretPassw0rd!" });
    expect(change.status).toBe(400);
    expect(change.json.error.message).toMatch(/no password/i);
    // the same address registered with a password is a different account with its own folder
    const emailCookie = await app.signUp("gina@example.com");
    expect((await app.as(emailCookie).get("/api/files")).json.files).not.toContain("g.yaml");
  });

  it("refuses every bad return without signing anyone in or calling Google", async () => {
    const google = fakeGoogle();
    const app = await bootAccounts({ google: GOOGLE, fetch: google.fetchFn });
    const s = await begin(app);
    const expectRefused = async (r: Response) => {
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/?error=google_failed");
      expect(sessionCookieOf(r)).toBeUndefined();
    };
    await expectRefused(await callback(app, { code: "c", state: "not-the-state" }, s.cookie)); // unknown state
    await expectRefused(await callback(app, { code: "c", state: s.state })); // no nonce cookie (another browser)
    await expectRefused(await callback(app, { code: "c", state: s.state }, "mockdata_oauth=wrong-nonce")); // someone else's nonce
    await expectRefused(await callback(app, { state: s.state }, s.cookie)); // no code
    await expectRefused(await callback(app, { error: "access_denied", state: s.state }, s.cookie)); // the user said no
    expect(google.all).toEqual([]); // none of that reached Google
    // and the state still works for the genuine browser, once
    expect((await callback(app, { code: "c", state: s.state }, s.cookie)).headers.get("location")).toBe("/");
    await expectRefused(await callback(app, { code: "c", state: s.state }, s.cookie)); // replay
  });

  it("refuses unverified, missing or malformed Google profiles, and failing Google endpoints", async () => {
    const cases: [string, Profile, { tokenStatus?: number; userinfoStatus?: number }][] = [
      ["unverified email", { sub: "g", email: "a@example.com", email_verified: false }, {}],
      ["no email_verified", { sub: "g", email: "a@example.com" }, {}],
      ["no email", { sub: "g", email_verified: true }, {}],
      ["no sub", { email: "a@example.com", email_verified: true }, {}],
      ["empty sub", { sub: "", email: "a@example.com", email_verified: true }, {}],
      ["token endpoint down", { sub: "g", email: "a@example.com", email_verified: true }, { tokenStatus: 400 }],
      ["userinfo down", { sub: "g", email: "a@example.com", email_verified: true }, { userinfoStatus: 500 }],
    ];
    for (const [label, profile, opts] of cases) {
      const app = await bootAccounts({ google: GOOGLE, fetch: fakeGoogle(profile, opts).fetchFn });
      const s = await begin(app);
      const r = await callback(app, { code: "c", state: s.state }, s.cookie);
      expect(r.headers.get("location"), label).toBe("/?error=google_failed");
      expect(sessionCookieOf(r), label).toBeUndefined();
    }
  });

  it("never puts the code, tokens or secret in a redirect, and ignores unsafe profile fields", async () => {
    const google = fakeGoogle({ sub: "g-9", email: "x@example.com", email_verified: true, name: "N".repeat(500), picture: "javascript:alert(1)" });
    const app = await bootAccounts({ google: GOOGLE, fetch: google.fetchFn });
    const s = await begin(app);
    const r = await callback(app, { code: "super-secret-code", state: s.state }, s.cookie);
    const seen = [r.headers.get("location"), ...r.headers.getSetCookie().filter((c) => c.startsWith("mockdata_oauth"))].join(" ");
    expect(seen).not.toMatch(/super-secret-code|ya29|client-secret-xyz/);
    const me = await app.as(sessionCookieOf(r)!.split(";")[0]!).get("/api/auth/me");
    expect(me.json.user.avatarUrl).toBeNull(); // only https pictures are kept
    expect(me.json.user.displayName.length).toBeLessThanOrEqual(100);
  });
});
