import { existsSync, lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { assertWithinDiskQuota } from "@mockdata/accounts";
import { assertNotEnv, assertNotSymlink, checkSchemaPath, isEnvFile, readFileConfined, readPrefixConfined, resolveInside, SCHEMA_EXT, UserError, writeFileConfined } from "@mockdata/cli";
import { HttpError, optBool, readJson, reqString, sendJson, type Ctx, type Handler } from "../http.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "out"]);
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const SNIFF_BYTES = 1024 * 1024;
/** Only the first bytes of a file are needed to tell whether it defines `tables:`; never read the whole file for the sniff. */
const SNIFF_PREFIX_BYTES = 16 * 1024;
/** Schema files define a top-level `tables:` map (YAML at line start, or JSON possibly on one line). */
const LOOKS_LIKE_SCHEMA = /(^|[{,])\s*["']?tables["']?\s*:/m;

function walk(root: string, dir: string, depth: number, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) walk(root, full, depth + 1, out);
    } else if (entry.isFile() && SCHEMA_EXT.has(path.extname(entry.name).toLowerCase()) && !isEnvFile(entry.name)) {
      if (statSync(full).size <= SNIFF_BYTES && LOOKS_LIKE_SCHEMA.test(readPrefixConfined(root, full, SNIFF_PREFIX_BYTES))) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
}

/**
 * Fingerprint of the listing's inputs: directory mtimes plus each candidate
 * file's size and mtime. Metadata only — no file contents are read — so a
 * cache hit skips the (up to 500-file) sniff reads entirely, while any
 * added, removed, renamed or edited file invalidates the entry. A directory
 * mtime alone would miss edits inside an existing subdirectory, so the file
 * entries are part of the key.
 */
function fingerprintTree(root: string): string {
  const parts: string[] = [];
  const scan = (dir: string, depth: number): void => {
    let mtime = 0;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      return;
    }
    parts.push(`d:${path.relative(root, dir)}:${mtime}`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) scan(full, depth + 1);
      } else if (entry.isFile() && SCHEMA_EXT.has(path.extname(entry.name).toLowerCase()) && !isEnvFile(entry.name)) {
        try {
          const st = statSync(full);
          parts.push(`f:${path.relative(root, full)}:${st.size}:${st.mtimeMs}`);
        } catch {
          /* vanished mid-scan: the next walk re-reads it */
        }
      }
    }
  };
  scan(root, 0);
  return parts.join("|");
}

/** In-memory listing cache, per root, bounded (oldest entry evicted first). */
const MAX_LIST_CACHE_ENTRIES = 32;
const listCache = new Map<string, { fingerprint: string; files: string[] }>();

export const listFiles: Handler = async (ctx, _req, res) => {
  const fingerprint = fingerprintTree(ctx.root);
  const hit = listCache.get(ctx.root);
  if (hit && hit.fingerprint === fingerprint) {
    sendJson(res, 200, { files: [...hit.files] });
    return;
  }
  const files: string[] = [];
  walk(ctx.root, ctx.root, 0, files);
  files.sort();
  listCache.set(ctx.root, { fingerprint, files: [...files] });
  if (listCache.size > MAX_LIST_CACHE_ENTRIES) listCache.delete(listCache.keys().next().value!);
  sendJson(res, 200, { files });
};

export const readFile: Handler = async (ctx, _req, res, url) => {
  const rel = url.searchParams.get("path");
  if (!rel) throw new UserError('Query parameter "path" is required');
  checkSchemaPath(rel, "path");
  const file = resolveInside(ctx.root, rel);
  if (!existsSync(file)) throw new UserError(`No such file: ${rel}`);
  assertNotEnv(file);
  sendJson(res, 200, { path: rel, text: readFileConfined(ctx.root, file) });
};

/** Largest schema file a signed-in user may save. */
const MAX_ACCOUNT_FILE_BYTES = 1024 * 1024;

/** Accounts mode: refuse a write that would pass the file size, disk quota or file count limits. */
function checkAccountQuota(ctx: Ctx, file: string, text: string, freedBytes = 0): void {
  if (!ctx.accounts) return;
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_ACCOUNT_FILE_BYTES) throw new HttpError(413, "Schema files are limited to 1 MB");
  const exists = existsSync(file);
  assertWithinDiskQuota(ctx.root, Math.max(0, bytes - (exists ? lstatSync(file).size : freedBytes)), ctx.accounts.limits.userQuotaBytes, {
    newFiles: exists || freedBytes > 0 ? 0 : 1,
    maxFiles: ctx.accounts.limits.maxFiles,
  });
}

export const writeFile: Handler = async (ctx, req, res) => {
  const body = await readJson(req);
  const rel = reqString(body, "path");
  const text = reqString(body, "text");
  checkSchemaPath(rel, "path");
  const file = resolveInside(ctx.root, rel);
  assertNotSymlink(file);
  const create = optBool(body, "create") ?? false;
  if (create && existsSync(file)) throw new UserError(`${rel} already exists`);
  checkAccountQuota(ctx, file, text);
  writeFileConfined(ctx.root, file, text, { overwrite: !create });
  sendJson(res, 200, { path: rel });
};

/**
 * Save `text` under a new name and remove the old file. The new file is created
 * with the same confined, create-only write as PUT (never overwrites, never
 * follows a link), and the old one is only removed once that succeeded, so a
 * failure leaves the original in place.
 */
export const renameFile: Handler = async (ctx, req, res) => {
  const body = await readJson(req);
  const from = reqString(body, "from");
  const to = reqString(body, "to");
  const text = reqString(body, "text");
  checkSchemaPath(from, "from");
  checkSchemaPath(to, "to");
  const source = resolveInside(ctx.root, from);
  const target = resolveInside(ctx.root, to);
  if (source === target) throw new UserError("The new name is the same as the old one");
  let stat;
  try {
    stat = lstatSync(source);
  } catch {
    throw new UserError(`No such file: ${from}`);
  }
  if (stat.isSymbolicLink()) throw new UserError(`${path.basename(source)} is a symbolic link; refusing to rename it`);
  if (!stat.isFile()) throw new UserError(`No such file: ${from}`);
  assertNotEnv(source);
  assertNotSymlink(target);
  if (existsSync(target)) throw new UserError(`${to} already exists`);
  checkAccountQuota(ctx, target, text, stat.size);
  writeFileConfined(ctx.root, target, text);
  unlinkSync(source);
  sendJson(res, 200, { path: to });
};
