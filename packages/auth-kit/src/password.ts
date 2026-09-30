import crypto from 'node:crypto';

// Manual wrapper (not util.promisify) so we can pass the scrypt options overload
// with N/r/p/maxmem — the promisified type only exposes the 3-argument form.
function scrypt(password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, options: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
}
const KEY_LENGTH = 64;

// Current scrypt cost parameters. N is the CPU/memory cost; 2^15 roughly doubles
// the work vs Node's default 2^14. r/p are standard. maxmem must be raised above
// Node's 32 MiB default because scrypt needs ~128*N*r bytes (~32 MiB at these
// params) plus overhead, or it throws "memory limit exceeded".
export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

// Node's historical defaults, used to verify legacy hashes stored in the old
// parameterless `scrypt$salt$hash` format.
const LEGACY_N = 16384;
const LEGACY_R = 8;
const LEGACY_P = 1;

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

function parseStoredHash(storedHash: string): ParsedHash | null {
  const parts = storedHash.split('$');
  // New format: scrypt$N$r$p$salt$hash
  if (parts.length === 6 && parts[0] === 'scrypt') {
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
    if (!parts[4] || !parts[5]) return null;
    return { N, r, p, salt: parts[4], hash: parts[5] };
  }
  // Legacy format: scrypt$salt$hash (implicit Node defaults).
  if (parts.length === 3 && parts[0] === 'scrypt' && parts[1] && parts[2]) {
    return { N: LEGACY_N, r: LEGACY_R, p: LEGACY_P, salt: parts[1], hash: parts[2] };
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return false;

  const expected = Buffer.from(parsed.hash, 'base64url');
  const actual = await scrypt(password, parsed.salt, expected.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * True when a stored hash uses the legacy format or weaker-than-current cost
 * parameters, signalling the caller should transparently re-hash the password
 * (with the current parameters) after a successful login.
 */
export function needsRehash(storedHash: string): boolean {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return true;
  return parsed.N < SCRYPT_N || parsed.r < SCRYPT_R || parsed.p < SCRYPT_P;
}
