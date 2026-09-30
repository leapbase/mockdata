import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA = `
create table users (
  id integer primary key autoincrement,
  dir_id text not null unique,
  email text,
  display_name text not null,
  avatar_url text,
  created_at integer not null
);
create table identities (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  provider text not null,
  provider_user_id text not null,
  email text,
  password_hash text,
  email_verified_at integer,
  created_at integer not null,
  updated_at integer not null,
  unique (provider, provider_user_id)
);
create index identities_user on identities(user_id);
create unique index identities_email on identities(lower(email)) where provider = 'email';
create table email_verification_tokens (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at integer not null,
  used_at integer,
  created_at integer not null
);
create index email_verification_user on email_verification_tokens(user_id);
create table password_reset_tokens (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at integer not null,
  used_at integer,
  created_at integer not null
);
create index password_reset_user on password_reset_tokens(user_id);
create table sessions (
  id_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null,
  last_seen_at integer not null
);
create index sessions_user on sessions(user_id);
create index sessions_expires on sessions(expires_at);
create table oauth_states (
  state_hash text primary key,
  nonce_hash text not null,
  code_verifier text not null,
  expires_at integer not null
);
create table usage (
  user_id integer not null references users(id) on delete cascade,
  day text not null,
  llm_rows integer not null default 0,
  primary key (user_id, day)
);
`;

const VERSION = 1;

/**
 * The account database. node:sqlite is synchronous but the auth adapter is
 * async, so a statement from another request could otherwise run between two
 * `await`s inside a transaction and land inside it (and be rolled back with
 * it). Every top-level operation therefore goes through `gated`, which runs one
 * at a time; a transaction holds the gate until it commits or rolls back.
 * Code inside a transaction uses `raw` directly and must not call `gated`.
 */
export class AccountsDb {
  private tail: Promise<void> = Promise.resolve();

  private constructor(readonly raw: DatabaseSync) {}

  /** Open (creating if needed) the database file, or ":memory:" for tests. Needs Node 22.13+. */
  static async open(file: string): Promise<AccountsDb> {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch {
      throw new Error("Accounts need Node 22.13 or newer (built-in node:sqlite)");
    }
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const raw = new sqlite.DatabaseSync(file);
    raw.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000; pragma synchronous = normal;");
    const { user_version } = raw.prepare("pragma user_version").get() as { user_version: number };
    if (user_version === 0) {
      raw.exec("begin");
      try {
        raw.exec(SCHEMA);
        raw.exec(`pragma user_version = ${VERSION}`);
        raw.exec("commit");
      } catch (e) {
        raw.exec("rollback");
        throw e;
      }
    } else if (user_version !== VERSION) {
      raw.close();
      throw new Error(`The account database was made by a newer mockdata (schema ${user_version}, this build knows ${VERSION})`);
    }
    return new AccountsDb(raw);
  }

  /** Run `fn` with exclusive use of the connection. */
  async gated<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  close(): void {
    this.raw.close();
  }
}
