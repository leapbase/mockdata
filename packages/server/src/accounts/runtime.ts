import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { AccountsDb, OAuthStates, RateLimiter, RunGate, SessionStore, SqliteAuthAdapter, UsageStore, limitsFromEnv, mailerFromEnv, type AccountUser, type Limits } from "@mockdata/accounts";
import { AuthService, getGoogleOAuthConfigFromEnv, isGoogleClientConfigured, type Mailer } from "@mockdata/auth-kit";
import { isLoopback, loadEnv, NetworkConfigError, parsePublicUrl, type PublicUrl } from "@mockdata/cli";
import type { IncomingMessage } from "node:http";

export interface AccountsConfig {
  publicUrl: PublicUrl;
  /** Holds accounts.db and users/<id>/ (each user's private folder). Never inside a user-writable folder. */
  dataDir: string;
  /** Test hook: use ":memory:" instead of <dataDir>/accounts.db. */
  dbFile?: string;
  /** Where the operator's .env (LLM keys, SMTP, Google) is read from. Users never read it. */
  configRoot: string;
  env: Record<string, string | undefined>;
  mailer?: Mailer;
  google?: { clientId: string; clientSecret: string };
  /** For Google requests (tests). */
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
  /** Read the client address from the last X-Forwarded-For entry when the peer is loopback (a reverse proxy). */
  trustProxy?: boolean;
  enumerationTimingFloorMs?: number;
}

export interface AccountsRuntime {
  readonly config: { publicUrl: PublicUrl; dataDir: string; configRoot: string; fetch?: typeof fetch };
  readonly db: AccountsDb;
  readonly adapter: SqliteAuthAdapter;
  readonly auth: AuthService<AccountUser>;
  readonly sessions: SessionStore;
  readonly oauth: OAuthStates;
  readonly usage: UsageStore;
  readonly runs: RunGate;
  readonly limits: Limits;
  readonly mailer: Mailer;
  readonly emailEnabled: boolean;
  readonly google?: { clientId: string; clientSecret: string };
  readonly limiters: {
    /** Failed sign-ins per address. */
    ipFail: RateLimiter;
    /** Failed sign-ins per mailbox. */
    emailFail: RateLimiter;
    /** Sign-up attempts per address. */
    signupIp: RateLimiter;
    /** Emails requested (verification, reset) per address and per mailbox. */
    mailIp: RateLimiter;
    mailEmail: RateLimiter;
  };
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
  const db = await AccountsDb.open(config.dbFile ?? path.join(dataDir, "accounts.db"));
  const adapter = new SqliteAuthAdapter(db);
  const auth = new AuthService<AccountUser>({ adapter, enumerationTimingFloorMs: config.enumerationTimingFloorMs });
  const sessions = new SessionStore(db);
  const mailer = config.mailer ?? mailerFromEnv(config.env);
  const google = config.google ?? googleFromEnv(config.env);
  const limits: Limits = { ...limitsFromEnv(config.env), ...config.limits };

  const sweep = setInterval(() => void sessions.purgeExpired().catch(() => undefined), 60 * MINUTE);
  sweep.unref();

  return {
    config: { publicUrl: config.publicUrl, dataDir, configRoot: config.configRoot, fetch: config.fetch },
    db,
    adapter,
    auth,
    sessions,
    oauth: new OAuthStates(db),
    usage: new UsageStore(db),
    runs: new RunGate(limits.maxRuns),
    limits,
    mailer,
    emailEnabled: mailer.isConfigured(),
    google,
    limiters: {
      ipFail: new RateLimiter({ max: 20, windowMs: 15 * MINUTE }),
      emailFail: new RateLimiter({ max: 10, windowMs: 15 * MINUTE }),
      signupIp: new RateLimiter({ max: 5, windowMs: 60 * MINUTE }),
      mailIp: new RateLimiter({ max: 20, windowMs: 60 * MINUTE }),
      mailEmail: new RateLimiter({ max: 5, windowMs: 60 * MINUTE }),
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
      if (config.trustProxy && isLoopback(peer)) {
        const last = [req.headers["x-forwarded-for"]].flat()[0]?.split(",").at(-1)?.trim();
        if (last && isIP(last)) return last;
      }
      return peer;
    },
    close() {
      clearInterval(sweep);
      db.close();
    },
  };
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
export async function accountsFromEnv(baseEnv: Record<string, string | undefined>, opts: { configRoot: string; dataDir?: string; cwd?: string }): Promise<AccountsRuntime | undefined> {
  const env = loadEnv(opts.configRoot, baseEnv);
  if (!env.MOCKDATA_PUBLIC_URL?.trim()) return undefined;
  const publicUrl = parsePublicUrl(env.MOCKDATA_PUBLIC_URL.trim());
  const mailer = mailerFromEnv(env);
  const google = googleFromEnv(env);
  if (!mailer.isConfigured() && !google) {
    throw new NetworkConfigError("Accounts need a way to sign up: set SMTP_HOST and SMTP_FROM (email) and/or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (Google sign-in)");
  }
  const dataDir = path.resolve(opts.cwd ?? process.cwd(), opts.dataDir ?? env.MOCKDATA_DATA_DIR?.trim() ?? "mockdata-data");
  return createAccounts({ publicUrl, dataDir, configRoot: opts.configRoot, env, mailer, google, trustProxy: env.MOCKDATA_TRUST_PROXY === "1" });
}
