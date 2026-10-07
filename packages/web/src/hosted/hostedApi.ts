import { json } from "@mockdata/web";

export interface AuthUser {
  id: number;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}
export interface Me {
  user: AuthUser | null;
  auth: { accountsEnabled: boolean; googleConfigured: boolean; emailEnabled: boolean };
}

export const getMe = () => json<Me>("GET", "/api/auth/me");
export const login = async (email: string, password: string) => (await json<{ user: AuthUser }>("POST", "/api/auth/login", { email, password })).user;
export const verifyEmail = async (token: string, password: string) => (await json<{ user: AuthUser }>("POST", "/api/auth/verify-email", { token, password })).user;
export const register = (email: string, password: string) => json<{ pending: true }>("POST", "/api/auth/register", { email, password });
export const logoutAll = () => json<{ ok: true }>("POST", "/api/auth/logout-all", {});
export const logout = () => json<{ ok: true }>("POST", "/api/auth/logout", {});
export const forgotPassword = (email: string) => json<{ ok: true }>("POST", "/api/auth/forgot-password", { email });
export const resetPassword = async (token: string, password: string) => (await json<{ user: AuthUser }>("POST", "/api/auth/reset-password", { token, password })).user;
export const resendVerification = (email: string) => json<{ ok: true }>("POST", "/api/auth/resend-verification", { email });
export const changePassword = (currentPassword: string, newPassword: string) => json<{ ok: true }>("POST", "/api/auth/change-password", { currentPassword, newPassword });

/** An API key as listed: never the secret, which is only returned once by createApiKey. */
export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export const listApiKeys = async () => (await json<{ keys: ApiKeyInfo[] }>("GET", "/api/auth/keys")).keys;
export const createApiKey = (name: string) => json<{ key: string; info: ApiKeyInfo }>("POST", "/api/auth/keys", { name });
export const revokeApiKey = (id: number) => json<{ ok: true }>("POST", "/api/auth/keys/revoke", { id });
