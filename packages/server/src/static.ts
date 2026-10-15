import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
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
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Scripts and connections only from this origin: text from an LLM or a schema can never run code in the page. */
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

/** Documentation pages; a bare slug only, so this never becomes a catch-all for files under /docs. */
export const isDocsPath = (pathname: string) => /^\/docs(\/[a-z0-9-]+)?\/?$/.test(pathname);

/** Text worth compressing; fonts and images are compressed already. */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".map", ".txt"]);
/** Below this, compression saves less than its headers cost. */
const MIN_COMPRESS = 1024;
type Encoding = "br" | "gzip";
const compress: Record<Encoding, (b: Buffer) => Promise<Buffer>> = {
  // Quality 9, not 11: each file is compressed once per process, but the first visitor after a deploy waits for it.
  br: (b) => promisify(brotliCompress)(b, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: b.length } }),
  gzip: (b) => promisify(gzip)(b, { level: 9 }),
};
/** Compressed bodies by file and encoding, kept while the file's size and mtime match (the build is a fixed set of files). */
const compressed = new Map<string, { tag: string; body: Promise<Buffer> }>();

/** The best encoding the browser accepts: br, then gzip; `q=0` refuses one. */
export function pickEncoding(header: string | string[] | undefined): Encoding | undefined {
  const accepted = new Set<string>();
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  return accepted.has("br") ? "br" : accepted.has("gzip") ? "gzip" : undefined;
}

function compressedBody(file: string, tag: string, encoding: Encoding): Promise<Buffer> {
  const key = `${encoding}:${file}`;
  const hit = compressed.get(key);
  if (hit?.tag === tag) return hit.body;
  const body = readFile(file).then((raw) => compress[encoding](raw));
  body.catch(() => compressed.delete(key));
  compressed.set(key, { tag, body });
  return body;
}

export async function serveStatic(dir: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!existsSync(dir)) throw new HttpError(404, "The web UI has not been built yet (run npm run build)");
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Bad path");
  }
  if (rel.includes("\0")) throw new HttpError(400, "Bad path");
  // The workspace (/app) and the documentation (/docs, /docs/<page>) are routes of the same page, so serve index.html.
  if (rel === "/app" || rel === "/app/" || isDocsPath(rel)) rel = "/";
  if (rel.endsWith("/")) rel += "index.html";
  const base = path.resolve(dir);
  const file = path.join(base, rel);
  if (!file.startsWith(base + path.sep)) throw new HttpError(404, "Not found");
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, "Not found");
  const ext = path.extname(file).toLowerCase();
  const tag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    // Vite names everything under assets/ by content hash, so a new build is a new URL; the page itself must revalidate.
    "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    etag: tag,
    "last-modified": info.mtime.toUTCString(),
    "x-content-type-options": "nosniff",
    "content-security-policy": CSP,
    "x-frame-options": "DENY",
  };
  const canCompress = COMPRESSIBLE.has(ext) && info.size >= MIN_COMPRESS;
  if (canCompress) headers.vary = "Accept-Encoding";
  if (req.headers["if-none-match"]?.split(",").some((t) => t.trim() === tag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const encoding = canCompress ? pickEncoding(req.headers["accept-encoding"]) : undefined;
  if (encoding) {
    const body = await compressedBody(file, tag, encoding);
    res.writeHead(200, { ...headers, "content-encoding": encoding, "content-length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": String(info.size) });
  createReadStream(file).pipe(res);
}
