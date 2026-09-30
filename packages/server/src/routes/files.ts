import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkSchemaPath, isEnvFile, resolveInside, SCHEMA_EXT, UserError } from "@mockdata/cli";
import { optBool, readJson, reqString, sendJson, type Handler } from "../http.js";

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
  sendJson(res, 200, { path: rel, text: readFileSync(file, "utf8") });
};

export const writeFile: Handler = async (ctx, req, res) => {
  const body = await readJson(req);
  const rel = reqString(body, "path");
  const text = reqString(body, "text");
  checkSchemaPath(rel, "path");
  const file = resolveInside(ctx.root, rel);
  if (optBool(body, "create") && existsSync(file)) throw new UserError(`${rel} already exists`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  sendJson(res, 200, { path: rel });
};
