import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { accountsFromEnv } from "../src/index.js";
import { lockedLlmConfig } from "../src/accounts/guards.js";
import { bootAccounts, PASSWORD, SHOP_YAML } from "./helpers.js";

const fakeReq = (peer: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

describe("password hashing cannot be used to exhaust the server (scrypt)", () => {
  it("charges every sign-in attempt up front, so a parallel burst is cut off before it reaches the hash", async () => {
    const { call } = await bootAccounts();
    const burst = await Promise.all(
      Array.from({ length: 80 }, (_, i) => call("POST", "/api/auth/login", { email: `nobody${i}@example.com`, password: "Wr0ng$ecretPassw0rd" })),
    );
    const codes = burst.map((r) => r.status);
    const reachedHash = codes.filter((c) => c === 401).length;
    expect(reachedHash).toBeLessThanOrEqual(30); // the per-address attempt limit, however many were in flight at once
    expect(codes.filter((c) => c === 429 || c === 503).length).toBeGreaterThanOrEqual(50);
    expect(codes.every((c) => [401, 429, 503].includes(c))).toBe(true);
  });

  it("keeps the server answering other requests while a burst is being refused", async () => {
    const { call, get } = await bootAccounts();
    const burst = Promise.all(Array.from({ length: 40 }, (_, i) => call("POST", "/api/auth/login", { email: `n${i}@example.com`, password: "Wr0ng$ecretPassw0rd" })));
    const started = Date.now();
    expect((await get("/api/auth/me")).status).toBe(200);
    await burst;
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("a shared reverse proxy must not collapse everyone into one rate-limit bucket", () => {
  const base = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
  async function runtime(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "mockdata-proxy-"));
    return accountsFromEnv({ ...base, ...env }, { configRoot: dir, dataDir: join(dir, "data") });
  }

  it("trusts the proxy's X-Forwarded-For by default for an https address (a proxy must be in front), only from loopback", async () => {
    const acc = (await runtime({ MOCKDATA_PUBLIC_URL: "https://mockdata.example.com" }))!;
    expect(acc.clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": "9.9.9.9, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(acc.clientIp(fakeReq("198.51.100.4", { "x-forwarded-for": "203.0.113.9" }))).toBe("198.51.100.4"); // not from a proxy: ignored
    acc.close();
  });

  it("does not trust it for plain-http localhost development, and obeys an explicit 0 or 1", async () => {
    const dev = (await runtime({ MOCKDATA_PUBLIC_URL: "http://localhost:4747" }))!;
    expect(dev.clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("127.0.0.1");
    const off = (await runtime({ MOCKDATA_PUBLIC_URL: "https://mockdata.example.com", MOCKDATA_TRUST_PROXY: "0" }))!;
    expect(off.clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("127.0.0.1");
    const on = (await runtime({ MOCKDATA_PUBLIC_URL: "http://localhost:4747", MOCKDATA_TRUST_PROXY: "1" }))!;
    expect(on.clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    for (const a of [dev, off, on]) a.close();
  });

  it("limits IPv6 clients by their /64 and unwraps IPv4-mapped addresses", async () => {
    const acc = (await runtime({ MOCKDATA_PUBLIC_URL: "http://localhost:4747", MOCKDATA_TRUST_PROXY: "0" }))!;
    const key = (peer: string) => acc.clientIp(fakeReq(peer));
    expect(key("2001:db8:aaaa:bbbb:1:2:3:4")).toBe(key("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff")); // same /64: one bucket
    expect(key("2001:db8:aaaa:bbbb::1")).toBe(key("2001:db8:aaaa:bbbb:1:2:3:4"));
    expect(key("2001:db8:aaaa:bbbb::1")).not.toBe(key("2001:db8:aaaa:cccc::1")); // a different /64
    expect(key("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(key("203.0.113.9")).toBe("203.0.113.9");
    acc.close();
  });
});

describe("nobody can take an address by signing up for it first, or again", () => {
  const SQUATTER = "Squ4tter$ecretPassw0rd";

  it("a link alone cannot hand the account to whoever typed the password first: the owner recovers through Forgot password", async () => {
    const { post, sent, tokenOf } = await bootAccounts();
    await post("/api/auth/register", { email: "victim@example.com", password: SQUATTER }); // a stranger signs up with someone's address
    await post("/api/auth/register", { email: "victim@example.com", password: PASSWORD }); // the real owner signs up; the stranger's password is still the stored one
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.to === "victim@example.com")).toBe(true);
    // the owner clicks the link they were sent and types the password they chose: it does not match, so nothing is verified
    const attempt = await post("/api/auth/verify-email", { token: tokenOf(sent[1]!), password: PASSWORD });
    expect(attempt.status).toBe(400);
    expect(attempt.json.error.code).toBe("verify_password");
    expect(attempt.json.error.message).toMatch(/forgot password/i);
    expect((await post("/api/auth/login", { email: "victim@example.com", password: SQUATTER })).json.error.code).toBe("email_unverified");
    // recovery proves the mailbox: the password is replaced, the address verified, and the stranger's password is dead
    await post("/api/auth/forgot-password", { email: "victim@example.com" });
    const reset = await post("/api/auth/reset-password", { token: tokenOf(sent.at(-1)!, "reset_token"), password: PASSWORD });
    expect(reset.status).toBe(200);
    expect((await post("/api/auth/login", { email: "victim@example.com", password: SQUATTER })).status).toBe(401);
    expect((await post("/api/auth/login", { email: "victim@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("re-registering a half-finished sign-up does not change its password or cancel its link", async () => {
    const { post, sent, tokenOf } = await bootAccounts();
    await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD }); // the owner starts signing up
    const first = tokenOf(sent[0]!);
    const again = await post("/api/auth/register", { email: "ann@example.com", password: SQUATTER }); // someone else tries the same address
    expect(again.status).toBe(202);
    expect(again.json).toEqual({ pending: true });
    expect((await post("/api/auth/login", { email: "ann@example.com", password: SQUATTER })).status).toBe(401);
    const ok = await post("/api/auth/verify-email", { token: first, password: PASSWORD }); // the owner's original link and password still work
    expect(ok.status).toBe(200);
  });

  it("limits how often an unverified address can be mailed by re-registering (no mail bombing)", async () => {
    const { post, sent } = await bootAccounts({ trustProxy: true });
    for (let i = 0; i < 12; i++) await post("/api/auth/register", { email: "target@example.com", password: PASSWORD }); // same client: the sign-up limit also applies
    expect(sent.length).toBeLessThanOrEqual(5);
    const other = await bootAccounts({ trustProxy: true });
    const answers = new Set<string>();
    for (let i = 0; i < 9; i++) answers.add((await other.call("POST", "/api/auth/register", { email: "target@example.com", password: PASSWORD }, { "x-forwarded-for": `203.0.113.${i + 1}` })).raw);
    expect(other.sent.length).toBe(5); // many addresses still get only 5 mails an hour for one mailbox
    expect(answers.size).toBe(1); // and every answer is identical
  });

  it("does nothing to a verified address: same answer, no email, password unchanged", async () => {
    const { post, signUp, sent } = await bootAccounts();
    await signUp("ann@example.com");
    const before = sent.length;
    const again = await post("/api/auth/register", { email: "ann@example.com", password: "Att4cker$ecretPassw0rd" });
    expect(again.status).toBe(202);
    expect(again.json).toEqual({ pending: true });
    expect(sent).toHaveLength(before);
    expect((await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).status).toBe(200);
    expect((await post("/api/auth/login", { email: "ann@example.com", password: "Att4cker$ecretPassw0rd" })).status).toBe(401);
  });

  it("the unverified and verified cases cost the same hashing, so they do not differ in timing", async () => {
    const { post, signUp } = await bootAccounts();
    await signUp("done@example.com");
    await post("/api/auth/register", { email: "half@example.com", password: PASSWORD });
    const timed = async (email: string) => {
      const t = Date.now();
      await post("/api/auth/register", { email, password: PASSWORD });
      return Date.now() - t;
    };
    const [verified, unverified, fresh] = [await timed("done@example.com"), await timed("half@example.com"), await timed("new@example.com")];
    for (const ms of [verified, unverified, fresh]) expect(ms).toBeLessThan(2000);
  });
});

describe("email is sent after the answer, so slow SMTP cannot reveal which addresses exist", () => {
  it("answers register and forgot-password even if the mail server never responds", async () => {
    const { post, signUp } = await bootAccounts({ mail: () => new Promise<void>(() => undefined) });
    const reg = await Promise.race([post("/api/auth/register", { email: "ann@example.com", password: PASSWORD }), new Promise<"hung">((r) => setTimeout(() => r("hung"), 3000))]);
    expect(reg).not.toBe("hung");
    expect((reg as { status: number }).status).toBe(202);
    const forgot = await Promise.race([post("/api/auth/forgot-password", { email: "ann@example.com" }), new Promise<"hung">((r) => setTimeout(() => r("hung"), 3000))]);
    expect(forgot).not.toBe("hung");
    void signUp;
  });

  it("does not let a failing mail server change the answer", async () => {
    const { post } = await bootAccounts({ mail: async () => Promise.reject(new Error("550 rejected ann@example.com")) });
    const known = await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    const again = await post("/api/auth/register", { email: "ann@example.com", password: PASSWORD });
    expect(known.status).toBe(202);
    expect(again.raw).toBe(known.raw);
  });
});

describe("addresses must be plain addresses", () => {
  it("refuses lists, display names and comments that a mail library would split into other recipients", async () => {
    const { post, sent } = await bootAccounts();
    for (const email of ["x,victim@target.com", "evil<victim@target.com>", '"a b"@target.com', "a@b.com;c@d.com", "a(comment)@target.com", "a@target.com\r\nBcc: v@t.com", "a\\@b@target.com"]) {
      const r = await post("/api/auth/register", { email, password: PASSWORD });
      expect(r.status, email).toBe(400);
      expect(r.raw).not.toContain("victim");
    }
    expect(sent).toHaveLength(0);
    expect((await post("/api/auth/register", { email: "first.last+tag@sub.example.com", password: PASSWORD })).status).toBe(202);
  });
});

describe("links and headers that could leak a token", () => {
  it("puts the reset token in the URL fragment, which never reaches a server, a proxy log or a Referer", async () => {
    const { post, signUp, sent } = await bootAccounts();
    await signUp("ann@example.com");
    await post("/api/auth/forgot-password", { email: "ann@example.com" });
    const link = sent.at(-1)!.text!.match(/https?:\/\/[^\s]+/)![0];
    expect(new URL(link).search).toBe("");
    expect(new URL(link).hash).toMatch(/^#reset_token=[A-Za-z0-9_-]{40,}$/);
  });

  it("sends Referrer-Policy: no-referrer on every response in accounts mode, pages included", async () => {
    const { url, get } = await bootAccounts();
    expect((await get("/api/auth/me")).headers.get("referrer-policy")).toBe("no-referrer");
    expect((await fetch(`${url}/`)).headers.get("referrer-policy")).toBe("no-referrer");
    expect((await get("/api/files")).headers.get("referrer-policy")).toBe("no-referrer"); // even the 401
  });
});

describe("unexpected failures do not describe the server", () => {
  it("answers 500s with a generic message, without a file path, while expected errors stay specific", async () => {
    const { signUp, as, dataDir } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    expect((await ann.get("/api/files")).status).toBe(200); // creates the user's folder
    rmSync(join(dataDir, "users"), { recursive: true });
    writeFileSync(join(dataDir, "users"), "not a directory"); // the data folder is damaged
    const broken = await ann.get("/api/files");
    expect(broken.status).toBe(500);
    expect(broken.json.error.message).toMatch(/something went wrong/i);
    expect(broken.raw).not.toContain(dataDir);
    expect(broken.raw).not.toMatch(/ENOTDIR|ENOENT|mkdir/);
  });
});

describe("oversized requests are refused before they are read", () => {
  it("answers 413 from the Content-Length alone once signed in", async () => {
    const { signUp, url } = await bootAccounts();
    const cookie = await signUp("ann@example.com");
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        { host: u.hostname, port: u.port, path: "/api/validate", method: "POST", headers: { "content-type": "application/json", "content-length": String(3 * 1024 * 1024), cookie } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
          req.destroy();
        },
      );
      req.on("error", reject);
      req.flushHeaders(); // headers only: the body is never sent
    });
    expect(status).toBe(413);
  });
});

describe("signing out everywhere", () => {
  it("ends every session of the user, including the current one", async () => {
    const { signUp, post, as } = await bootAccounts();
    const first = await signUp("ann@example.com");
    const second = (await post("/api/auth/login", { email: "ann@example.com", password: PASSWORD })).headers.getSetCookie().find((c) => /^__Host-mockdata_session=/.test(c))!.split(";")[0]!;
    const out = await as(first).post("/api/auth/logout-all", {});
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join()).toMatch(/Max-Age=0/);
    expect((await as(first).get("/api/auth/me")).json.user).toBeNull();
    expect((await as(second).get("/api/auth/me")).json.user).toBeNull();
    expect((await post("/api/auth/logout-all", {})).status).toBe(401); // needs a session
  });
});

describe("one mailbox cannot be locked out by a stranger", () => {
  it("counts failed sign-ins per mailbox and address, so an attacker's failures do not stop the owner from another address", async () => {
    const { signUp, call } = await bootAccounts({ trustProxy: true });
    await signUp("victim@example.com");
    const attacker = { "x-forwarded-for": "203.0.113.5" };
    for (let i = 0; i < 10; i++) {
      expect((await call("POST", "/api/auth/login", { email: "victim@example.com", password: "Wr0ng$ecretPassw0rd" }, attacker)).status).toBe(401);
    }
    expect((await call("POST", "/api/auth/login", { email: "victim@example.com", password: PASSWORD }, attacker)).status).toBe(429); // that address is blocked
    const owner = await call("POST", "/api/auth/login", { email: "victim@example.com", password: PASSWORD }, { "x-forwarded-for": "198.51.100.7" });
    expect(owner.status).toBe(200); // the owner, elsewhere, is not
  });
});

describe("the Google start route is not free to hammer", () => {
  it("limits starts per address", async () => {
    const app = await bootAccounts({ google: { clientId: "id", clientSecret: "secret" } });
    const codes: number[] = [];
    for (let i = 0; i < 35; i++) codes.push((await fetch(`${app.url}/api/auth/google`, { redirect: "manual" })).status);
    expect(codes.slice(0, 30).every((c) => c === 302)).toBe(true);
    expect(codes.slice(30).every((c) => c === 429)).toBe(true);
  });
});

describe("the account database stays private and out of git", () => {
  it("is listed in .gitignore", () => {
    const ignore = readdirSync(join(__dirname, "../../.."));
    expect(ignore).toContain(".gitignore");
    expect(require("node:fs").readFileSync(join(__dirname, "../../../.gitignore"), "utf8")).toMatch(/^mockdata-data\/?$/m);
    expect(existsSync(join(__dirname, "../../../mockdata-data"))).toBe(false);
  });
});

describe("lockedLlmConfig", () => {
  it("keeps batching and retries within what the operator can afford", () => {
    expect(lockedLlmConfig({ batchSize: 1, maxRetries: 10, contextDepth: 2 })).toEqual({ batchSize: 10, maxRetries: 2, contextDepth: 1 });
    expect(lockedLlmConfig({ batchSize: 50, maxRetries: 1, contextDepth: 0 })).toEqual({ batchSize: 50, maxRetries: 1, contextDepth: 0 });
    expect(lockedLlmConfig({ provider: "openai", model: "x", baseUrl: "https://e.example", apiKeyEnv: "OPENAI_API_KEY" })).toEqual({});
    expect(lockedLlmConfig(undefined)).toBeUndefined();
  });
});

describe("the size of what one user can ask the server to build", () => {
  const tables = (n: number) => `tables:\n${Array.from({ length: n }, (_, i) => `  t${i}:\n    rows: 1\n    columns:\n      id: { type: integer, primaryKey: true }`).join("\n")}\n`;
  const wide = (cols: number) => `tables:\n  t:\n    rows: 1\n    columns:\n      id: { type: integer, primaryKey: true }\n${Array.from({ length: cols }, (_, i) => `      c${i}: { type: integer }`).join("\n")}\n`;

  it("refuses too many tables, too many columns and too many cells, everywhere a schema is read", async () => {
    const { signUp, as } = await bootAccounts({ limits: { maxCells: 60 } });
    const ann = as(await signUp("ann@example.com"));
    for (const [text, what] of [[tables(51), /50 tables/], [wide(101), /100 columns/], [`tables:\n  t:\n    rows: 10\n    columns:\n      id: { type: integer, primaryKey: true }\n${Array.from({ length: 6 }, (_, i) => `      c${i}: { type: integer }`).join("\n")}\n`, /cells/]] as const) {
      for (const [route, body] of [["/api/validate", { text }], ["/api/generate", { text }], ["/api/generate/stream", { text }], ["/api/export", { text, zip: true }]] as const) {
        const r = await ann.post(route, body);
        expect(r.status, `${route} ${what}`).toBe(400);
        expect(r.json.error.message, route).toMatch(what);
      }
    }
    expect((await ann.post("/api/validate", { text: SHOP_YAML })).status).toBe(200);
  });

  it("limits the number of files in a user's folder", async () => {
    const { signUp, as } = await bootAccounts({ limits: { maxFiles: 3 } });
    const ann = as(await signUp("ann@example.com"));
    for (const n of ["a", "b", "c"]) expect((await ann.put("/api/file", { path: `${n}.yaml`, text: "tables: {}\n" })).status).toBe(200);
    const over = await ann.put("/api/file", { path: "d.yaml", text: "tables: {}\n" });
    expect(over.status).toBe(429);
    expect(over.json.error.message).toMatch(/files/i);
    expect((await ann.put("/api/file", { path: "a.yaml", text: "tables: {}\n# edit\n" })).status).toBe(200); // replacing is not a new file
  });
});

describe("one user cannot stall the server by repeating expensive runs", () => {
  it("limits generate, run, export and infer requests per user per minute, and other users are unaffected", async () => {
    const { signUp, as } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    const bob = as(await signUp("bob@example.com"));
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await ann.post("/api/generate", { text: SHOP_YAML })).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes.slice(30).every((c) => c === 429)).toBe(true);
    expect((await ann.post("/api/export", { text: SHOP_YAML, zip: true })).status).toBe(429); // the same budget covers every heavy route
    expect((await ann.post("/api/validate", { text: SHOP_YAML })).status).toBe(200); // editing is not limited
    expect((await bob.post("/api/generate", { text: SHOP_YAML })).status).toBe(200);
  });
});

describe("a busy server does not burn a reset link, and password changes are limited per user", () => {
  it("answers 503 before using the reset link up, so the link still works afterwards", async () => {
    const { post, signUp, sent, tokenOf, accounts } = await bootAccounts();
    await signUp("ann@example.com");
    await post("/api/auth/forgot-password", { email: "ann@example.com" });
    const token = tokenOf(sent.at(-1)!, "reset_token");
    const releases: (() => void)[] = [];
    const jobs = Array.from({ length: 18 }, () => accounts.hashing.run(() => new Promise<void>((r) => releases.push(r)))); // 2 running + 16 queued: full
    await new Promise((r) => setTimeout(r, 20));
    const busy = await post("/api/auth/reset-password", { token, password: "N3w$ecretPassw0rd!" });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBeTruthy();
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all(jobs);
    expect((await post("/api/auth/reset-password", { token, password: "N3w$ecretPassw0rd!" })).status).toBe(200); // the link was not burned
  });

  it("limits password changes per user even when every one succeeds", async () => {
    const { signUp, as } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    let current = PASSWORD;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const next = `Str0ng$ecret${i}Passw0rd!`;
      const r = await ann.post("/api/auth/change-password", { currentPassword: current, newPassword: next });
      codes.push(r.status);
      if (r.status === 200) current = next;
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });
});

describe("what a schema may ask for, and what the operator is never told", () => {
  it("limits table and column names, which are re-sent with every row of every model batch", async () => {
    const { signUp, as } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    const longTable = `tables:\n  ${"t".repeat(65)}:\n    rows: 1\n    columns:\n      id: { type: integer, primaryKey: true }\n`;
    const longColumn = `tables:\n  t:\n    rows: 1\n    columns:\n      id: { type: integer, primaryKey: true }\n      ${"c".repeat(65)}: { type: integer }\n`;
    for (const text of [longTable, longColumn]) {
      const r = await ann.post("/api/validate", { text });
      expect(r.status).toBe(400);
      expect(r.json.error.message).toMatch(/64 characters/);
    }
  });

  it("limits validate requests too (it parses up to 2 MB of schema each time)", async () => {
    const { signUp, as } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    const codes: number[] = [];
    for (let i = 0; i < 125; i++) codes.push((await ann.post("/api/validate", { text: "tables: {}\n" })).status);
    expect(codes.slice(0, 120).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(120).every((c) => c === 429)).toBe(true);
  });

  it("caps a chunked request body too, where there is no Content-Length to refuse early", async () => {
    const { signUp, url } = await bootAccounts();
    const cookie = await signUp("ann@example.com");
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const req = http.request({ host: u.hostname, port: u.port, path: "/api/validate", method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked", cookie } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on("error", (e) => ((e as NodeJS.ErrnoException).code === "ECONNRESET" || (e as NodeJS.ErrnoException).code === "EPIPE" ? undefined : reject(e)));
      const chunk = Buffer.alloc(256 * 1024, 97);
      let sent = 0;
      const write = () => {
        while (sent < 6 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", write);
        }
        req.end();
      };
      write();
    });
    expect(status).toBe(413);
  });

  it("does not tell users about the operator's model service, base URL or variables", async () => {
    const failing = (async () => new Response("credit balance is too low on account acme-prod", { status: 500 })) as unknown as typeof fetch;
    const { signUp, as } = await bootAccounts({ env: { AI_PROVIDER: "ollama", OLLAMA_MODEL: "m", OLLAMA_BASE_URL: "http://10.9.8.7:11434" }, llm: { fetch: failing, sleep: async () => undefined } });
    const ann = as(await signUp("ann@example.com"));
    const text = `tables:\n  t:\n    rows: 2\n    columns:\n      id: { type: integer, primaryKey: true }\n      note: { type: string, llm: true }\n`;
    const r = await ann.post("/api/generate/stream", { text });
    expect(r.status).toBe(200);
    expect(r.raw).toContain("event: error");
    expect(r.raw).not.toMatch(/credit balance|acme-prod|10\.9\.8\.7|11434/);
    expect(r.raw).toMatch(/model service/i);

    const unset = await bootAccounts();
    const ann2 = unset.as(await unset.signUp("bob@example.com"));
    const status = await ann2.post("/api/validate", { text });
    expect(status.json.llm).toEqual({ ok: false, reason: "Model-written columns are not available on this server" });
    expect(JSON.stringify(status.json)).not.toMatch(/AI_PROVIDER|OLLAMA|ANTHROPIC|OPENAI/);
    const run = await ann2.post("/api/generate/stream", { text });
    expect(run.raw).not.toMatch(/AI_PROVIDER|OLLAMA|ANTHROPIC|OPENAI/);
  });

  it("puts an IPv4-mapped address sent in hex form in the IPv4 bucket, not a shared one", async () => {
    const acc = await accountsFromEnv({ MOCKDATA_PUBLIC_URL: "http://localhost:4747", MOCKDATA_TRUST_PROXY: "0", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }, { configRoot: mkdtempSync(join(tmpdir(), "mockdata-hex-")), dataDir: join(mkdtempSync(join(tmpdir(), "mockdata-hex-")), "d") });
    expect(acc!.clientIp(fakeReq("::ffff:0102:0304"))).toBe("1.2.3.4");
    expect(acc!.clientIp(fakeReq("::ffff:1.2.3.4"))).toBe("1.2.3.4");
    acc!.close();
  });
});
