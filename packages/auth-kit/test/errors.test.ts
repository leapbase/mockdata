import { describe, it, expect } from 'vitest';
import { AuthError, EmailTakenError, InvalidCredentialsError, EmailUnverifiedError } from '../src/errors.js';

describe('auth errors', () => {
  it('carry the expected code/status and are instanceof AuthError', () => {
    expect(new EmailTakenError()).toMatchObject({ code: 'email_taken', status: 409 });
    expect(new InvalidCredentialsError()).toMatchObject({ code: 'invalid_credentials', status: 401 });
    expect(new EmailUnverifiedError()).toMatchObject({ code: 'email_unverified', status: 403 });
    expect(new EmailTakenError()).toBeInstanceOf(AuthError);
    expect(new EmailTakenError()).toBeInstanceOf(Error);
  });
});
