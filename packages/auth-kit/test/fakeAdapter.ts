import type {
  AuthAdapter,
  AuthIdentityRecord,
  CreateUserWithOAuthInput,
  CreateUserWithPasswordInput,
  EmailIdentityLookup,
  PasswordLoginRecord,
  UpdateOAuthProfileInput,
} from '../src/adapter.js';

export interface FakeUser {
  id: number;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

interface FakeIdentity {
  userId: number;
  provider: string;
  providerUserId: string;
  email: string | null;
  passwordHash: string | null;
  emailVerifiedAt: number | null;
  createdAt: number;
}

interface FakeToken {
  userId: number;
  expiresAt: number;
  usedAt: number | null;
}

interface FakeState {
  nextId: number;
  users: Map<number, FakeUser>;
  identities: FakeIdentity[];
  verificationTokens: Map<string, FakeToken>;
  resetTokens: Map<string, FakeToken>;
  revokedSessions: Array<{ userId: number; excludeSessionId?: string }>;
}

function emptyState(): FakeState {
  return {
    nextId: 1,
    users: new Map(),
    identities: [],
    verificationTokens: new Map(),
    resetTokens: new Map(),
    revokedSessions: [],
  };
}

/**
 * In-memory AuthAdapter for package-level tests — no real DB. `runInTransaction`
 * snapshots state before running the callback and restores it on throw, so
 * tests can exercise the "a transaction hook failure rolls back user
 * creation too" guarantee without a real database transaction.
 */
export class FakeAuthAdapter implements AuthAdapter<FakeUser, FakeState> {
  state: FakeState = emptyState();

  private snapshot(): FakeState {
    return structuredClone(this.state);
  }

  async findUserById(id: number): Promise<FakeUser | null> {
    return this.state.users.get(id) ?? null;
  }

  async findUserByProviderIdentity(provider: string, providerUserId: string): Promise<FakeUser | null> {
    const identity = this.state.identities.find((i) => i.provider === provider && i.providerUserId === providerUserId);
    if (!identity) return null;
    return this.state.users.get(identity.userId) ?? null;
  }

  async userExistsWithEmail(normalizedEmail: string): Promise<boolean> {
    for (const user of this.state.users.values()) {
      if (user.email?.toLowerCase() === normalizedEmail) return true;
    }
    return false;
  }

  async findEmailIdentity(normalizedEmail: string): Promise<EmailIdentityLookup | null> {
    const identity = this.state.identities.find((i) => i.provider === 'email' && i.providerUserId === normalizedEmail);
    if (!identity) return null;
    return { userId: identity.userId, email: identity.email, verified: identity.emailVerifiedAt !== null };
  }

  async findPasswordLoginRecord(normalizedEmail: string): Promise<PasswordLoginRecord<FakeUser> | null> {
    const identity = this.state.identities.find(
      (i) => i.provider === 'email' && i.providerUserId === normalizedEmail && i.passwordHash
    );
    if (!identity || !identity.passwordHash) return null;
    const user = this.state.users.get(identity.userId);
    if (!user) return null;
    return { user, passwordHash: identity.passwordHash, emailVerified: identity.emailVerifiedAt !== null };
  }

  async hasPasswordIdentity(userId: number): Promise<boolean> {
    return this.state.identities.some((i) => i.userId === userId && i.provider === 'email' && !!i.passwordHash);
  }

  async listIdentities(userId: number): Promise<AuthIdentityRecord[]> {
    return this.state.identities
      .filter((i) => i.userId === userId)
      .map((i) => ({
        provider: i.provider,
        hasPassword: Boolean(i.passwordHash),
        email: i.email,
        emailVerified: i.emailVerifiedAt !== null,
        createdAt: i.createdAt,
      }));
  }

  async createUserWithPasswordIdentity(input: CreateUserWithPasswordInput): Promise<FakeUser> {
    const id = this.state.nextId++;
    const user: FakeUser = { id, email: input.normalizedEmail, displayName: input.displayName, avatarUrl: null };
    this.state.users.set(id, user);
    this.state.identities.push({
      userId: id,
      provider: 'email',
      providerUserId: input.normalizedEmail,
      email: input.normalizedEmail,
      passwordHash: input.passwordHash,
      emailVerifiedAt: null,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return user;
  }

  async createUserWithOAuthIdentity(input: CreateUserWithOAuthInput): Promise<FakeUser> {
    const id = this.state.nextId++;
    const user: FakeUser = { id, email: input.email || null, displayName: input.displayName, avatarUrl: input.avatarUrl };
    this.state.users.set(id, user);
    this.state.identities.push({
      userId: id,
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: input.email || null,
      passwordHash: null,
      emailVerifiedAt: null,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return user;
  }

  async updateOAuthProfile(userId: number, input: UpdateOAuthProfileInput): Promise<FakeUser> {
    const user = this.state.users.get(userId);
    if (!user) throw new Error('user not found');
    user.displayName = input.displayName;
    user.avatarUrl = input.avatarUrl;
    if (input.email) user.email = input.email;
    return user;
  }

  async updatePasswordHash(userId: number, newHash: string, opts?: { previousHash?: string }): Promise<void> {
    const identity = this.state.identities.find((i) => i.userId === userId && i.provider === 'email');
    if (!identity) return;
    if (opts?.previousHash && identity.passwordHash !== opts.previousHash) return;
    identity.passwordHash = newHash;
  }

  async createEmailVerificationToken(userId: number, tokenHash: string, expiresAtEpochSeconds: number): Promise<void> {
    this.state.verificationTokens.set(tokenHash, { userId, expiresAt: expiresAtEpochSeconds, usedAt: null });
  }

  async peekEmailVerificationToken(tokenHash: string, nowEpochSeconds: number): Promise<number | null> {
    const token = this.state.verificationTokens.get(tokenHash);
    if (!token || token.usedAt !== null || token.expiresAt <= nowEpochSeconds) return null;
    return token.userId;
  }

  async consumeEmailVerificationToken(tokenHash: string, nowEpochSeconds: number): Promise<number | null> {
    const token = this.state.verificationTokens.get(tokenHash);
    if (!token || token.usedAt !== null || token.expiresAt <= nowEpochSeconds) return null;
    token.usedAt = nowEpochSeconds;
    return token.userId;
  }

  async markEmailVerified(userId: number, nowEpochSeconds: number): Promise<void> {
    const identity = this.state.identities.find((i) => i.userId === userId && i.provider === 'email');
    if (identity && identity.emailVerifiedAt === null) identity.emailVerifiedAt = nowEpochSeconds;
  }

  async deleteEmailVerificationTokensForUser(userId: number): Promise<void> {
    for (const [hash, token] of this.state.verificationTokens) {
      if (token.userId === userId) this.state.verificationTokens.delete(hash);
    }
  }

  async createPasswordResetToken(userId: number, tokenHash: string, expiresAtEpochSeconds: number): Promise<void> {
    this.state.resetTokens.set(tokenHash, { userId, expiresAt: expiresAtEpochSeconds, usedAt: null });
  }

  async consumePasswordResetToken(tokenHash: string, nowEpochSeconds: number): Promise<number | null> {
    const token = this.state.resetTokens.get(tokenHash);
    if (!token || token.usedAt !== null || token.expiresAt <= nowEpochSeconds) return null;
    token.usedAt = nowEpochSeconds;
    return token.userId;
  }

  async deletePasswordResetTokensForUser(userId: number): Promise<void> {
    for (const [hash, token] of this.state.resetTokens) {
      if (token.userId === userId) this.state.resetTokens.delete(hash);
    }
  }

  async revokeUserSessions(userId: number, excludeSessionId?: string): Promise<void> {
    this.state.revokedSessions.push({ userId, excludeSessionId });
  }

  async runInTransaction<T>(fn: (tx: AuthAdapter<FakeUser, FakeState>, rawTx: FakeState) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();
    try {
      return await fn(this, this.state);
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }
}
