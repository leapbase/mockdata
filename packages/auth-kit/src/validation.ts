export const DEFAULT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecialChar: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialChar: true,
};

export interface PasswordShapeLimits {
  minLength: number;
  maxLength: number;
}

export const DEFAULT_LOGIN_PASSWORD_SHAPE: PasswordShapeLimits = {
  minLength: 8,
  maxLength: 128,
};

export function validateEmail(
  input: unknown,
  opts?: { regex?: RegExp; maxLength?: number }
): string | { error: string } {
  const regex = opts?.regex ?? DEFAULT_EMAIL_RE;
  const maxLength = opts?.maxLength ?? 254;
  if (typeof input !== 'string' || !regex.test(input.trim()) || input.trim().length > maxLength) {
    return { error: 'Enter a valid email address' };
  }
  return input.trim();
}

export function validatePasswordAgainstPolicy(input: unknown, policy: PasswordPolicy): string | { error: string } {
  if (typeof input !== 'string' || input.length < policy.minLength || input.length > policy.maxLength) {
    return { error: `Password must be ${policy.minLength} to ${policy.maxLength} characters` };
  }
  const missing: string[] = [];
  if (policy.requireUppercase && !/[A-Z]/.test(input)) missing.push('an uppercase letter');
  if (policy.requireLowercase && !/[a-z]/.test(input)) missing.push('a lowercase letter');
  if (policy.requireNumber && !/[0-9]/.test(input)) missing.push('a number');
  if (policy.requireSpecialChar && !/[^A-Za-z0-9]/.test(input)) missing.push('a special character');
  if (missing.length > 0) {
    return { error: `Password must contain ${missing.join(', ')}` };
  }
  return input;
}

export function validatePasswordShape(input: unknown, limits: PasswordShapeLimits): string | { error: string } {
  if (typeof input !== 'string' || input.length < limits.minLength || input.length > limits.maxLength) {
    return { error: `Password must be ${limits.minLength} to ${limits.maxLength} characters` };
  }
  return input;
}
