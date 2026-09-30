export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export class EmailTakenError extends AuthError {
  constructor(message = 'Email is already registered') {
    super(message, 'email_taken', 409);
    this.name = 'EmailTakenError';
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor(message = 'Invalid email or password') {
    super(message, 'invalid_credentials', 401);
    this.name = 'InvalidCredentialsError';
  }
}

export class EmailUnverifiedError extends AuthError {
  constructor(message = 'Please verify your email before signing in') {
    super(message, 'email_unverified', 403);
    this.name = 'EmailUnverifiedError';
  }
}

export class VerificationTokenInvalidError extends AuthError {
  constructor(message = 'This verification link is invalid or has expired') {
    super(message, 'verify_invalid', 400);
    this.name = 'VerificationTokenInvalidError';
  }
}

export class PasswordResetTokenInvalidError extends AuthError {
  constructor(message = 'This reset link is invalid or has expired') {
    super(message, 'reset_invalid', 400);
    this.name = 'PasswordResetTokenInvalidError';
  }
}
