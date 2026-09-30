import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { hashPassword, verifyPassword, needsRehash } from '../src/password.js';

const scrypt = promisify(crypto.scrypt);

// Reproduce the legacy `scrypt$salt$hash` format (Node default params) that
// predates cost-parameter encoding, to prove backward compatibility.
async function legacyHash(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}

describe('password hashing', () => {
  it('round-trips a password with the current (versioned) format', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.split('$')).toHaveLength(6);
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('still verifies legacy parameterless hashes', async () => {
    const stored = await legacyHash('hunter2');
    expect(stored.split('$')).toHaveLength(3);
    expect(await verifyPassword('hunter2', stored)).toBe(true);
    expect(await verifyPassword('nope', stored)).toBe(false);
  });

  it('flags legacy and weaker hashes for rehash, not current ones', async () => {
    expect(needsRehash(await legacyHash('x'))).toBe(true);
    expect(needsRehash('scrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(true); // weaker N
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });

  it('rejects malformed hashes without throwing', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$foo$bar')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$notanumber$8$1$salt$hash')).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });
});
