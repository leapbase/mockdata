import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque single-use secrets (email verification / password reset links). The
 * raw token is sent to the user and never stored; only its SHA-256 hash is
 * persisted, mirroring the "store the hash, not the secret" approach used for
 * passwords in `password.ts`.
 */

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
