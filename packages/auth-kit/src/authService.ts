import { hashPassword, verifyPassword, needsRehash } from './password.js';
import { generateOpaqueToken, hashOpaqueToken } from './tokens.js';
import { EmailTakenError } from './errors.js';
import {
  DEFAULT_EMAIL_RE,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_LOGIN_PASSWORD_SHAPE,
  validateEmail as validateEmailInput,
  validatePasswordAgainstPolicy,
  validatePasswordShape,
  type PasswordPolicy,
  type PasswordShapeLimits,
} from './validation.js';
import type {
  AuthAdapter,
  AuthIdentityRecord,
  CreateUserWithOAuthInput,
  EmailIdentityLookup,
} from './adapter.js';

// A fixed, valid-format hash with no corresponding real password, run through
// the same scrypt cost parameters as a genuine stored hash. Used to make the
// "no such identity" login path take roughly as long as the "wrong password"
// path, so response timing can't be used to enumerate registered emails.
const DUMMY_PASSWORD_HASH = 'scrypt$32768$8$1$ZHVtbXktc2FsdC1ub3QtcmVhbA$HWqAmhMrAneBoC4XifWODH-0LYZNtYWC1Tu8J4tw0fgQ_ixEMrg_BLL4gSopOZwyQP8LFxyj2Bj16oy-d-atww';

const DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_PASSWORD_RESET_TTL_SECONDS = 60 * 60;
const DEFAULT_ENUMERATION_TIMING_FLOOR_MS = 400;

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export interface AuthServiceOptions<TUser extends { id: number }, TTx = unknown> {
  adapter: AuthAdapter<TUser, TTx>;
  passwordPolicy?: Partial<PasswordPolicy>;
  loginPasswordShape?: Partial<PasswordShapeLimits>;
  emailRegex?: RegExp;
  emailMaxLength?: number;
  emailVerificationTtlSeconds?: number;
  passwordResetTtlSeconds?: number;
  enumerationTimingFloorMs?: number;
  /** Called if the best-effort rehash-on-login write fails; must never block login. Defaults to console.error. */
  onRehashError?: (err: unknown) => void;
}

export interface AuthTransactionHooks<TUser extends { id: number }, TTx = unknown> {
  beforeUserCreated?(ctx: { tx: AuthAdapter<TUser, TTx>; rawTx: TTx }): Promise<unknown>;
  afterUserCreated?(ctx: { tx: AuthAdapter<TUser, TTx>; rawTx: TTx; user: TUser; beforeResult: unknown }): Promise<void>;
}

export interface LoginResult<TUser> {
  user: TUser;
  emailVerified: boolean;
}

export class AuthService<TUser extends { id: number }, TTx = unknown> {
  private readonly adapter: AuthAdapter<TUser, TTx>;
  private readonly passwordPolicy: PasswordPolicy;
  private readonly loginPasswordShape: PasswordShapeLimits;
  private readonly emailRegex: RegExp;
  private readonly emailMaxLength: number;
  private readonly emailVerificationTtlSeconds: number;
  private readonly passwordResetTtlSeconds: number;
  private readonly enumerationTimingFloorMs: number;
  private readonly onRehashError: (err: unknown) => void;

  constructor(options: AuthServiceOptions<TUser, TTx>) {
    this.adapter = options.adapter;
    this.passwordPolicy = { ...DEFAULT_PASSWORD_POLICY, ...options.passwordPolicy };
    this.loginPasswordShape = { ...DEFAULT_LOGIN_PASSWORD_SHAPE, ...options.loginPasswordShape };
    this.emailRegex = options.emailRegex ?? DEFAULT_EMAIL_RE;
    this.emailMaxLength = options.emailMaxLength ?? 254;
    this.emailVerificationTtlSeconds = options.emailVerificationTtlSeconds ?? DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS;
    this.passwordResetTtlSeconds = options.passwordResetTtlSeconds ?? DEFAULT_PASSWORD_RESET_TTL_SECONDS;
    this.enumerationTimingFloorMs = options.enumerationTimingFloorMs ?? DEFAULT_ENUMERATION_TIMING_FLOOR_MS;
    this.onRehashError = options.onRehashError ?? ((err) => console.error('[auth] password rehash failed:', err));
  }

  // --- validation -----------------------------------------------------

  validateEmail(input: unknown): string | { error: string } {
    return validateEmailInput(input, { regex: this.emailRegex, maxLength: this.emailMaxLength });
  }

  validateRegistrationPassword(input: unknown): string | { error: string } {
    return validatePasswordAgainstPolicy(input, this.passwordPolicy);
  }

  validateLoginPasswordShape(input: unknown): string | { error: string } {
    return validatePasswordShape(input, this.loginPasswordShape);
  }

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  // --- registration / login -------------------------------------------

  async register(
    input: { email: string; password: string },
    hooks?: AuthTransactionHooks<TUser, TTx>
  ): Promise<TUser> {
    const normalizedEmail = this.normalizeEmail(input.email);
    const displayName = normalizedEmail.split('@')[0] || normalizedEmail;
    const passwordHash = await hashPassword(input.password);

    return this.adapter.runInTransaction(async (tx, rawTx) => {
      const beforeResult = await hooks?.beforeUserCreated?.({ tx, rawTx });

      const exists = await tx.userExistsWithEmail(normalizedEmail);
      if (exists) throw new EmailTakenError();

      const user = await tx.createUserWithPasswordIdentity({ normalizedEmail, passwordHash, displayName });

      if (hooks?.afterUserCreated) {
        await hooks.afterUserCreated({ tx, rawTx, user, beforeResult });
      }

      return user;
    });
  }

  async login(email: string, password: string): Promise<LoginResult<TUser> | null> {
    const normalizedEmail = this.normalizeEmail(email);
    const record = await this.adapter.findPasswordLoginRecord(normalizedEmail);

    if (!record) {
      // Burn roughly the same scrypt cost as a real verification so response
      // timing can't reveal whether the email has an account.
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      return null;
    }

    if (!(await verifyPassword(password, record.passwordHash))) return null;

    // Transparently upgrade legacy / weaker hashes now that we have the
    // plaintext. Best-effort: a failure here must never block an otherwise-
    // valid login.
    if (needsRehash(record.passwordHash)) {
      try {
        const upgraded = await hashPassword(password);
        await this.adapter.updatePasswordHash(record.user.id, upgraded, { previousHash: record.passwordHash });
      } catch (err) {
        this.onRehashError(err);
      }
    }

    return { user: record.user, emailVerified: record.emailVerified };
  }

  async upsertOAuthUser(
    input: CreateUserWithOAuthInput,
    hooks?: AuthTransactionHooks<TUser, TTx>
  ): Promise<TUser> {
    const existing = await this.adapter.findUserByProviderIdentity(input.provider, input.providerUserId);
    if (existing) {
      return this.adapter.updateOAuthProfile(existing.id, {
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        email: input.email,
      });
    }

    return this.adapter.runInTransaction(async (tx, rawTx) => {
      const beforeResult = await hooks?.beforeUserCreated?.({ tx, rawTx });

      const user = await tx.createUserWithOAuthIdentity(input);

      if (hooks?.afterUserCreated) {
        await hooks.afterUserCreated({ tx, rawTx, user, beforeResult });
      }

      return user;
    });
  }

  // --- profile / identity reads ----------------------------------------

  findUserById(id: number): Promise<TUser | null> {
    return this.adapter.findUserById(id);
  }

  findEmailIdentity(email: string): Promise<EmailIdentityLookup | null> {
    return this.adapter.findEmailIdentity(this.normalizeEmail(email));
  }

  hasPasswordIdentity(userId: number): Promise<boolean> {
    return this.adapter.hasPasswordIdentity(userId);
  }

  listIdentities(userId: number): Promise<AuthIdentityRecord[]> {
    return this.adapter.listIdentities(userId);
  }

  // --- password / session management -----------------------------------

  async setPassword(userId: number, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    await this.adapter.updatePasswordHash(userId, passwordHash);
  }

  revokeSessions(userId: number, excludeSessionId?: string): Promise<void> {
    return this.adapter.revokeUserSessions(userId, excludeSessionId);
  }

  // --- email verification -----------------------------------------------

  async createEmailVerificationToken(userId: number): Promise<string> {
    const rawToken = generateOpaqueToken();
    await this.adapter.createEmailVerificationToken(
      userId,
      hashOpaqueToken(rawToken),
      nowEpoch() + this.emailVerificationTtlSeconds
    );
    return rawToken;
  }

  consumeEmailVerificationToken(rawToken: string): Promise<number | null> {
    if (!rawToken) return Promise.resolve(null);
    return this.adapter.consumeEmailVerificationToken(hashOpaqueToken(rawToken), nowEpoch());
  }

  markEmailVerified(userId: number): Promise<void> {
    return this.adapter.markEmailVerified(userId, nowEpoch());
  }

  clearEmailVerificationTokens(userId: number): Promise<void> {
    return this.adapter.deleteEmailVerificationTokensForUser(userId);
  }

  // --- password reset ----------------------------------------------------

  async createPasswordResetToken(userId: number): Promise<string> {
    const rawToken = generateOpaqueToken();
    await this.adapter.createPasswordResetToken(
      userId,
      hashOpaqueToken(rawToken),
      nowEpoch() + this.passwordResetTtlSeconds
    );
    return rawToken;
  }

  consumePasswordResetToken(rawToken: string): Promise<number | null> {
    if (!rawToken) return Promise.resolve(null);
    return this.adapter.consumePasswordResetToken(hashOpaqueToken(rawToken), nowEpoch());
  }

  // Invalidate every outstanding reset link for a user. Call after any
  // password change so a leaked or stale link can't be used to take the
  // account back.
  clearPasswordResetTokens(userId: number): Promise<void> {
    return this.adapter.deletePasswordResetTokensForUser(userId);
  }

  // --- anti-enumeration ----------------------------------------------------

  async padToTimingFloor(startedAt: number): Promise<void> {
    const remaining = this.enumerationTimingFloorMs - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
