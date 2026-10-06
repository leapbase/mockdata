import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { HttpError } from "./http.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Scripts and connections only from this origin: text from an LLM or a schema can never run code in the page. */
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

export function serveStatic(dir: string, pathname: string, res: ServerResponse): void {
  if (!existsSync(dir)) throw new HttpError(404, "The web UI has not been built yet (run npm run build)");
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Bad path");
  }
  if (rel.includes("\0")) throw new HttpError(400, "Bad path");
  // The workspace lives at /app; the page decides between it and the landing page, so serve the same index.html.
  if (rel === "/app" || rel === "/app/") rel = "/";
  if (rel.endsWith("/")) rel += "index.html";
  const base = path.resolve(dir);
  const file = path.join(base, rel);
  if (!file.startsWith(base + path.sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found");
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": CSP,
    "x-frame-options": "DENY",
  });
  createReadStream(file).pipe(res);
}
