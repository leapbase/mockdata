export interface EmailIdentityLookup {
  userId: number;
  email: string | null;
  verified: boolean;
}

export interface AuthIdentityRecord {
  provider: string;
  hasPassword: boolean;
  email: string | null;
  emailVerified: boolean;
  createdAt: number;
}

export interface PasswordLoginRecord<TUser> {
  user: TUser;
  passwordHash: string;
  emailVerified: boolean;
}

export interface CreateUserWithPasswordInput {
  normalizedEmail: string;
  passwordHash: string;
  displayName: string;
}

export interface CreateUserWithOAuthInput {
  provider: string;
  providerUserId: string;
  /** '' when the provider has no email (e.g. WeChat). */
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** Maps to legacy single-column OAuth-id storage (e.g. itravelmap's `users.google_id`). */
  legacyProviderId?: string;
}

export interface UpdateOAuthProfileInput {
  displayName: string;
  avatarUrl: string | null;
  /** '' means "don't overwrite the existing email" (COALESCE semantics). */
  email: string;
}

/**
 * Dumb CRUD, implemented by the host app against its own schema. All security
 * logic (password hashing, timing-attack defenses, token TTLs, email
 * normalization) lives in `AuthService`, not here.
 *
 * `TTx` is the backend's raw transaction handle (e.g. a Postgres `Queryable`
 * client) — opaque to this package, but exposed by `runInTransaction` so a
 * host app's transaction hooks (see `AuthTransactionHooks`) can run
 * additional, app-specific writes on the SAME connection/transaction as user
 * creation, preserving atomicity for features (like invite-code redemption)
 * that have nothing to do with generic auth.
 */
export interface AuthAdapter<TUser extends { id: number }, TTx = unknown> {
  findUserById(id: number): Promise<TUser | null>;
  findUserByProviderIdentity(provider: string, providerUserId: string): Promise<TUser | null>;
  userExistsWithEmail(normalizedEmail: string): Promise<boolean>;
  findEmailIdentity(normalizedEmail: string): Promise<EmailIdentityLookup | null>;
  findPasswordLoginRecord(normalizedEmail: string): Promise<PasswordLoginRecord<TUser> | null>;
  hasPasswordIdentity(userId: number): Promise<boolean>;
  listIdentities(userId: number): Promise<AuthIdentityRecord[]>;

  createUserWithPasswordIdentity(input: CreateUserWithPasswordInput): Promise<TUser>;
  createUserWithOAuthIdentity(input: CreateUserWithOAuthInput): Promise<TUser>;
  updateOAuthProfile(userId: number, input: UpdateOAuthProfileInput): Promise<TUser>;
  updatePasswordHash(userId: number, newHash: string, opts?: { previousHash?: string }): Promise<void>;

  createEmailVerificationToken(userId: number, tokenHash: string, expiresAtEpochSeconds: number): Promise<void>;
  consumeEmailVerificationToken(tokenHash: string, nowEpochSeconds: number): Promise<number | null>;
  markEmailVerified(userId: number, nowEpochSeconds: number): Promise<void>;
  deleteEmailVerificationTokensForUser(userId: number): Promise<void>;

  createPasswordResetToken(userId: number, tokenHash: string, expiresAtEpochSeconds: number): Promise<void>;
  consumePasswordResetToken(tokenHash: string, nowEpochSeconds: number): Promise<number | null>;
  deletePasswordResetTokensForUser(userId: number): Promise<void>;

  revokeUserSessions(userId: number, excludeSessionId?: string): Promise<void>;

  runInTransaction<T>(fn: (tx: AuthAdapter<TUser, TTx>, rawTx: TTx) => Promise<T>): Promise<T>;
}
