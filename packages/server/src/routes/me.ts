import type { ServerResponse } from "node:http";
import { sendJson } from "../http.js";

/** `/api/auth/me` when no hosted layer is present, so the page knows to skip the login screen. */
export function meWithoutAccounts(res: ServerResponse): void {
  sendJson(res, 200, { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } });
}
