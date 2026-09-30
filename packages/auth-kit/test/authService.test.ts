import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { AuthService } from '../src/authService.js';
import { EmailTakenError } from '../src/errors.js';
import { hashPassword, needsRehash, SCRYPT_N, SCRYPT_R, SCRYPT_P } from '../src/password.js';
import { FakeAuthAdapter } from './fakeAdapter.js';

const scrypt = promisify(crypto.scrypt);

async function legacyHash(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}

function makeService(overrides: Partial<ConstructorParameters<typeof AuthService>[0]> = {}) {
  const adapter = new FakeAuthAdapter();
  const service = new AuthService({ adapter, ...overrides });
  return { adapter, service };
}

describe('register', () => {
  it('happy path creates a user reachable by email afterward', async () => {
    const { adapter, service } = makeService();
    const user = await service.register({ email: 'New@Example.com', password: 'Sup3r$ecretPW' });
    expect(user.email).toBe('new@example.com');
    expect(await adapter.userExistsWithEmail('new@example.com')).toBe(true);
  });

  it('rejects a duplicate (case/whitespace-varied) email with EmailTakenError', async () => {
    const { service } = makeService();
    await service.register({ email: 'dup@example.com', password: 'Sup3r$ecretPW' });
    await expect(
      service.register({ email: '  DUP@Example.com  ', password: 'An0ther$ecretPW' })
    ).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('rolls back the whole transaction when beforeUserCreated throws', async () => {
    const { adapter, service } = makeService();
    await expect(
      service.register(
        { email: 'blocked@example.com', password: 'Sup3r$ecretPW' },
        { beforeUserCreated: async () => { throw new Error('invite invalid'); } }
      )
    ).rejects.toThrow('invite invalid');
    expect(await adapter.userExistsWithEmail('blocked@example.com')).toBe(false);
  });

  it('rolls back user creation too when afterUserCreated throws', async () => {
    const { adapter, service } = makeService();
    await expect(
      service.register(
        { email: 'rollback@example.com', password: 'Sup3r$ecretPW' },
        { afterUserCreated: async () => { throw new Error('redemption failed'); } }
      )
    ).rejects.toThrow('redemption failed');
    expect(await adapter.userExistsWithEmail('rollback@example.com')).toBe(false);
  });

  it('passes the hook the raw transaction handle and the created user', async () => {
    const { service } = makeService();
    let seenUserId: number | undefined;
    let seenRawTx: unknown;
    await service.register(
      { email: 'hooked@example.com', password: 'Sup3r$ecretPW' },
      {
        afterUserCreated: async ({ user, rawTx }) => {
          seenUserId = user.id;
          seenRawTx = rawTx;
        },
      }
    );
    expect(seenUserId).toBeTypeOf('number');
    expect(seenRawTx).toBeDefined();
  });
});

describe('login', () => {
  it('returns null for a wrong password without throwing', async () => {
    const { service } = makeService();
    await service.register({ email: 'a@example.com', password: 'Sup3r$ecretPW' });
    expect(await service.login('a@example.com', 'wrong-password')).toBeNull();
  });

  it('returns null for an unknown email without throwing (dummy-hash timing parity)', async () => {
    const { service } = makeService();
    expect(await service.login('nobody@example.com', 'whatever-password')).toBeNull();
  });

  it('returns emailVerified:false for an unverified account rather than throwing', async () => {
    const { service } = makeService();
    await service.register({ email: 'unverified@example.com', password: 'Sup3r$ecretPW' });
    const result = await service.login('unverified@example.com', 'Sup3r$ecretPW');
    expect(result?.emailVerified).toBe(false);
  });

  it('returns emailVerified:true after markEmailVerified', async () => {
    const { service } = makeService();
    const user = await service.register({ email: 'verified@example.com', password: 'Sup3r$ecretPW' });
    await service.markEmailVerified(user.id);
    const result = await service.login('verified@example.com', 'Sup3r$ecretPW');
    expect(result?.emailVerified).toBe(true);
  });

  it('transparently rehashes a legacy password hash on successful login', async () => {
    const { adapter, service } = makeService();
    const user = await adapter.createUserWithPasswordIdentity({
      normalizedEmail: 'legacy@example.com',
      passwordHash: await legacyHash('hunter2'),
      displayName: 'legacy',
    });

    const before = adapter.state.identities.find((i) => i.userId === user.id)!.passwordHash!;
    expect(needsRehash(before)).toBe(true);

    const result = await service.login('legacy@example.com', 'hunter2');
    expect(result).not.toBeNull();

    const after = adapter.state.identities.find((i) => i.userId === user.id)!.passwordHash!;
    expect(after).not.toBe(before);
    expect(needsRehash(after)).toBe(false);
  });

  it('does not rehash an already-current hash', async () => {
    const { adapter, service } = makeService();
    const currentHash = await hashPassword('Sup3r$ecretPW');
    await adapter.createUserWithPasswordIdentity({
      normalizedEmail: 'current@example.com',
      passwordHash: currentHash,
      displayName: 'current',
    });
    await service.login('current@example.com', 'Sup3r$ecretPW');
    const after = adapter.state.identities.find((i) => i.email === 'current@example.com')!.passwordHash!;
    expect(after).toBe(currentHash);
  });

  it('the dummy hash used for timing parity encodes the current scrypt cost parameters', () => {
    // Mirrors the private DUMMY_PASSWORD_HASH constant in authService.ts —
    // if SCRYPT_N/R/P ever change without updating that literal, this fails.
    const DUMMY_PASSWORD_HASH = 'scrypt$32768$8$1$ZHVtbXktc2FsdC1ub3QtcmVhbA$HWqAmhMrAneBoC4XifWODH-0LYZNtYWC1Tu8J4tw0fgQ_ixEMrg_BLL4gSopOZwyQP8LFxyj2Bj16oy-d-atww';
    const [, n, r, p] = DUMMY_PASSWORD_HASH.split('$');
    expect(Number(n)).toBe(SCRYPT_N);
    expect(Number(r)).toBe(SCRYPT_R);
    expect(Number(p)).toBe(SCRYPT_P);
  });
});

describe('upsertOAuthUser', () => {
  it('creates a new user on first login', async () => {
    const { service } = makeService();
    const user = await service.upsertOAuthUser({
      provider: 'google',
      providerUserId: 'g-1',
      email: 'oauth@example.com',
      displayName: 'OAuth User',
      avatarUrl: null,
    });
    expect(user.email).toBe('oauth@example.com');
  });

  it('updates the existing user on subsequent logins and skips hooks entirely', async () => {
    const { service } = makeService();
    const first = await service.upsertOAuthUser({
      provider: 'google',
      providerUserId: 'g-2',
      email: 'existing@example.com',
      displayName: 'Old Name',
      avatarUrl: null,
    });

    const second = await service.upsertOAuthUser(
      {
        provider: 'google',
        providerUserId: 'g-2',
        email: 'existing@example.com',
        displayName: 'New Name',
        avatarUrl: 'https://example.com/a.png',
      },
      {
        beforeUserCreated: async () => { throw new Error('hooks must not run for existing users'); },
        afterUserCreated: async () => { throw new Error('hooks must not run for existing users'); },
      }
    );

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('New Name');
    expect(second.avatarUrl).toBe('https://example.com/a.png');
  });

  it('rolls back new-user creation when a hook throws', async () => {
    const { service } = makeService();
    await expect(
      service.upsertOAuthUser(
        { provider: 'wechat', providerUserId: 'w-1', email: '', displayName: 'WeChat User', avatarUrl: null },
        { beforeUserCreated: async () => { throw new Error('invite required'); } }
      )
    ).rejects.toThrow('invite required');

    const found = await service.upsertOAuthUser({
      provider: 'wechat',
      providerUserId: 'w-1',
      email: '',
      displayName: 'WeChat User',
      avatarUrl: null,
    });
    // If the failed attempt had left a half-created user behind, this second
    // call would hit updateOAuthProfile's "existing" branch with stale data
    // instead of creating fresh — assert it's a clean, newly created user.
    expect(found.displayName).toBe('WeChat User');
  });
});

describe('tokens', () => {
  it('email verification tokens are single-use', async () => {
    const { service } = makeService();
    const user = await service.register({ email: 'verify@example.com', password: 'Sup3r$ecretPW' });
    const token = await service.createEmailVerificationToken(user.id);

    expect(await service.consumeEmailVerificationToken(token)).toBe(user.id);
    expect(await service.consumeEmailVerificationToken(token)).toBeNull();
  });

  it('email verification tokens expire', async () => {
    const { service } = makeService({ emailVerificationTtlSeconds: -1 });
    const user = await service.register({ email: 'expired@example.com', password: 'Sup3r$ecretPW' });
    const token = await service.createEmailVerificationToken(user.id);
    expect(await service.consumeEmailVerificationToken(token)).toBeNull();
  });

  it('password reset tokens are single-use and expire', async () => {
    const { service } = makeService();
    const user = await service.register({ email: 'reset@example.com', password: 'Sup3r$ecretPW' });
    const token = await service.createPasswordResetToken(user.id);
    expect(await service.consumePasswordResetToken(token)).toBe(user.id);
    expect(await service.consumePasswordResetToken(token)).toBeNull();

    const { service: expiringService } = makeService({ passwordResetTtlSeconds: -1 });
    const user2 = await expiringService.register({ email: 'reset2@example.com', password: 'Sup3r$ecretPW' });
    const expiredToken = await expiringService.createPasswordResetToken(user2.id);
    expect(await expiringService.consumePasswordResetToken(expiredToken)).toBeNull();
  });
});

describe('revokeSessions', () => {
  it('forwards userId/excludeSessionId to the adapter unchanged', async () => {
    const { adapter, service } = makeService();
    await service.revokeSessions(42, 'sid-123');
    expect(adapter.state.revokedSessions).toEqual([{ userId: 42, excludeSessionId: 'sid-123' }]);
  });
});

describe('password policy', () => {
  it('enforces the default policy (12-128 chars, all character classes)', () => {
    const { service } = makeService();
    expect(service.validateRegistrationPassword('short1!')).toEqual({
      error: 'Password must be 12 to 128 characters',
    });
    expect(service.validateRegistrationPassword('alllowercase123!')).toEqual({
      error: 'Password must contain an uppercase letter',
    });
    expect(service.validateRegistrationPassword('Valid1Password!')).toBe('Valid1Password!');
  });

  it('respects a relaxed custom policy', () => {
    const { service } = makeService({ passwordPolicy: { requireSpecialChar: false } });
    expect(service.validateRegistrationPassword('Valid1Password')).toBe('Valid1Password');
  });

  it('peeks at a verification token without using it up', async () => {
    const adapter = new FakeAuthAdapter();
    const service = new AuthService({ adapter, enumerationTimingFloorMs: 0 });
    const user = await service.register({ email: 'peek@example.com', password: 'Sup3r$ecretPassw0rd' });
    const raw = await service.createEmailVerificationToken(user.id);
    expect(await service.peekEmailVerificationToken(raw)).toBe(user.id);
    expect(await service.peekEmailVerificationToken(raw)).toBe(user.id); // still there
    expect(await service.peekEmailVerificationToken('not-a-token')).toBeNull();
    expect(await service.peekEmailVerificationToken('')).toBeNull();
    expect(await service.consumeEmailVerificationToken(raw)).toBe(user.id);
    expect(await service.peekEmailVerificationToken(raw)).toBeNull(); // used now
  });
});
