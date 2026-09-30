import { readSse } from "./sse";

export class ApiError extends Error {}

export interface ValidateResult {
  ok: boolean;
  tables?: { name: string; rows: number; columns: string[] }[];
  order?: string[][];
  deferred?: string[];
  llmColumns?: string[];
  errors?: { message: string; line?: number }[];
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

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function send(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body);
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return (await res.json()) as T;
}

export const getConfig = () => json<Config>("GET", "/api/config");
export const getFiles = async () => (await json<{ files: string[] }>("GET", "/api/files")).files;
export const getFile = async (path: string) => (await json<{ text: string }>("GET", `/api/file?path=${encodeURIComponent(path)}`)).text;
export const putFile = (path: string, text: string, create = false) => json<{ path: string }>("PUT", "/api/file", { path, text, create });
export const validate = (text: string) => json<ValidateResult>("POST", "/api/validate", { text });
export const generate = (body: GenerateBody) => json<Preview>("POST", "/api/generate", body);
export const infer = (body: InferBody) => json<InferResult>("POST", "/api/infer", body);
export const exportFiles = (body: ExportBody) => json<ExportResult>("POST", "/api/export", body);

export async function exportZip(body: ExportBody): Promise<Blob> {
  const res = await send("POST", "/api/export", { ...body, zip: true, outputDir: undefined });
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return res.blob();
}

/** Fill LLM columns on the server, reporting progress. Aborting `signal` closes the connection, which stops the run. */
export async function streamGenerate(body: GenerateBody, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<Preview> {
  const res = await send("POST", "/api/generate/stream", body, signal);
  if (!res.ok) throw new ApiError(await errorMessage(res));
  for await (const ev of readSse(res.body!)) {
    if (ev.event === "progress") onProgress(ev.data as Progress);
    else if (ev.event === "done") return ev.data as Preview;
    else if (ev.event === "error") throw new ApiError((ev.data as { message: string }).message);
  }
  throw new ApiError("The server closed the connection before the run finished");
}
