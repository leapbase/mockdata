import type { IncomingMessage, ServerResponse } from "node:http";
import { SESSION_COOKIE, clearCookie, sendPasswordResetEmail, sendVerificationEmail, type AccountUser } from "@mockdata/accounts";
import { EmailTakenError } from "@mockdata/auth-kit";
import type { AccountsRuntime } from "../accounts/runtime.js";
import { googleCallback, googleStart } from "../accounts/google.js";
import { startSession } from "../accounts/session.js";
import { HttpError, readJson, reqString, sendJson } from "../http.js";

/** Who is calling an /api/auth/ route: nobody, or the user behind the session cookie. */
export interface AuthCaller {
  user: AccountUser | null;
  /** The raw session token from the cookie, if it named a live session. */
  sessionId?: string;
}

export type AuthHandler = (acc: AccountsRuntime, caller: AuthCaller, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** Sign-in and sign-up bodies are tiny; refuse anything bigger long before the general 10 MB limit. */
const AUTH_BODY_MAX = 16 * 1024;

const publicUser = (u: AccountUser) => ({ id: u.id, email: u.email, displayName: u.displayName, avatarUrl: u.avatarUrl });

function tooMany(res: ServerResponse, seconds: number): HttpError {
  res.setHeader("retry-after", String(Math.max(1, seconds)));
  return new HttpError(429, "Too many attempts. Try again later.");
}

function field(result: string | { error: string }): string {
  if (typeof result !== "string") throw new HttpError(400, result.error);
  return result;
}

/** Validation messages describe the rule, never the input, so they can be shown as they are. */
function emailOf(acc: AccountsRuntime, body: Record<string, unknown>): string {
  return field(acc.auth.validateEmail(reqString(body, "email")));
}

/** Send a message without letting a mail failure change the response (that would reveal whether an address exists). */
async function sendQuietly(acc: AccountsRuntime, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (e) {
    process.stderr.write(`mail: could not send (${acc.mailer.formatError(e)})\n`);
  }
}

function requireEmail(acc: AccountsRuntime): void {
  if (!acc.emailEnabled) throw new HttpError(503, "Email sign-up is not available on this server");
}

const register: AuthHandler = async (acc, _caller, req, res) => {
  const body = await readJson(req, AUTH_BODY_MAX);
  const ip = acc.clientIp(req);
  if (!acc.limiters.signupIp.hit(ip)) throw tooMany(res, acc.limiters.signupIp.retryAfterSeconds(ip));
  requireEmail(acc);
  const email = emailOf(acc, body);
  const password = field(acc.auth.validateRegistrationPassword(body.password));
  const started = Date.now();
  try {
    const user = await acc.auth.register({ email, password });
    const token = await acc.auth.createEmailVerificationToken(user.id);
    await sendQuietly(acc, () => sendVerificationEmail(acc.mailer, user.email!, `${acc.config.publicUrl.origin}/api/auth/verify-email?token=${token}`));
  } catch (e) {
    if (!(e instanceof EmailTakenError)) throw e; // an existing address gets the same answer as a new one
  }
  await acc.auth.padToTimingFloor(started);
  sendJson(res, 202, { pending: true });
};

const login: AuthHandler = async (acc, _caller, req, res) => {
  const body = await readJson(req, AUTH_BODY_MAX);
  const ip = acc.clientIp(req);
  if (acc.limiters.ipFail.isLimited(ip)) throw tooMany(res, acc.limiters.ipFail.retryAfterSeconds(ip));
  const email = emailOf(acc, body);
  const normalized = acc.auth.normalizeEmail(email);
  if (acc.limiters.emailFail.isLimited(normalized)) throw tooMany(res, acc.limiters.emailFail.retryAfterSeconds(normalized));
  const password = field(acc.auth.validateLoginPasswordShape(body.password));
  const result = await acc.auth.login(email, password);
  if (!result) {
    acc.limiters.ipFail.record(ip);
    acc.limiters.emailFail.record(normalized);
    throw new HttpError(401, "Invalid email or password");
  }
  // Only someone who knows the password learns the address is unverified.
  if (!result.emailVerified) throw new HttpError(403, "Verify your email before signing in", "email_unverified");
  acc.limiters.emailFail.reset(normalized);
  await startSession(acc, res, result.user.id);
  sendJson(res, 200, { user: publicUser(result.user) });
};

const logout: AuthHandler = async (acc, caller, _req, res) => {
  await acc.sessions.destroy(caller.sessionId);
  res.setHeader("set-cookie", clearCookie(SESSION_COOKIE, acc.config.publicUrl.secure));
  sendJson(res, 200, { ok: true });
};

const me: AuthHandler = async (acc, caller, _req, res) => {
  sendJson(res, 200, {
    user: caller.user ? publicUser(caller.user) : null,
    auth: { accountsEnabled: true, googleConfigured: !!acc.google, emailEnabled: acc.emailEnabled },
  });
};

const verifyEmail: AuthHandler = async (acc, _caller, _req, res, url) => {
  const userId = await acc.auth.consumeEmailVerificationToken(url.searchParams.get("token") ?? "");
  if (userId !== null) {
    await acc.auth.markEmailVerified(userId);
    await acc.auth.clearEmailVerificationTokens(userId);
  }
  // Verifying never signs anyone in: a link alone must not create a session.
  res.writeHead(302, { location: userId !== null ? "/?verified=1" : "/?error=verify_failed", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end();
};

/** Mail-sending routes answer `{ok:true}` whether or not the address exists, and take the same time. */
function mailRoute(act: (acc: AccountsRuntime, email: string, normalized: string) => Promise<void>): AuthHandler {
  return async (acc, _caller, req, res) => {
    const body = await readJson(req, AUTH_BODY_MAX);
    const ip = acc.clientIp(req);
    if (!acc.limiters.mailIp.hit(ip)) throw tooMany(res, acc.limiters.mailIp.retryAfterSeconds(ip));
    requireEmail(acc);
    const email = emailOf(acc, body);
    const normalized = acc.auth.normalizeEmail(email);
    const started = Date.now();
    if (acc.limiters.mailEmail.hit(normalized)) await act(acc, email, normalized);
    await acc.auth.padToTimingFloor(started);
    sendJson(res, 200, { ok: true });
  };
}

const forgotPassword = mailRoute(async (acc, email) => {
  const identity = await acc.auth.findEmailIdentity(email);
  if (!identity) return;
  const token = await acc.auth.createPasswordResetToken(identity.userId);
  await sendQuietly(acc, () => sendPasswordResetEmail(acc.mailer, email, `${acc.config.publicUrl.origin}/?reset_token=${token}`));
});

const resendVerification = mailRoute(async (acc, email) => {
  const identity = await acc.auth.findEmailIdentity(email);
  if (!identity || identity.verified) return;
  await acc.auth.clearEmailVerificationTokens(identity.userId);
  const token = await acc.auth.createEmailVerificationToken(identity.userId);
  await sendQuietly(acc, () => sendVerificationEmail(acc.mailer, email, `${acc.config.publicUrl.origin}/api/auth/verify-email?token=${token}`));
});

const resetPassword: AuthHandler = async (acc, _caller, req, res) => {
  const body = await readJson(req, AUTH_BODY_MAX);
  const ip = acc.clientIp(req);
  if (acc.limiters.ipFail.isLimited(ip)) throw tooMany(res, acc.limiters.ipFail.retryAfterSeconds(ip));
  const token = reqString(body, "token");
  const password = field(acc.auth.validateRegistrationPassword(body.password)); // before consuming: a weak password must not burn the link
  const userId = await acc.auth.consumePasswordResetToken(token);
  if (userId === null) {
    acc.limiters.ipFail.record(ip);
    throw new HttpError(400, "This reset link is invalid or has expired", "reset_invalid");
  }
  await acc.auth.setPassword(userId, password);
  await acc.auth.markEmailVerified(userId); // reading the emailed link proves the address
  await acc.auth.clearEmailVerificationTokens(userId);
  await acc.auth.clearPasswordResetTokens(userId);
  await acc.auth.revokeSessions(userId); // whoever had the old password is signed out everywhere
  const user = await acc.auth.findUserById(userId);
  if (!user) throw new HttpError(400, "This reset link is invalid or has expired", "reset_invalid");
  await startSession(acc, res, userId);
  sendJson(res, 200, { user: publicUser(user) });
};

const changePassword: AuthHandler = async (acc, caller, req, res) => {
  if (!caller.user) throw new HttpError(401, "Sign in required");
  const user = caller.user;
  const body = await readJson(req, AUTH_BODY_MAX);
  const newPassword = field(acc.auth.validateRegistrationPassword(body.newPassword));
  const current = field(acc.auth.validateLoginPasswordShape(body.currentPassword));
  if (!user.email || !(await acc.auth.hasPasswordIdentity(user.id))) throw new HttpError(400, "This account has no password to change");
  if (acc.limiters.emailFail.isLimited(user.email)) throw tooMany(res, acc.limiters.emailFail.retryAfterSeconds(user.email));
  if (!(await acc.auth.login(user.email, current))) {
    acc.limiters.emailFail.record(user.email);
    throw new HttpError(400, "Current password is incorrect");
  }
  await acc.auth.setPassword(user.id, newPassword);
  await acc.auth.revokeSessions(user.id, caller.sessionId); // other devices are signed out, this one stays
  sendJson(res, 200, { ok: true });
};

export const AUTH_ROUTES: Record<string, AuthHandler> = {
  "GET /api/auth/me": me,
  "POST /api/auth/register": register,
  "POST /api/auth/login": login,
  "POST /api/auth/logout": logout,
  "GET /api/auth/verify-email": verifyEmail,
  "POST /api/auth/resend-verification": resendVerification,
  "POST /api/auth/forgot-password": forgotPassword,
  "POST /api/auth/reset-password": resetPassword,
  "POST /api/auth/change-password": changePassword,
  "GET /api/auth/google": googleStart,
  "GET /api/auth/google/callback": googleCallback,
};

/** `/api/auth/me` when accounts are off, so the page knows to skip the login screen. */
export function meWithoutAccounts(res: ServerResponse): void {
  sendJson(res, 200, { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } });
}
