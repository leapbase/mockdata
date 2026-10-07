import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { AccountsDb, ApiKeyStore, SqlRateLimiter, SqlRunSlots, memoryLimiter, pgPoolDriver, purgeRateEvents, type Limiter, type RateLimiterOptions, type RunSlots, OAuthStates, RunGate, Semaphore, SessionStore, SqlAuthAdapter, UsageStore, limitsFromEnv, mailerFromEnv, type AccountUser, type Limits } from "@mockdata/accounts";
import { BusyError } from "@mockdata/core";
import { AuthService, getGoogleOAuthConfigFromEnv, isGoogleClientConfigured, type Mailer } from "@mockdata/auth-kit";
import { isLoopback, loadEnv, NetworkConfigError, parsePublicUrl, type PublicUrl } from "@mockdata/cli";
import type { IncomingMessage } from "node:http";

export interface AccountsConfig {
  publicUrl: PublicUrl;
  /** Holds accounts.db and users/<id>/ (each user's private folder). Never inside a user-writable folder. */
  dataDir: string;
  /** Test hook: use ":memory:" instead of <dataDir>/accounts.db. */
  dbFile?: string;
  /** A Postgres URL (MOCKDATA_ACCOUNTS_DB) for the account database instead of SQLite under dataDir. */
  databaseUrl?: string;
  /** Test hook: an already open account database (for example on PGlite). */
  db?: AccountsDb;
  /** Where the operator's .env (LLM keys, SMTP, Google) is read from. Users never read it. */
  configRoot: string;
  env: Record<string, string | undefined>;
  mailer?: Mailer;
  google?: { clientId: string; clientSecret: string };
  /** For Google requests (tests). */
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
  /** Read the client address from the last X-Forwarded-For entry when the peer is loopback (a reverse proxy). Default: on for an https address, off for plain-http localhost. */
  trustProxy?: boolean;
  enumerationTimingFloorMs?: number;
}

export interface AccountsRuntime {
  readonly config: { publicUrl: PublicUrl; dataDir: string; configRoot: string; fetch?: typeof fetch };
  readonly db: AccountsDb;
  readonly adapter: SqlAuthAdapter;
  readonly auth: AuthService<AccountUser>;
  readonly sessions: SessionStore;
  /** Per-user keys for the hosted MCP endpoint. */
  readonly apiKeys: ApiKeyStore;
  readonly oauth: OAuthStates;
  readonly usage: UsageStore;
  readonly runs: RunSlots;
  readonly limits: Limits;
  readonly mailer: Mailer;
  readonly emailEnabled: boolean;
  readonly google?: { clientId: string; clientSecret: string };
  readonly limiters: {
    /** Every sign-in attempt per address, counted before the password is hashed so a parallel burst is cut off. */
    loginIp: Limiter;
    /** Any unauthenticated auth request per address (a coarse ceiling). */
    authIp: Limiter;
    /** Failed sign-ins per address. */
    ipFail: Limiter;
    /** Failed sign-ins per mailbox from one address (an attacker's failures do not lock the owner out elsewhere). */
    emailIpFail: Limiter;
    /** Failed sign-ins per mailbox from anywhere, at a much higher threshold. */
    emailFail: Limiter;
    /** Sign-up attempts per address. */
    signupIp: Limiter;
    /** Emails requested (verification, reset) per address and per mailbox. */
    mailIp: Limiter;
    mailEmail: Limiter;
    /** Starts of the Google flow per address. */
    oauthIp: Limiter;
    /** Expensive requests (generate, run, export, infer) per signed-in user. */
    runUser: Limiter;
    /** Schema checks per signed-in user (the editor checks as you type, so this is generous). */
    validateUser: Limiter;
    /** Password changes per signed-in user (each costs two hashes). */
    changePasswordUser: Limiter;
    /** API keys made per signed-in user. */
    apiKeyUser: Limiter;
    /** Requests to the hosted MCP endpoint per user (tool calls that generate are also counted by runUser). */
    mcpUser: Limiter;
    /** Requests with a wrong API key per address. */
    apiKeyFail: Limiter;
  };
  /** Run password hashing through this: at most two at once, a short queue, then `BusyError`. */
  readonly hashing: Semaphore;
  /** Send an email after the response, never awaited by it (slow SMTP must not show in response times). */
  queueMail(job: () => Promise<void>): void;
  /** The user's private folder, created on first use. */
  userRoot(user: AccountUser): string;
  clientIp(req: IncomingMessage): string;
  close(): void;
}

const MINUTE = 60_000;

export async function createAccounts(config: AccountsConfig): Promise<AccountsRuntime> {
  const dataDir = path.resolve(config.dataDir);
  const usersDir = path.join(dataDir, "users");
  mkdirSync(usersDir, { recursive: true, mode: 0o700 });
  const db = config.db ?? (config.databaseUrl ? await openPostgres(config.databaseUrl) : await AccountsDb.open(config.dbFile ?? path.join(dataDir, "accounts.db")));
  const adapter = new SqlAuthAdapter(db);
  const auth = new AuthService<AccountUser>({ adapter, enumerationTimingFloorMs: config.enumerationTimingFloorMs });
  const sessions = new SessionStore(db);
  const mailer = config.mailer ?? mailerFromEnv(config.env);
  const google = config.google ?? googleFromEnv(config.env);
  const limits: Limits = { ...limitsFromEnv(config.env), ...config.limits };

  // On Postgres every server may share the database, so rate limits and run slots live there too; on SQLite (one
  // server) they stay in memory.
  const shared = db.dialect === "postgres";
  const limiter = (name: string, opts: RateLimiterOptions): Limiter => (shared ? new SqlRateLimiter(db, name, opts) : memoryLimiter(opts));

  const sweep = setInterval(() => {
    void sessions.purgeExpired().catch(() => undefined);
    if (shared) void purgeRateEvents(db, 2 * 60 * MINUTE).catch(() => undefined); // the longest window is an hour
    db.secure(); // the -wal/-shm files appear after the first write
  }, 60 * MINUTE);
  sweep.unref();
  const mailQueue = new Semaphore(4, 100);
  // A reverse proxy must be in front of an https address (Node does not terminate TLS), so its forwarded address is
  // trusted by default; behind a plain http development address it is not. MOCKDATA_TRUST_PROXY=0 or 1 overrides.
  const trustProxy = config.trustProxy ?? config.publicUrl.secure;

  return {
    config: { publicUrl: config.publicUrl, dataDir, configRoot: config.configRoot, fetch: config.fetch },
    db,
    adapter,
    auth,
    sessions,
    apiKeys: new ApiKeyStore(db),
    oauth: new OAuthStates(db),
    usage: new UsageStore(db),
    runs: shared ? new SqlRunSlots(db, limits.maxRuns) : new RunGate(limits.maxRuns),
    limits,
    mailer,
    emailEnabled: mailer.isConfigured(),
    google,
    limiters: {
      loginIp: limiter("loginIp", { max: 30, windowMs: 15 * MINUTE }),
      authIp: limiter("authIp", { max: 120, windowMs: 15 * MINUTE }),
      ipFail: limiter("ipFail", { max: 20, windowMs: 15 * MINUTE }),
      emailIpFail: limiter("emailIpFail", { max: 10, windowMs: 15 * MINUTE }),
      emailFail: limiter("emailFail", { max: 100, windowMs: 15 * MINUTE }),
      signupIp: limiter("signupIp", { max: 5, windowMs: 60 * MINUTE }),
      mailIp: limiter("mailIp", { max: 20, windowMs: 60 * MINUTE }),
      mailEmail: limiter("mailEmail", { max: 5, windowMs: 60 * MINUTE }),
      oauthIp: limiter("oauthIp", { max: 30, windowMs: 15 * MINUTE }),
      runUser: limiter("runUser", { max: 30, windowMs: MINUTE }),
      validateUser: limiter("validateUser", { max: 120, windowMs: MINUTE }),
      changePasswordUser: limiter("changePasswordUser", { max: 5, windowMs: 15 * MINUTE }),
      apiKeyUser: limiter("apiKeyUser", { max: 20, windowMs: 60 * MINUTE }),
      mcpUser: limiter("mcpUser", { max: 240, windowMs: MINUTE }),
      apiKeyFail: limiter("apiKeyFail", { max: 30, windowMs: 15 * MINUTE }),
    },
    hashing: new Semaphore(2, 16),
    queueMail(job) {
      mailQueue.run(job).catch((e) => {
        if (e instanceof BusyError) process.stderr.write("mail: queue full, message dropped\n");
      });
    },
    userRoot(user) {
      const dir = path.join(usersDir, user.dirId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // The root must be a real folder inside users/, never a link someone swapped in.
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(realpathSync(dir)) !== realpathSync(usersDir)) {
        throw new Error("A user folder is not a plain directory");
      }
      return dir;
    },
    clientIp(req) {
      const peer = req.socket.remoteAddress ?? "unknown";
      if (trustProxy && isLoopback(peer)) {
        const last = [req.headers["x-forwarded-for"]].flat()[0]?.split(",").at(-1)?.trim();
        if (last && isIP(last)) return rateLimitKey(last);
      }
      return rateLimitKey(peer);
    },
    close() {
      clearInterval(sweep);
      void db.close().catch(() => undefined);
    },
  };
}

/**
 * The key a client is rate limited under: IPv4-mapped IPv6 becomes the IPv4 address, and an IPv6 address becomes its
 * /64 (one customer commonly holds a whole /64, so per-address limits would otherwise never bind).
 */
function rateLimitKey(address: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4) return v4[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address); // the same mapping written as two hex groups
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (isIP(address) !== 6) return address;
  const [head = "", tail = ""] = address.toLowerCase().split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function googleFromEnv(env: Record<string, string | undefined>): { clientId: string; clientSecret: string } | undefined {
  const g = getGoogleOAuthConfigFromEnv(env);
  return g && isGoogleClientConfigured(g.clientId, g.clientSecret) ? g : undefined;
}

/**
 * Accounts mode from the environment (MOCKDATA_PUBLIC_URL, MOCKDATA_DATA_DIR, SMTP_*, GOOGLE_*,
 * MOCKDATA_TRUST_PROXY, quota variables), or undefined when MOCKDATA_PUBLIC_URL is unset. Refuses to
 * start when nobody could sign up. Errors name variables, never values.
 */
/** A Postgres URL, its password masked, so it can appear in no message. */
export function redactUrl(text: string, url: string): string {
  let out = text.split(url).join("<MOCKDATA_ACCOUNTS_DB>");
  try {
    const password = new URL(url).password;
    if (password) out = out.split(decodeURIComponent(password)).join("***").split(password).join("***");
  } catch {
    /* not a URL: nothing more to hide */
  }
  return out;
}

/** Validate MOCKDATA_ACCOUNTS_DB. Errors name the variable, never its value. */
export function parseAccountsDbUrl(raw: string | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new NetworkConfigError("MOCKDATA_ACCOUNTS_DB must be a postgres:// URL (leave it unset to keep accounts in SQLite)");
  try {
    new URL(url);
  } catch {
    throw new NetworkConfigError("MOCKDATA_ACCOUNTS_DB is not a valid URL");
  }
  return url;
}

async function openPostgres(url: string): Promise<AccountsDb> {
  try {
    return await AccountsDb.openPostgres(await pgPoolDriver(url));
  } catch (e) {
    throw new Error(`Could not open the account database in MOCKDATA_ACCOUNTS_DB: ${redactUrl((e as Error).message, url)}`);
  }
}

/** Where accounts mode keeps its data: --data-dir, else MOCKDATA_DATA_DIR, else ./mockdata-data. */
export function accountsDataDir(env: Record<string, string | undefined>, opts: { dataDir?: string; cwd?: string }): string {
  return path.resolve(opts.cwd ?? process.cwd(), opts.dataDir ?? env.MOCKDATA_DATA_DIR?.trim() ?? "mockdata-data");
}

/** Copy the account database to `target` (safe while the server runs). Returns the source path. */
export async function backupAccounts(baseEnv: Record<string, string | undefined>, opts: { configRoot: string; dataDir?: string; cwd?: string; target: string }): Promise<string> {
  const env = loadEnv(opts.configRoot, baseEnv);
  if (parseAccountsDbUrl(env.MOCKDATA_ACCOUNTS_DB)) throw new Error("The account database is in Postgres (MOCKDATA_ACCOUNTS_DB): back it up with pg_dump or your provider's backups");
  const source = path.join(accountsDataDir(env, opts), "accounts.db");
  await AccountsDb.backupFile(source, path.resolve(opts.cwd ?? process.cwd(), opts.target));
  return source;
}

export async function accountsFromEnv(baseEnv: Record<string, string | undefined>, opts: { configRoot: string; dataDir?: string; cwd?: string }): Promise<AccountsRuntime | undefined> {
  const env = loadEnv(opts.configRoot, baseEnv);
  if (!env.MOCKDATA_PUBLIC_URL?.trim()) return undefined;
  const publicUrl = parsePublicUrl(env.MOCKDATA_PUBLIC_URL.trim());
  const mailer = mailerFromEnv(env);
  const google = googleFromEnv(env);
  if (!mailer.isConfigured() && !google) {
    throw new NetworkConfigError("Accounts need a way to sign up: set SMTP_HOST and SMTP_FROM (email) and/or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (Google sign-in)");
  }
  const dataDir = accountsDataDir(env, opts);
  const databaseUrl = parseAccountsDbUrl(env.MOCKDATA_ACCOUNTS_DB);
  return createAccounts({ publicUrl, dataDir, databaseUrl, configRoot: opts.configRoot, env, mailer, google, trustProxy: env.MOCKDATA_TRUST_PROXY === "1" ? true : env.MOCKDATA_TRUST_PROXY === "0" ? false : undefined });
}
