import type { IncomingMessage, ServerResponse } from "node:http";
import { BusyError } from "@mockdata/core";
import { ApiKeyLimitError, clearCookie, sendPasswordResetEmail, sendVerificationEmail, sessionCookieName, type AccountUser } from "@mockdata/accounts";
import { EmailTakenError } from "@mockdata/auth-kit";
import type { AccountsRuntime } from "../accounts/runtime.js";
import { googleCallback, googleStart } from "../accounts/google.js";
import { startSession } from "../accounts/session.js";
import { HttpError, optInt, optString, readJson, reqString, sendJson } from "../http.js";

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
  const email = field(acc.auth.validateEmail(reqString(body, "email")));
  if (!PLAIN_EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address");
  return email;
}

/** The emailed link opens the confirm screen. The token sits in the fragment, so no server, proxy log or mail scanner ever sees it. */
function verificationLink(acc: AccountsRuntime, token: string): string {
  return `${acc.config.publicUrl.origin}/app#verify_token=${token}`;
}

/** Never put an email address in a log line (SMTP errors usually repeat the recipient). */
const redactEmails = (text: string): string => text.replace(/[^\s<>"',;]+@[^\s<>"',;]+/g, "<address>");

/**
 * Send a message after the response, never awaited by it: a slow mail server must not make "new address" and
 * "existing address" look different in response times, and a mail failure must not change the answer.
 */
function queueMail(acc: AccountsRuntime, send: () => Promise<void>): void {
  acc.queueMail(async () => {
    try {
      await send();
    } catch (e) {
      process.stderr.write(`mail: could not send (${redactEmails(acc.mailer.formatError(e))})\n`);
    }
  });
}

/** Password hashing is the expensive part of an unauthenticated request: bound how much can run, refuse the rest. */
async function hashing<T>(acc: AccountsRuntime, res: ServerResponse, job: () => Promise<T>): Promise<T> {
  try {
    return await acc.hashing.run(job);
  } catch (e) {
    if (e instanceof BusyError) {
      res.setHeader("retry-after", "5");
      throw new HttpError(503, "The server is busy: try again in a moment");
    }
    throw e;
  }
}

/** The coarse per-address ceiling on unauthenticated auth requests. */
async function throttle(acc: AccountsRuntime, req: IncomingMessage, res: ServerResponse): Promise<string> {
  const ip = acc.clientIp(req);
  if (!(await acc.limiters.authIp.hit(ip))) throw tooMany(res, (await acc.limiters.authIp.retryAfterSeconds(ip)));
  return ip;
}

/**
 * The library's check only needs one "@", but a mail library reads "a,b@x.com", "Name <b@x.com>" and quoted or
 * commented forms as other recipients, which would let sign-up mail anyone. Accept plain ASCII addresses only.
 */
const PLAIN_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function requireEmail(acc: AccountsRuntime): void {
  if (!acc.emailEnabled) throw new HttpError(503, "Email sign-up is not available on this server");
}

const register: AuthHandler = async (acc, _caller, req, res) => {
  const body = await readJson(req, AUTH_BODY_MAX);
  const ip = await throttle(acc, req, res);
  requireEmail(acc);
  // Cheap checks first: only an attempt that would hash a password and send mail counts against the sign-up limit.
  const email = emailOf(acc, body);
  const password = field(acc.auth.validateRegistrationPassword(body.password));
  if (!(await acc.limiters.signupIp.hit(ip))) throw tooMany(res, (await acc.limiters.signupIp.retryAfterSeconds(ip)));
  const started = Date.now();
  const verifyLink = (token: string) => verificationLink(acc, token);
  try {
    const user = await hashing(acc, res, () => acc.auth.register({ email, password }));
    const token = await acc.auth.createEmailVerificationToken(user.id);
    await acc.limiters.mailEmail.record(acc.auth.normalizeEmail(email)); // the first mail counts towards this mailbox's hourly allowance too
    queueMail(acc, () => sendVerificationEmail(acc.mailer, user.email!, verifyLink(token)));
  } catch (e) {
    if (!(e instanceof EmailTakenError)) throw e;
    // Nothing changes for an address that is already registered: not its password, not its sessions, not its earlier
    // link. An unverified one is mailed one more link (limited per mailbox, so this cannot be used to mail-bomb), and
    // confirming any link needs the password that was stored at sign-up, so whoever signed up first cannot be handed
    // the account by a link: the real owner recovers with Forgot password, which proves the mailbox.
    const identity = await acc.auth.findEmailIdentity(email);
    if (identity && !identity.verified && (await acc.limiters.mailEmail.hit(acc.auth.normalizeEmail(email)))) {
      const token = await acc.auth.createEmailVerificationToken(identity.userId);
      queueMail(acc, () => sendVerificationEmail(acc.mailer, email, verifyLink(token)));
    }
  }
  await acc.auth.padToTimingFloor(started);
  sendJson(res, 202, { pending: true });
};

const login: AuthHandler = async (acc, _caller, req, res) => {
  const body = await readJson(req, AUTH_BODY_MAX);
  const ip = await throttle(acc, req, res);
  // Every attempt is counted before any hashing, or a burst sent in parallel would all pass the check first.
  if (!(await acc.limiters.loginIp.hit(ip))) throw tooMany(res, (await acc.limiters.loginIp.retryAfterSeconds(ip)));
  if ((await acc.limiters.ipFail.isLimited(ip))) throw tooMany(res, (await acc.limiters.ipFail.retryAfterSeconds(ip)));
  const email = emailOf(acc, body);
  const normalized = acc.auth.normalizeEmail(email);
  const mailbox = `${normalized}|${ip}`;
  if ((await acc.limiters.emailIpFail.isLimited(mailbox))) throw tooMany(res, (await acc.limiters.emailIpFail.retryAfterSeconds(mailbox)));
  if ((await acc.limiters.emailFail.isLimited(normalized))) throw tooMany(res, (await acc.limiters.emailFail.retryAfterSeconds(normalized)));
  const password = field(acc.auth.validateLoginPasswordShape(body.password));
  const result = await hashing(acc, res, () => acc.auth.login(email, password));
  if (!result) {
    await acc.limiters.ipFail.record(ip);
    await acc.limiters.emailIpFail.record(mailbox);
    await acc.limiters.emailFail.record(normalized);
    throw new HttpError(401, "Invalid email or password");
  }
  // Only someone who knows the password learns the address is unverified.
  if (!result.emailVerified) throw new HttpError(403, "Verify your email before signing in", "email_unverified");
  await acc.limiters.emailIpFail.reset(mailbox);
  await startSession(acc, res, result.user.id);
  sendJson(res, 200, { user: publicUser(result.user) });
};

const logout: AuthHandler = async (acc, caller, _req, res) => {
  await acc.sessions.destroy(caller.sessionId);
  res.setHeader("set-cookie", clearCookie(sessionCookieName(acc.config.publicUrl.secure), acc.config.publicUrl.secure));
  sendJson(res, 200, { ok: true });
};

/** Sign the user out of every device, this one included. */
const logoutAll: AuthHandler = async (acc, caller, _req, res) => {
  if (!caller.user) throw new HttpError(401, "Sign in required");
  await acc.auth.revokeSessions(caller.user.id);
  res.setHeader("set-cookie", clearCookie(sessionCookieName(acc.config.publicUrl.secure), acc.config.publicUrl.secure));
  sendJson(res, 200, { ok: true });
};

const me: AuthHandler = async (acc, caller, _req, res) => {
  sendJson(res, 200, {
    user: caller.user ? publicUser(caller.user) : null,
    auth: { accountsEnabled: true, googleConfigured: !!acc.google, emailEnabled: acc.emailEnabled },
  });
};

/**
 * Confirm an address. The link proves the mailbox; the password proves this is the sign-up that was meant, so a
 * stranger who signed up first with someone else's address cannot be handed that account when the owner clicks. A wrong
 * password does not use the link up. Verifying signs the person in, since both proofs have just been given.
 */
const verifyEmail: AuthHandler = async (acc, _caller, req, res) => {
  const body = await readJson(req, AUTH_BODY_MAX);
  const ip = await throttle(acc, req, res);
  if (!(await acc.limiters.loginIp.hit(ip))) throw tooMany(res, (await acc.limiters.loginIp.retryAfterSeconds(ip)));
  if ((await acc.limiters.ipFail.isLimited(ip))) throw tooMany(res, (await acc.limiters.ipFail.retryAfterSeconds(ip)));
  const token = reqString(body, "token");
  const password = field(acc.auth.validateLoginPasswordShape(body.password));
  const invalid = () => new HttpError(400, "This verification link is invalid or has expired", "verify_invalid");
  const userId = await acc.auth.peekEmailVerificationToken(token);
  if (userId === null) {
    await acc.limiters.ipFail.record(ip);
    throw invalid();
  }
  const user = await acc.auth.findUserById(userId);
  if (!user?.email) throw invalid();
  const mailbox = `${user.email}|${ip}`;
  if ((await acc.limiters.emailIpFail.isLimited(mailbox))) throw tooMany(res, (await acc.limiters.emailIpFail.retryAfterSeconds(mailbox)));
  if ((await acc.limiters.emailFail.isLimited(user.email))) throw tooMany(res, (await acc.limiters.emailFail.retryAfterSeconds(user.email)));
  const checked = await hashing(acc, res, () => acc.auth.login(user.email!, password));
  if (!checked) {
    await acc.limiters.ipFail.record(ip);
    await acc.limiters.emailIpFail.record(mailbox);
    await acc.limiters.emailFail.record(user.email);
    throw new HttpError(400, "That is not the password used to sign up. If you signed up earlier with a different password, use Forgot password.", "verify_password");
  }
  if ((await acc.auth.consumeEmailVerificationToken(token)) !== userId) throw invalid();
  await acc.auth.markEmailVerified(userId);
  await acc.auth.clearEmailVerificationTokens(userId);
  await acc.limiters.emailIpFail.reset(mailbox);
  await startSession(acc, res, userId);
  sendJson(res, 200, { user: publicUser(user) });
};

/** Mail-sending routes answer `{ok:true}` whether or not the address exists, and take the same time. */
function mailRoute(act: (acc: AccountsRuntime, email: string, normalized: string) => Promise<void>): AuthHandler {
  return async (acc, _caller, req, res) => {
    const body = await readJson(req, AUTH_BODY_MAX);
    const ip = await throttle(acc, req, res);
    if (!(await acc.limiters.mailIp.hit(ip))) throw tooMany(res, (await acc.limiters.mailIp.retryAfterSeconds(ip)));
    requireEmail(acc);
    const email = emailOf(acc, body);
    const normalized = acc.auth.normalizeEmail(email);
    const started = Date.now();
    if ((await acc.limiters.mailEmail.hit(normalized))) await act(acc, email, normalized);
    await acc.auth.padToTimingFloor(started);
    sendJson(res, 200, { ok: true });
  };
}

const forgotPassword = mailRoute(async (acc, email) => {
  const identity = await acc.auth.findEmailIdentity(email);
  if (!identity) return;
  const token = await acc.auth.createPasswordResetToken(identity.userId);
  // A fragment is never sent to a server, so the token stays out of proxy logs and Referer headers.
  queueMail(acc, () => sendPasswordResetEmail(acc.mailer, email, `${acc.config.publicUrl.origin}/app#reset_token=${token}`));
});

const resendVerification = mailRoute(async (acc, email) => {
  const identity = await acc.auth.findEmailIdentity(email);
  if (!identity || identity.verified) return;
  await acc.auth.clearEmailVerificationTokens(identity.userId);
  const token = await acc.auth.createEmailVerificationToken(identity.userId);
  queueMail(acc, () => sendVerificationEmail(acc.mailer, email, verificationLink(acc, token)));
});

const resetPassword: AuthHandler = async (acc, _caller, req, res) => {
  const body = await readJson(req, AUTH_BODY_MAX);
  const ip = await throttle(acc, req, res);
  if ((await acc.limiters.ipFail.isLimited(ip))) throw tooMany(res, (await acc.limiters.ipFail.retryAfterSeconds(ip)));
  const token = reqString(body, "token");
  const password = field(acc.auth.validateRegistrationPassword(body.password)); // before consuming: a weak password must not burn the link
  // Take the hashing slot first and use the link up inside it: a "server busy" answer must not burn the link.
  const userId = await hashing(acc, res, async () => {
    const id = await acc.auth.consumePasswordResetToken(token);
    if (id === null) return null;
    await acc.auth.setPassword(id, password);
    return id;
  });
  if (userId === null) {
    await acc.limiters.ipFail.record(ip);
    throw new HttpError(400, "This reset link is invalid or has expired", "reset_invalid");
  }
  await acc.auth.markEmailVerified(userId); // reading the emailed link proves the address
  await acc.auth.clearEmailVerificationTokens(userId);
  await acc.auth.clearPasswordResetTokens(userId);
  await acc.auth.revokeSessions(userId); // whoever had the old password is signed out everywhere
  await acc.apiKeys.revokeAll(userId); // and loses any API key they made while they were in
  const user = await acc.auth.findUserById(userId);
  if (!user) throw new HttpError(400, "This reset link is invalid or has expired", "reset_invalid");
  await startSession(acc, res, userId);
  sendJson(res, 200, { user: publicUser(user) });
};

const changePassword: AuthHandler = async (acc, caller, req, res) => {
  if (!caller.user) throw new HttpError(401, "Sign in required");
  const user = caller.user;
  const body = await readJson(req, AUTH_BODY_MAX);
  // Two password hashes per call, and a signed-in user's successes are not failures: bound them per user, before hashing.
  if (!(await acc.limiters.changePasswordUser.hit(String(user.id)))) throw tooMany(res, (await acc.limiters.changePasswordUser.retryAfterSeconds(String(user.id))));
  const newPassword = field(acc.auth.validateRegistrationPassword(body.newPassword));
  const current = field(acc.auth.validateLoginPasswordShape(body.currentPassword));
  if (!user.email || !(await acc.auth.hasPasswordIdentity(user.id))) throw new HttpError(400, "This account has no password to change");
  if ((await acc.limiters.emailIpFail.isLimited(user.email))) throw tooMany(res, (await acc.limiters.emailIpFail.retryAfterSeconds(user.email)));
  if (!(await hashing(acc, res, () => acc.auth.login(user.email!, current)))) {
    await acc.limiters.emailIpFail.record(user.email);
    throw new HttpError(400, "Current password is incorrect");
  }
  await hashing(acc, res, () => acc.auth.setPassword(user.id, newPassword));
  await acc.auth.revokeSessions(user.id, caller.sessionId); // other devices are signed out, this one stays
  sendJson(res, 200, { ok: true });
};

/** The signed-in user's API keys (for the hosted MCP endpoint). The secret is never listed, only shown once on creation. */
const listKeys: AuthHandler = async (acc, caller, _req, res) => {
  if (!caller.user) throw new HttpError(401, "Sign in required");
  sendJson(res, 200, { keys: await acc.apiKeys.list(caller.user.id) });
};

const createKey: AuthHandler = async (acc, caller, req, res) => {
  if (!caller.user) throw new HttpError(401, "Sign in required");
  const id = String(caller.user.id);
  if (!(await acc.limiters.apiKeyUser.hit(id))) throw tooMany(res, (await acc.limiters.apiKeyUser.retryAfterSeconds(id)));
  const body = await readJson(req, AUTH_BODY_MAX);
  try {
    const { key, info } = await acc.apiKeys.create(caller.user.id, optString(body, "name") ?? "");
    sendJson(res, 201, { key, info });
  } catch (e) {
    if (e instanceof ApiKeyLimitError) throw new HttpError(400, e.message, "too_many_keys");
    throw e;
  }
};

const revokeKey: AuthHandler = async (acc, caller, req, res) => {
  if (!caller.user) throw new HttpError(401, "Sign in required");
  const body = await readJson(req, AUTH_BODY_MAX);
  const id = optInt(body, "id", 1, Number.MAX_SAFE_INTEGER);
  if (id === undefined) throw new HttpError(400, '"id" must be a key id');
  if (!(await acc.apiKeys.revoke(caller.user.id, id))) throw new HttpError(404, "No such API key");
  sendJson(res, 200, { ok: true });
};

export const AUTH_ROUTES: Record<string, AuthHandler> = {
  "GET /api/auth/keys": listKeys,
  "POST /api/auth/keys": createKey,
  "POST /api/auth/keys/revoke": revokeKey,
  "GET /api/auth/me": me,
  "POST /api/auth/register": register,
  "POST /api/auth/login": login,
  "POST /api/auth/logout": logout,
  "POST /api/auth/verify-email": verifyEmail,
  "POST /api/auth/resend-verification": resendVerification,
  "POST /api/auth/forgot-password": forgotPassword,
  "POST /api/auth/reset-password": resetPassword,
  "POST /api/auth/change-password": changePassword,
  "POST /api/auth/logout-all": logoutAll,
  "GET /api/auth/google": googleStart,
  "GET /api/auth/google/callback": googleCallback,
};
