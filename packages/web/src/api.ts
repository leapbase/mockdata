import { readSse } from "./sse";

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status (0 when the failure was not an HTTP response). */
    readonly status = 0,
    /** A stable reason from the server, such as "email_unverified". */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface DiagramColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  unique: boolean;
  nullable: boolean;
  ref?: string;
}
export interface SchemaDiagram {
  tables: { name: string; rows: number; columns: DiagramColumn[] }[];
}
export interface ValidateResult {
  ok: boolean;
  diagram?: SchemaDiagram;
  tables?: { name: string; rows: number; columns: string[] }[];
  order?: string[][];
  deferred?: string[];
  llmColumns?: string[];
  errors?: { message: string; line?: number }[];
  /** Whether LLM columns can run for this schema (its own llm block wins over the environment). */
  llm?: { ok: true; provider: string } | { ok: false; reason: string };
}
export interface PreviewTable {
  columns: string[];
  refs: Record<string, string>;
  rows: Record<string, unknown>[];
}
export interface LlmReport {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  columns: Record<string, number>;
}
export interface Preview {
  seed: number;
  counts: Record<string, number>;
  tables: Record<string, PreviewTable>;
  pending: string[];
  report?: LlmReport;
}
export interface Progress {
  column: string;
  done: number;
  total: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
export interface Config {
  llm: { ok: true; provider: string } | { ok: false; reason: string };
  dbEnv: string[];
}
export interface GenerateBody {
  text: string;
  seed?: number;
  rows?: number;
}
export interface InferBody {
  path?: string;
  content?: string;
  name?: string;
  connectionEnv?: string;
  kind?: "json-schema" | "sample" | "database";
}
export interface InferResult {
  schemaText: string;
  tables: string[];
  warnings: string[];
}
export interface ExportBody {
  text: string;
  seed?: number;
  format: "json" | "ndjson" | "csv";
  outputDir?: string;
  overwrite?: boolean;
  zip?: boolean;
}
export interface ExportResult {
  files: string[];
  rows: Record<string, number>;
}

async function failure(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    return new ApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code);
  } catch {
    return new ApiError(`HTTP ${res.status}`, res.status);
  }
}

let onUnauthorized: (() => void) | undefined;
/** Called when a call outside /api/auth/ is answered 401, meaning the session is gone. */
export function setOnUnauthorized(fn: (() => void) | undefined): void {
  onUnauthorized = fn;
}

async function send(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  // A wrong password is also a 401, but from /api/auth/: only other calls mean "your session ended".
  if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized?.();
  return res;
}

async function json<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await send(method, url, body, signal);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

export const getConfig = () => json<Config>("GET", "/api/config");
export const getFiles = async () => (await json<{ files: string[] }>("GET", "/api/files")).files;
export const getFile = async (path: string) => (await json<{ text: string }>("GET", `/api/file?path=${encodeURIComponent(path)}`)).text;
export const putFile = (path: string, text: string, create = false) => json<{ path: string }>("PUT", "/api/file", { path, text, create });
/** Save `text` as `to` and remove `from`; refused if `to` already exists. */
export const renameFile = (from: string, to: string, text: string) => json<{ path: string }>("POST", "/api/file/rename", { from, to, text });
export const validate = (text: string) => json<ValidateResult>("POST", "/api/validate", { text });
export const generate = (body: GenerateBody, signal?: AbortSignal) => json<Preview>("POST", "/api/generate", body, signal);
export const infer = (body: InferBody) => json<InferResult>("POST", "/api/infer", body);
export const exportFiles = (body: ExportBody) => json<ExportResult>("POST", "/api/export", body);

export async function exportZip(body: ExportBody): Promise<Blob> {
  const res = await send("POST", "/api/export", { ...body, zip: true, outputDir: undefined });
  if (!res.ok) throw await failure(res);
  return res.blob();
}

/** Fill LLM columns on the server, reporting progress. Aborting `signal` closes the connection, which stops the run. */
export async function streamGenerate(body: GenerateBody, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<Preview> {
  const res = await send("POST", "/api/generate/stream", body, signal);
  if (!res.ok) throw await failure(res);
  for await (const ev of readSse(res.body!)) {
    if (ev.event === "progress") onProgress(ev.data as Progress);
    else if (ev.event === "done") return ev.data as Preview;
    else if (ev.event === "error") throw new ApiError((ev.data as { message: string }).message);
  }
  throw new ApiError("The server closed the connection before the run finished");
}

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
