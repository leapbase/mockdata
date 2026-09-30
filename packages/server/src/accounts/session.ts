import type { ServerResponse } from "node:http";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, serializeCookie } from "@mockdata/accounts";
import type { AccountsRuntime } from "./runtime.js";

/** Add a Set-Cookie header without dropping ones already queued on this response. */
export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("set-cookie");
  res.setHeader("set-cookie", [...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []), cookie]);
}

/** Create a session for the user and set its cookie (HttpOnly, SameSite=Lax, Secure when the public address is https). */
export async function startSession(acc: AccountsRuntime, res: ServerResponse, userId: number): Promise<void> {
  const session = await acc.sessions.create(userId);
  appendSetCookie(res, serializeCookie(SESSION_COOKIE, session.id, { maxAgeSeconds: SESSION_TTL_SECONDS, secure: acc.config.publicUrl.secure }));
}
