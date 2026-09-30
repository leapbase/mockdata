import { describe, it, expect } from 'vitest';
import {
  validateEmail,
  validatePasswordAgainstPolicy,
  validatePasswordShape,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_LOGIN_PASSWORD_SHAPE,
} from '../src/validation.js';

describe('validateEmail', () => {
  it('accepts a trimmed, well-formed email', () => {
    expect(validateEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('rejects malformed or oversized input', () => {
    expect(validateEmail('not-an-email')).toEqual({ error: 'Enter a valid email address' });
    expect(validateEmail(123)).toEqual({ error: 'Enter a valid email address' });
    expect(validateEmail(`${'a'.repeat(250)}@example.com`)).toEqual({ error: 'Enter a valid email address' });
  });
});

describe('validatePasswordAgainstPolicy', () => {
  it('enforces the default policy (12-128, all character classes)', () => {
    expect(validatePasswordAgainstPolicy('Sh0rt!', DEFAULT_PASSWORD_POLICY)).toEqual({
      error: 'Password must be 12 to 128 characters',
    });
    expect(validatePasswordAgainstPolicy('alllowercase1!', DEFAULT_PASSWORD_POLICY)).toEqual({
      error: 'Password must contain an uppercase letter',
    });
    expect(validatePasswordAgainstPolicy('Valid1Password!', DEFAULT_PASSWORD_POLICY)).toBe('Valid1Password!');
  });

  it('respects a relaxed custom policy', () => {
    const relaxed = { ...DEFAULT_PASSWORD_POLICY, requireSpecialChar: false };
    expect(validatePasswordAgainstPolicy('Valid1Password', relaxed)).toBe('Valid1Password');
  });
});

describe('validatePasswordShape', () => {
  it('enforces only length, matching today\'s login-time check', () => {
    expect(validatePasswordShape('short', DEFAULT_LOGIN_PASSWORD_SHAPE)).toEqual({
      error: 'Password must be 8 to 128 characters',
    });
    expect(validatePasswordShape('anylongenough', DEFAULT_LOGIN_PASSWORD_SHAPE)).toBe('anylongenough');
  });
});
