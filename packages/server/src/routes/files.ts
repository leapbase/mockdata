import { existsSync, lstatSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { readdir, readFile as readFileAsync, stat } from "node:fs/promises";
import path from "node:path";
import { assertNotEnv, assertNotSymlink, checkSchemaPath, isEnvFile, resolveInside, SCHEMA_EXT, UserError, writeFileConfined } from "@mockdata/cli";
import { HttpError, optBool, readJson, reqString, sendJson, type Ctx, type Handler } from "../http.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "out"]);
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const SNIFF_BYTES = 1024 * 1024;
/** Schema files define a top-level `tables:` map (YAML at line start, or JSON possibly on one line). */
const LOOKS_LIKE_SCHEMA = /(^|[{,])\s*["']?tables["']?\s*:/m;

/**
 * Whether each file looked like a schema, by path, size and mtime. Listing runs on every page load and used to read
 * every candidate in full; now an unchanged file costs one stat. Bounded, and dropped wholesale when full.
 */
const schemaLike = new Map<string, { size: number; mtimeMs: number; yes: boolean }>();
const SCHEMA_LIKE_MAX = 10_000;

async function looksLikeSchema(full: string): Promise<boolean> {
  const info = await stat(full);
  if (info.size > SNIFF_BYTES) return false;
  const known = schemaLike.get(full);
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.yes;
  const yes = LOOKS_LIKE_SCHEMA.test(await readFileAsync(full, "utf8"));
  if (schemaLike.size >= SCHEMA_LIKE_MAX) schemaLike.clear();
  schemaLike.set(full, { size: info.size, mtimeMs: info.mtimeMs, yes });
  return yes;
}

/** Off the event loop (other users wait on it), in the same order as before so the MAX_FILES cut is unchanged. */
async function walk(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) await walk(root, full, depth + 1, out);
    } else if (entry.isFile() && SCHEMA_EXT.has(path.extname(entry.name).toLowerCase()) && !isEnvFile(entry.name)) {
      if (await looksLikeSchema(full).catch(() => false)) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
}

export const listFiles: Handler = async (ctx, _req, res) => {
  const files: string[] = [];
  await walk(ctx.root, ctx.root, 0, files);
  sendJson(res, 200, { files: files.sort() });
};

export const readFile: Handler = async (ctx, _req, res, url) => {
  const rel = url.searchParams.get("path");
  if (!rel) throw new UserError('Query parameter "path" is required');
  checkSchemaPath(rel, "path");
  const file = resolveInside(ctx.root, rel);
  if (!existsSync(file)) throw new UserError(`No such file: ${rel}`);
  assertNotEnv(file);
  sendJson(res, 200, { path: rel, text: readFileSync(file, "utf8") });
};

/** Hosted: the policy refuses a write that would pass the file size, disk quota or file count limits. */
async function checkWriteAllowed(ctx: Ctx, file: string, text: string, freedBytes = 0): Promise<void> {
  if (!ctx.policy) return;
  const bytes = Buffer.byteLength(text);
  const exists = existsSync(file);
  await ctx.policy.checkWrite(ctx.root, {
    netBytes: Math.max(0, bytes - (exists ? lstatSync(file).size : freedBytes)),
    newFiles: exists || freedBytes > 0 ? 0 : 1,
    fileBytes: bytes,
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
  await checkWriteAllowed(ctx, file, text);
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
  await checkWriteAllowed(ctx, target, text, stat.size);
  writeFileConfined(ctx.root, target, text);
  unlinkSync(source);
  sendJson(res, 200, { path: to });
};
