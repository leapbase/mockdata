import { existsSync, lstatSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { assertNotEnv, assertNotSymlink, checkSchemaPath, isEnvFile, resolveInside, SCHEMA_EXT, UserError, writeFileConfined } from "@mockdata/cli";
import { HttpError, optBool, readJson, reqString, sendJson, type Ctx, type Handler } from "../http.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "out"]);
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const SNIFF_BYTES = 1024 * 1024;
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
      if (statSync(full).size <= SNIFF_BYTES && LOOKS_LIKE_SCHEMA.test(readFileSync(full, "utf8"))) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
}

export const listFiles: Handler = async (ctx, _req, res) => {
  const files: string[] = [];
  walk(ctx.root, ctx.root, 0, files);
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
function checkWriteAllowed(ctx: Ctx, file: string, text: string, freedBytes = 0): void {
  if (!ctx.policy) return;
  const bytes = Buffer.byteLength(text);
  const exists = existsSync(file);
  ctx.policy.checkWrite(ctx.root, {
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
  checkWriteAllowed(ctx, file, text);
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
  checkWriteAllowed(ctx, target, text, stat.size);
  writeFileConfined(ctx.root, target, text);
  unlinkSync(source);
  sendJson(res, 200, { path: to });
};
