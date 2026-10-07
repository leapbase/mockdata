import { randomBytes } from "node:crypto";
import { EmailTakenError, hashOpaqueToken, type AuthAdapter, type AuthIdentityRecord, type CreateUserWithOAuthInput, type CreateUserWithPasswordInput, type EmailIdentityLookup, type PasswordLoginRecord, type UpdateOAuthProfileInput } from "@mockdata/auth-kit";
import type { AccountsDb } from "./db.js";
import { isUniqueViolation, type Queries, type Tx } from "./sql.js";

/** An account. `dirId` names the user's private folder and is random: never derived from the email or a provider id. */
export interface AccountUser {
  id: number;
  dirId: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  createdAt: number;
}

export interface UserRow {
  id: number;
  dir_id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  created_at: number;
}

export function rowToUser(r: UserRow): AccountUser {
  return { id: r.id, dirId: r.dir_id, email: r.email, displayName: r.display_name, avatarUrl: r.avatar_url, createdAt: r.created_at };
}

export const sessionKey = (raw: string): string => hashOpaqueToken(raw);

const TOKEN_TABLES = new Set(["email_verification_tokens", "password_reset_tokens"]);

/** AuthAdapter over the account database (SQLite or Postgres). Timestamps are epoch seconds. */
export class SqlAuthAdapter implements AuthAdapter<AccountUser, Tx> {
  constructor(
    private readonly accounts: AccountsDb,
    private readonly opts: { now?: () => number; tx?: Tx } = {},
  ) {}

  /** Inside `runInTransaction` every statement joins that transaction. */
  private get q(): Queries {
    return this.opts.tx ?? this.accounts;
  }
  private now(): number {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }
  /** Several statements that must succeed or fail together: a savepoint inside a transaction, else a transaction of their own. */
  private atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.opts.tx ? this.opts.tx.atomic(fn) : this.accounts.transaction(fn);
  }

  async findUserById(id: number): Promise<AccountUser | null> {
    const r = await this.q.one<UserRow>("select * from users where id = ?", [id]);
    return r ? rowToUser(r) : null;
  }

  async findUserByProviderIdentity(provider: string, providerUserId: string): Promise<AccountUser | null> {
    const r = await this.q.one<UserRow>("select u.* from users u join identities i on i.user_id = u.id where i.provider = ? and i.provider_user_id = ?", [provider, providerUserId]);
    return r ? rowToUser(r) : null;
  }

  async userExistsWithEmail(normalizedEmail: string): Promise<boolean> {
    return !!(await this.q.one("select 1 as found from identities where provider = 'email' and lower(email) = lower(?)", [normalizedEmail]));
  }

  async findEmailIdentity(normalizedEmail: string): Promise<EmailIdentityLookup | null> {
    const r = await this.q.one<{ user_id: number; email: string | null; email_verified_at: number | null }>(
      "select user_id, email, email_verified_at from identities where provider = 'email' and lower(email) = lower(?)",
      [normalizedEmail],
    );
    return r ? { userId: r.user_id, email: r.email, verified: r.email_verified_at !== null } : null;
  }

  async findPasswordLoginRecord(normalizedEmail: string): Promise<PasswordLoginRecord<AccountUser> | null> {
    const r = await this.q.one<UserRow & { password_hash: string; email_verified_at: number | null }>(
      `select u.*, i.password_hash, i.email_verified_at from users u join identities i on i.user_id = u.id
       where i.provider = 'email' and lower(i.email) = lower(?) and i.password_hash is not null`,
      [normalizedEmail],
    );
    return r ? { user: rowToUser(r), passwordHash: r.password_hash, emailVerified: r.email_verified_at !== null } : null;
  }

  async hasPasswordIdentity(userId: number): Promise<boolean> {
    return !!(await this.q.one("select 1 as found from identities where user_id = ? and password_hash is not null", [userId]));
  }

  async listIdentities(userId: number): Promise<AuthIdentityRecord[]> {
    const rows = await this.q.all<{ provider: string; has_password: number | boolean; email: string | null; email_verified_at: number | null; created_at: number }>(
      "select provider, password_hash is not null as has_password, email, email_verified_at, created_at from identities where user_id = ? order by id",
      [userId],
    );
    // SQLite answers 1/0, Postgres true/false.
    return rows.map((r) => ({ provider: r.provider, hasPassword: !!r.has_password, email: r.email, emailVerified: r.email_verified_at !== null, createdAt: r.created_at }));
  }

  private async insertUser(q: Queries, email: string | null, displayName: string, avatarUrl: string | null): Promise<UserRow> {
    return (await q.one<UserRow>("insert into users (dir_id, email, display_name, avatar_url, created_at) values (?, ?, ?, ?, ?) returning *", [
      randomBytes(16).toString("hex"),
      email,
      displayName,
      avatarUrl,
      this.now(),
    ]))!;
  }

  async createUserWithPasswordIdentity(input: CreateUserWithPasswordInput): Promise<AccountUser> {
    try {
      return await this.atomic(async (tx) => {
        const user = await this.insertUser(tx, input.normalizedEmail, input.displayName, null);
        const now = this.now();
        await tx.run("insert into identities (user_id, provider, provider_user_id, email, password_hash, created_at, updated_at) values (?, 'email', ?, ?, ?, ?, ?)", [
          user.id,
          input.normalizedEmail,
          input.normalizedEmail,
          input.passwordHash,
          now,
          now,
        ]);
        return rowToUser(user);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new EmailTakenError();
      throw e;
    }
  }

  createUserWithOAuthIdentity(input: CreateUserWithOAuthInput): Promise<AccountUser> {
    return this.atomic(async (tx) => {
      const email = input.email || null;
      const user = await this.insertUser(tx, email, input.displayName, input.avatarUrl);
      const now = this.now();
      await tx.run("insert into identities (user_id, provider, provider_user_id, email, created_at, updated_at) values (?, ?, ?, ?, ?, ?)", [user.id, input.provider, input.providerUserId, email, now, now]);
      return rowToUser(user);
    });
  }

  async updateOAuthProfile(userId: number, input: UpdateOAuthProfileInput): Promise<AccountUser> {
    const r = await this.q.one<UserRow>("update users set display_name = ?, avatar_url = ?, email = coalesce(nullif(?, ''), email) where id = ? returning *", [
      input.displayName,
      input.avatarUrl,
      input.email,
      userId,
    ]);
    if (!r) throw new Error("No such user");
    return rowToUser(r);
  }

  async updatePasswordHash(userId: number, newHash: string, opts?: { previousHash?: string }): Promise<void> {
    if (opts?.previousHash !== undefined) {
      await this.q.run("update identities set password_hash = ?, updated_at = ? where user_id = ? and provider = 'email' and password_hash = ?", [newHash, this.now(), userId, opts.previousHash]);
    } else {
      await this.q.run("update identities set password_hash = ?, updated_at = ? where user_id = ? and provider = 'email'", [newHash, this.now(), userId]);
    }
  }

  private table(name: string): string {
    if (!TOKEN_TABLES.has(name)) throw new Error("Unknown token table");
    return name;
  }
  private async createToken(table: string, userId: number, tokenHash: string, expiresAt: number): Promise<void> {
    await this.q.run(`insert into ${this.table(table)} (user_id, token_hash, expires_at, created_at) values (?, ?, ?, ?)`, [userId, tokenHash, expiresAt, this.now()]);
  }
  /** One atomic step: mark used where still unused and unexpired, returning whose token it was. */
  private async consumeToken(table: string, tokenHash: string, now: number): Promise<number | null> {
    const r = await this.q.one<{ user_id: number }>(`update ${this.table(table)} set used_at = ? where token_hash = ? and used_at is null and expires_at > ? returning user_id`, [now, tokenHash, now]);
    return r ? r.user_id : null;
  }
  private async deleteTokens(table: string, userId: number): Promise<void> {
    await this.q.run(`delete from ${this.table(table)} where user_id = ?`, [userId]);
  }

  createEmailVerificationToken(userId: number, tokenHash: string, expiresAt: number): Promise<void> {
    return this.createToken("email_verification_tokens", userId, tokenHash, expiresAt);
  }
  async peekEmailVerificationToken(tokenHash: string, now: number): Promise<number | null> {
    const r = await this.q.one<{ user_id: number }>("select user_id from email_verification_tokens where token_hash = ? and used_at is null and expires_at > ?", [tokenHash, now]);
    return r ? r.user_id : null;
  }
  consumeEmailVerificationToken(tokenHash: string, now: number): Promise<number | null> {
    return this.consumeToken("email_verification_tokens", tokenHash, now);
  }
  deleteEmailVerificationTokensForUser(userId: number): Promise<void> {
    return this.deleteTokens("email_verification_tokens", userId);
  }
  createPasswordResetToken(userId: number, tokenHash: string, expiresAt: number): Promise<void> {
    return this.createToken("password_reset_tokens", userId, tokenHash, expiresAt);
  }
  consumePasswordResetToken(tokenHash: string, now: number): Promise<number | null> {
    return this.consumeToken("password_reset_tokens", tokenHash, now);
  }
  deletePasswordResetTokensForUser(userId: number): Promise<void> {
    return this.deleteTokens("password_reset_tokens", userId);
  }

  async markEmailVerified(userId: number, now: number): Promise<void> {
    await this.q.run("update identities set email_verified_at = ?, updated_at = ? where user_id = ? and provider = 'email' and email_verified_at is null", [now, now, userId]);
  }

  /** `excludeSessionId` is the raw session token to keep (it is hashed here, like every stored session). */
  async revokeUserSessions(userId: number, excludeSessionId?: string): Promise<void> {
    if (excludeSessionId) await this.q.run("delete from sessions where user_id = ? and id_hash <> ?", [userId, sessionKey(excludeSessionId)]);
    else await this.q.run("delete from sessions where user_id = ?", [userId]);
  }

  runInTransaction<T>(fn: (tx: AuthAdapter<AccountUser, Tx>, rawTx: Tx) => Promise<T>): Promise<T> {
    if (this.opts.tx) return fn(this, this.opts.tx); // already inside one: join it
    return this.accounts.transaction((tx) => fn(new SqlAuthAdapter(this.accounts, { ...this.opts, tx }), tx));
  }
}
