import { mkdtempSync, realpathSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Mailer, MailerMessage } from "@mockdata/auth-kit";
import { parsePublicUrl } from "@mockdata/cli";
import { PGlite } from "@electric-sql/pglite";
import { AccountsDb, pgliteDriver, type Limits } from "@mockdata/accounts";
import { createAccounts, startServer } from "../src/index.js";

type AppOptions = NonNullable<Parameters<typeof startServer>[0]>;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

export const tmpRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "mockdata-server-")));

export const SHOP_YAML = `seed: 7
tables:
  customers:
    rows: 6
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: string, faker: person.fullName }
  orders:
    rows: 15
    columns:
      id: { type: integer, primaryKey: true }
      customer_id: { type: integer, ref: customers.id }
      total: { type: float, min: 1, max: 9 }
`;

/** Start a real server on an ephemeral port with an empty env and a temp root (so a real .env never leaks in). */
export async function boot(opts: AppOptions = {}) {
  const root = opts.root ?? tmpRoot();
  const { server, url } = await startServer({ env: {}, ...opts, root, port: 0 });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(url + path, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, raw, json };
  }
  return { root, url, call, get: (p: string) => call("GET", p), post: (p: string, b: unknown) => call("POST", p, b), put: (p: string, b: unknown) => call("PUT", p, b) };
}

/** Send a request with arbitrary headers (fetch will not let a test set Host). */
export function rawRequest(url: string, path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}


export const PASSWORD = "Sup3r$ecretPassw0rd";

/** A server in accounts mode with a capturing mailer, an in-memory account database and no real network. */
export async function bootAccounts(
  opts: {
    publicUrl?: string;
    limits?: Partial<Limits>;
    env?: Record<string, string | undefined>;
    emailEnabled?: boolean;
    google?: { clientId: string; clientSecret: string };
    fetch?: typeof fetch;
    llm?: AppOptions["llm"];
    trustProxy?: boolean;
    /** Replace the mailer's send (default: capture into `sent`). */
    mail?: (m: MailerMessage) => Promise<void>;
    /** The account database engine; default MOCKDATA_TEST_ACCOUNTS_ENGINE, else SQLite. Postgres is PGlite (in process). */
    engine?: "sqlite" | "postgres";
  } = {},
) {
  const engine = opts.engine ?? (process.env.MOCKDATA_TEST_ACCOUNTS_ENGINE === "postgres" ? "postgres" : "sqlite");
  let db: AccountsDb | undefined;
  if (engine === "postgres") {
    db = await AccountsDb.openPostgres(pgliteDriver(new PGlite({ parsers: { 20: Number } })));
    const opened = db;
    closers.push(() => opened.close());
  }
  const dataDir = tmpRoot();
  const configRoot = tmpRoot();
  const sent: MailerMessage[] = [];
  const emailEnabled = opts.emailEnabled ?? true;
  const mailer: Mailer = {
    isConfigured: () => emailEnabled,
    verifyConnection: async () => undefined,
    send: opts.mail ?? (async (m) => void sent.push(m)),
    isAuthError: () => false,
    formatError: (e) => String((e as Error)?.message ?? e),
  };
  const env = opts.env ?? {};
  const accounts = await createAccounts({
    publicUrl: parsePublicUrl(opts.publicUrl ?? "https://mockdata.example.com"),
    dataDir,
    dbFile: ":memory:",
    db,
    configRoot,
    env,
    mailer,
    google: opts.google,
    fetch: opts.fetch,
    limits: opts.limits,
    trustProxy: opts.trustProxy,
    enumerationTimingFloorMs: 0,
  });
  const app = await boot({ root: configRoot, accounts, env, llm: opts.llm });

  /** Requests carrying a session cookie. */
  const as = (cookie: string) => ({
    get: (p: string) => app.call("GET", p, undefined, { cookie }),
    post: (p: string, b: unknown) => app.call("POST", p, b, { cookie }),
    put: (p: string, b: unknown) => app.call("PUT", p, b, { cookie }),
  });
  const cookieOf = (headers: Headers): string => {
    const set = headers.getSetCookie().find((c) => /^(__Host-)?mockdata_session=/.test(c) && !/Max-Age=0/.test(c));
    return set ? set.split(";")[0]! : "";
  };
  const linkIn = (m: MailerMessage): string => /https?:\/\/[^\s"<]+/.exec(m.text ?? "")![0]!.replace(/&amp;/g, "&");
  const pathOf = (link: string) => {
    const u = new URL(link);
    return u.pathname + u.search;
  };
  /** The one-time value in an emailed link (they travel in the URL fragment: #verify_token=... or #reset_token=...). */
  const tokenOf = (m: MailerMessage, name: "verify_token" | "reset_token" = "verify_token"): string => new URLSearchParams(new URL(linkIn(m)).hash.slice(1)).get(name)!;

  /** Register, click the emailed link, sign in: returns the session cookie. */
  async function signUp(email: string, password = PASSWORD): Promise<string> {
    const before = sent.length;
    const reg = await app.post("/api/auth/register", { email, password });
    if (reg.status !== 202) throw new Error(`register gave ${reg.status}: ${reg.raw}`);
    const verify = await app.post("/api/auth/verify-email", { token: tokenOf(sent[before]!), password }); // confirming proves the mailbox AND the password
    if (verify.status !== 200) throw new Error(`verify gave ${verify.status}: ${verify.raw}`);
    return cookieOf(verify.headers);
  }

  return { ...app, accounts, dataDir, configRoot, sent, as, cookieOf, linkIn, pathOf, tokenOf, signUp };
}
