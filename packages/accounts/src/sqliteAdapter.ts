import { randomBytes } from "node:crypto";
import { EmailTakenError, hashOpaqueToken, type AuthAdapter, type AuthIdentityRecord, type CreateUserWithOAuthInput, type CreateUserWithPasswordInput, type EmailIdentityLookup, type PasswordLoginRecord, type UpdateOAuthProfileInput } from "@mockdata/auth-kit";
import type { AccountsDb } from "./db.js";

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

const isUnique = (e: unknown): boolean => (e as { errcode?: number })?.errcode === 2067 || /UNIQUE constraint failed/.test(String((e as Error)?.message));

/** AuthAdapter over the account database. Timestamps are epoch seconds. */
export class SqliteAuthAdapter implements AuthAdapter<AccountUser, AccountsDb["raw"]> {
  constructor(
    private readonly accounts: AccountsDb,
    private readonly opts: { now?: () => number; inTransaction?: boolean } = {},
  ) {}

  private get db() {
    return this.accounts.raw;
  }
  private now(): number {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }
  private call<T>(fn: () => T): Promise<T> {
    return this.opts.inTransaction ? Promise.resolve().then(fn) : this.accounts.gated(fn);
  }
  /** Several statements that must succeed or fail together, also usable inside an outer transaction. */
  private atomic<T>(fn: () => T): T {
    this.db.exec("savepoint atomic_op");
    try {
      const result = fn();
      this.db.exec("release atomic_op");
      return result;
    } catch (e) {
      this.db.exec("rollback to atomic_op; release atomic_op");
      throw e;
    }
  }

  findUserById(id: number): Promise<AccountUser | null> {
    return this.call(() => {
      const r = this.db.prepare("select * from users where id = ?").get(id) as UserRow | undefined;
      return r ? rowToUser(r) : null;
    });
  }

  findUserByProviderIdentity(provider: string, providerUserId: string): Promise<AccountUser | null> {
    return this.call(() => {
      const r = this.db
        .prepare("select u.* from users u join identities i on i.user_id = u.id where i.provider = ? and i.provider_user_id = ?")
        .get(provider, providerUserId) as UserRow | undefined;
      return r ? rowToUser(r) : null;
    });
  }

  userExistsWithEmail(normalizedEmail: string): Promise<boolean> {
    return this.call(() => !!this.db.prepare("select 1 from identities where provider = 'email' and lower(email) = lower(?)").get(normalizedEmail));
  }

  findEmailIdentity(normalizedEmail: string): Promise<EmailIdentityLookup | null> {
    return this.call(() => {
      const r = this.db
        .prepare("select user_id, email, email_verified_at from identities where provider = 'email' and lower(email) = lower(?)")
        .get(normalizedEmail) as { user_id: number; email: string | null; email_verified_at: number | null } | undefined;
      return r ? { userId: r.user_id, email: r.email, verified: r.email_verified_at !== null } : null;
    });
  }

  findPasswordLoginRecord(normalizedEmail: string): Promise<PasswordLoginRecord<AccountUser> | null> {
    return this.call(() => {
      const r = this.db
        .prepare(
          `select u.*, i.password_hash, i.email_verified_at from users u join identities i on i.user_id = u.id
           where i.provider = 'email' and lower(i.email) = lower(?) and i.password_hash is not null`,
        )
        .get(normalizedEmail) as (UserRow & { password_hash: string; email_verified_at: number | null }) | undefined;
      return r ? { user: rowToUser(r), passwordHash: r.password_hash, emailVerified: r.email_verified_at !== null } : null;
    });
  }

  hasPasswordIdentity(userId: number): Promise<boolean> {
    return this.call(() => !!this.db.prepare("select 1 from identities where user_id = ? and password_hash is not null").get(userId));
  }

  listIdentities(userId: number): Promise<AuthIdentityRecord[]> {
    return this.call(() =>
      (this.db
        .prepare("select provider, password_hash is not null as has_password, email, email_verified_at, created_at from identities where user_id = ? order by id")
        .all(userId) as { provider: string; has_password: number; email: string | null; email_verified_at: number | null; created_at: number }[]).map((r) => ({
        provider: r.provider,
        hasPassword: r.has_password === 1,
        email: r.email,
        emailVerified: r.email_verified_at !== null,
        createdAt: r.created_at,
      })),
    );
  }

  private insertUser(email: string | null, displayName: string, avatarUrl: string | null): UserRow {
    return this.db
      .prepare("insert into users (dir_id, email, display_name, avatar_url, created_at) values (?, ?, ?, ?, ?) returning *")
      .get(randomBytes(16).toString("hex"), email, displayName, avatarUrl, this.now()) as unknown as UserRow;
  }

  createUserWithPasswordIdentity(input: CreateUserWithPasswordInput): Promise<AccountUser> {
    return this.call(() => {
      try {
        return this.atomic(() => {
          const user = this.insertUser(input.normalizedEmail, input.displayName, null);
          const now = this.now();
          this.db
            .prepare("insert into identities (user_id, provider, provider_user_id, email, password_hash, created_at, updated_at) values (?, 'email', ?, ?, ?, ?, ?)")
            .run(user.id, input.normalizedEmail, input.normalizedEmail, input.passwordHash, now, now);
          return rowToUser(user);
        });
      } catch (e) {
        if (isUnique(e)) throw new EmailTakenError();
        throw e;
      }
    });
  }

  createUserWithOAuthIdentity(input: CreateUserWithOAuthInput): Promise<AccountUser> {
    return this.call(() =>
      this.atomic(() => {
        const email = input.email || null;
        const user = this.insertUser(email, input.displayName, input.avatarUrl);
        const now = this.now();
        this.db
          .prepare("insert into identities (user_id, provider, provider_user_id, email, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
          .run(user.id, input.provider, input.providerUserId, email, now, now);
        return rowToUser(user);
      }),
    );
  }

  updateOAuthProfile(userId: number, input: UpdateOAuthProfileInput): Promise<AccountUser> {
    return this.call(() => {
      const r = this.db
        .prepare("update users set display_name = ?, avatar_url = ?, email = coalesce(nullif(?, ''), email) where id = ? returning *")
        .get(input.displayName, input.avatarUrl, input.email, userId) as UserRow | undefined;
      if (!r) throw new Error("No such user");
      return rowToUser(r);
    });
  }

  updatePasswordHash(userId: number, newHash: string, opts?: { previousHash?: string }): Promise<void> {
    return this.call(() => {
      if (opts?.previousHash !== undefined) {
        this.db
          .prepare("update identities set password_hash = ?, updated_at = ? where user_id = ? and provider = 'email' and password_hash = ?")
          .run(newHash, this.now(), userId, opts.previousHash);
      } else {
        this.db.prepare("update identities set password_hash = ?, updated_at = ? where user_id = ? and provider = 'email'").run(newHash, this.now(), userId);
      }
    });
  }

  private createToken(table: string, userId: number, tokenHash: string, expiresAt: number): Promise<void> {
    return this.call(() => {
      this.db.prepare(`insert into ${table} (user_id, token_hash, expires_at, created_at) values (?, ?, ?, ?)`).run(userId, tokenHash, expiresAt, this.now());
    });
  }
  /** One atomic step: mark used where still unused and unexpired, returning whose token it was. */
  private consumeToken(table: string, tokenHash: string, now: number): Promise<number | null> {
    return this.call(() => {
      const r = this.db
        .prepare(`update ${table} set used_at = ? where token_hash = ? and used_at is null and expires_at > ? returning user_id`)
        .get(now, tokenHash, now) as { user_id: number } | undefined;
      return r ? r.user_id : null;
    });
  }
  private deleteTokens(table: string, userId: number): Promise<void> {
    return this.call(() => {
      this.db.prepare(`delete from ${table} where user_id = ?`).run(userId);
    });
  }

  createEmailVerificationToken(userId: number, tokenHash: string, expiresAt: number): Promise<void> {
    return this.createToken("email_verification_tokens", userId, tokenHash, expiresAt);
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

  markEmailVerified(userId: number, now: number): Promise<void> {
    return this.call(() => {
      this.db.prepare("update identities set email_verified_at = ?, updated_at = ? where user_id = ? and provider = 'email' and email_verified_at is null").run(now, now, userId);
    });
  }

  /** `excludeSessionId` is the raw session token to keep (it is hashed here, like every stored session). */
  revokeUserSessions(userId: number, excludeSessionId?: string): Promise<void> {
    return this.call(() => {
      if (excludeSessionId) this.db.prepare("delete from sessions where user_id = ? and id_hash <> ?").run(userId, sessionKey(excludeSessionId));
      else this.db.prepare("delete from sessions where user_id = ?").run(userId);
    });
  }

  runInTransaction<T>(fn: (tx: AuthAdapter<AccountUser, AccountsDb["raw"]>, rawTx: AccountsDb["raw"]) => Promise<T>): Promise<T> {
    if (this.opts.inTransaction) return fn(this, this.db); // already inside one: join it
    return this.accounts.gated(async () => {
      this.db.exec("begin immediate");
      try {
        const result = await fn(new SqliteAuthAdapter(this.accounts, { ...this.opts, inTransaction: true }), this.db);
        this.db.exec("commit");
        return result;
      } catch (e) {
        this.db.exec("rollback");
        throw e;
      }
    });
  }
}
