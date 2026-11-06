import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  detectDatabase,
  fromJsonSchema,
  InferError,
  inferFromDatabase,
  inferFromSampleFiles,
  looksLikeJsonSchema,
  MAX_SOURCE_BYTES,
  type InferResult,
} from "@mockdata/inputs";
import { loadEnv } from "./env.js";
import { hostnameAllowed, type NetworkAccess } from "./network.js";

/**
 * Helpers for servers (MCP, web UI) that act on input from an untrusted
 * caller: every path is confined to a root, and secrets are only ever named,
 * never accepted or echoed. Do not write to stdout here (MCP uses it as its protocol channel).
 */

/** Problems caused by the caller's input; servers report them as 4xx / tool errors, not crashes. */
export class UserError extends Error {}

/** Most rows one untrusted-caller run (web export, MCP generate_data) may build in memory. */
export const MAX_TOTAL_ROWS = 1_000_000;

/** Refuse a schema whose tables add up to more than `max` rows, before any generation work. */
export function assertRowBudget(schema: { tables: Record<string, { rows: number }> }, max = MAX_TOTAL_ROWS): void {
  const total = Object.values(schema.tables).reduce((n, t) => n + t.rows, 0);
  if (total > max) throw new UserError(`The schema would generate ${total} rows; the limit is ${max}. Lower the row counts in the schema.`);
}

export const SCHEMA_EXT = new Set([".yaml", ".yml", ".json"]);
export const isEnvFile = (p: string): boolean => path.basename(p).startsWith(".env");

/** Env var names a caller may use for a database URL: must look like database config, never e.g. an API key. */
const DB_ENV_NAME = /^(?=.*(DATABASE|DB|POSTGRES|MYSQL|MARIADB|SQLITE))[A-Z][A-Z0-9_]*$/;
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/**
 * Resolve a caller-supplied relative path inside `root`. Rejects absolute
 * paths, `..` escapes, and symlinks that lead outside the root.
 */
export function resolveInside(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new UserError(`Path "${rel}" must be relative to the server root`);
  const rootReal = realpathSync(root);
  const target = path.resolve(rootReal, rel);
  const within = (p: string) => {
    const r = path.relative(rootReal, p);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  let probe = target;
  while (!existsSync(probe)) probe = path.dirname(probe);
  if (!within(target) || !within(realpathSync(probe))) throw new UserError(`Path "${rel}" is outside the server root`);
  // existsSync is false for a dangling symlink, so the probe above would skip it: walk the path and inspect every link.
  let current = rootReal;
  for (const segment of path.relative(rootReal, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      break; // this part does not exist yet, so nothing below it can be a link
    }
    if (!stat.isSymbolicLink()) continue;
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      throw new UserError(`Path "${rel}" goes through a link that points nowhere`);
    }
    if (!within(real)) throw new UserError(`Path "${rel}" is outside the server root`);
  }
  return target;
}

/** Refuse a file that is, or links to, a .env file (the name check on the requested path alone is not enough). */
export function assertNotEnv(file: string): void {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {
    /* does not exist (yet): the requested name was already checked */
  }
  if (isEnvFile(real)) throw new UserError("Refusing to read .env files");
}

/** Refuse to write to a symlink, live or dangling: a write would land wherever it points. */
export function assertNotSymlink(file: string): void {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) throw new UserError(`${path.basename(file)} is a symbolic link; refusing to write through it`);
}

/**
 * Write `data` to `file` (a path from resolveInside) without trusting an earlier check:
 * a link may have been swapped in since, e.g. while LLM calls ran. The path is
 * re-resolved, the file is opened with O_NOFOLLOW (and O_EXCL unless `overwrite`),
 * and the opened file must really live inside the root before anything is
 * truncated or written.
 */
export function writeFileConfined(root: string, file: string, data: string | Buffer, opts: { overwrite?: boolean } = {}): void {
  const rootReal = realpathSync(root);
  const rel = path.relative(rootReal, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new UserError(`Path "${path.basename(file)}" is outside the server root`);
  const target = resolveInside(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  const target2 = resolveInside(root, rel); // folders now exist: check again through any link that appeared
  let fd: number;
  try {
    fd = openSync(target2, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (opts.overwrite ? 0 : constants.O_EXCL), 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new UserError(`${path.basename(file)} already exists`);
    if (code === "ELOOP" || code === "EMLINK") throw new UserError(`${path.basename(file)} is a symbolic link; refusing to write through it`);
    throw e;
  }
  try {
    const real = realpathSync(target2);
    const r = path.relative(rootReal, real);
    const opened = fstatSync(fd);
    const onDisk = lstatSync(real);
    if (r.startsWith("..") || path.isAbsolute(r) || opened.ino !== onDisk.ino || opened.dev !== onDisk.dev) {
      throw new UserError(`Path "${path.basename(file)}" changed while writing; refusing`);
    }
    if (opts.overwrite) ftruncateSync(fd, 0);
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off);
  } finally {
    closeSync(fd);
  }
}

/**
 * Open `file` (a path from resolveInside) for reading without trusting an
 * earlier check: the path is re-resolved, the file is opened with O_NOFOLLOW
 * (a link swapped in since the check is refused, not followed), and the
 * opened file must really live inside the root, not be a .env file, and be
 * the same inode the path now resolves to before anything is read. The
 * caller reads through the returned fd and must close it.
 */
export function openConfined(root: string, file: string): number {
  const rootReal = realpathSync(root);
  const rel = path.relative(rootReal, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new UserError(`Path "${path.basename(file)}" is outside the server root`);
  const target = resolveInside(root, rel);
  assertNotEnv(target);
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new UserError(`${path.basename(file)} is a symbolic link; refusing to read through it`);
    if (code === "ENOENT") throw new UserError(`No such file: ${path.basename(file)}`);
    throw e;
  }
  try {
    const real = realpathSync(target);
    if (isEnvFile(real)) throw new UserError("Refusing to read .env files");
    const r = path.relative(rootReal, real);
    const opened = fstatSync(fd);
    const onDisk = lstatSync(real);
    if (r.startsWith("..") || path.isAbsolute(r) || opened.ino !== onDisk.ino || opened.dev !== onDisk.dev) {
      throw new UserError(`Path "${path.basename(file)}" changed while reading; refusing`);
    }
    if (!opened.isFile()) throw new UserError(`${path.basename(file)} is not a regular file`);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/**
 * Read a confined file as UTF-8 text through its fd (see openConfined).
 * `maxBytes` refuses a file larger than the limit instead of reading it.
 */
export function readFileConfined(root: string, file: string, opts: { maxBytes?: number } = {}): string {
  const fd = openConfined(root, file);
  try {
    if (opts.maxBytes !== undefined) {
      const size = fstatSync(fd).size;
      if (size > opts.maxBytes) {
        throw new UserError(`${path.basename(file)} is ${Math.round(size / 1e6)} MB; the limit is ${opts.maxBytes / 1024 / 1024} MB (use a smaller file)`);
      }
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Read only the first `maxBytes` of a confined file (a sniff, never the whole file). */
export function readPrefixConfined(root: string, file: string, maxBytes: number): string {
  const fd = openConfined(root, file);
  try {
    const buf = Buffer.alloc(maxBytes);
    let n = 0;
    while (n < maxBytes) {
      const read = readSync(fd, buf, n, maxBytes - n, n);
      if (read === 0) break;
      n += read;
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Why a request must be refused, or undefined if it is fine: it has to be
 * addressed to localhost or, when `access` is given, to an IP address of this
 * machine or in the allow list (DNS rebinding), and, if a browser page sent it,
 * come from the same origin as the Host it addressed (CSRF). Shared by the web
 * UI and the MCP HTTP server.
 */
export function localRequestProblem(host: string | undefined, origin: string | undefined, access?: NetworkAccess): string | undefined {
  const m = host ? /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim()) : null;
  if (!m || !hostnameAllowed(m[1]!.replace(/^\[|\]$/g, ""), access)) {
    return access ? "Host not allowed: use localhost or an allowed IP address" : "Host not allowed: this server only answers on localhost";
  }
  if (origin !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      /* falls through to the rejection below */
    }
    // Same-origin only: a page on another port (another dev server, a local app) is as foreign as any website.
    if (!parsed || !hostnameAllowed(parsed.hostname.replace(/^\[|\]$/g, ""), access) || parsed.host !== host!.trim().toLowerCase()) return "Origin not allowed";
  }
  return undefined;
}

/** Throws unless `rel` names a schema file we may read or write; returns its lower-case extension. */
export function checkSchemaPath(rel: string, label = "schemaPath"): string {
  const ext = path.extname(rel).toLowerCase();
  if (!SCHEMA_EXT.has(ext) || isEnvFile(rel)) throw new UserError(`${label} must be a .yaml, .yml or .json file (got "${rel}")`);
  return ext;
}

/** Names (not values) of variables a caller may pass as `connectionEnv`: database-shaped name and a supported URL. */
export function dbEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => DB_ENV_NAME.test(name) && !!value && detectDatabase(value))
    .map(([name]) => name)
    .sort();
}

/** Parse JSON/YAML text, or undefined if it is neither (then it is treated as sample rows). */
function safeParse(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

export interface InferArgs {
  path?: string;
  content?: string;
  name?: string;
  connectionEnv?: string;
  kind?: "json-schema" | "sample" | "database";
  rows?: number;
  pgSchema?: string;
  enums?: boolean;
}

/** `infer` for an untrusted caller: exactly one of path / content / connectionEnv, all confined. */
export async function inferConfined(root: string, baseEnv: Record<string, string | undefined>, args: InferArgs): Promise<InferResult> {
  const given = [args.path, args.content, args.connectionEnv].filter((v) => v !== undefined).length;
  if (given !== 1) throw new UserError('Provide exactly one of "path", "content" or "connectionEnv"');
  const opts = { kind: args.kind, rows: args.rows, schema: args.pgSchema, enums: args.enums };

  if (args.connectionEnv !== undefined) {
    if (!DB_ENV_NAME.test(args.connectionEnv)) {
      throw new UserError(`connectionEnv must be an upper-case variable name that mentions DATABASE, DB, POSTGRES, MYSQL, MARIADB or SQLITE`);
    }
    const url = loadEnv(root, baseEnv)[args.connectionEnv];
    if (!url) throw new UserError(`Environment variable ${args.connectionEnv} is not set (checked the environment and .env in the server root)`);
    // Do not echo the value: it may be a credential of some other kind.
    if (!detectDatabase(url)) throw new UserError(`${args.connectionEnv} does not hold a supported database URL (postgres://, mysql://, mariadb:// or sqlite:)`);
    return inferFromDatabase(url, opts);
  }

  if (args.content !== undefined) {
    if (Buffer.byteLength(args.content) > MAX_INLINE_BYTES) throw new UserError("content is larger than 5 MB; write it to a file under the server root and use path");
    const doc = args.kind === "sample" ? undefined : safeParse(args.content);
    return args.kind === "json-schema" || (args.kind === undefined && looksLikeJsonSchema(doc))
      ? fromJsonSchema(doc as Record<string, unknown>, opts)
      : inferFromSampleFiles([{ name: args.name ?? "data.json", text: args.content }], opts);
  }

  if (isEnvFile(args.path!)) throw new UserError("Refusing to read .env files");
  const target = resolveInside(root, args.path!);
  if (!existsSync(target)) throw new UserError(`No such file or folder: ${args.path}`);
  assertNotEnv(target);
  if (args.kind === "database" && !detectDatabase(target)) throw new UserError("kind database with a path needs a SQLite file (.db, .sqlite, .sqlite3)");
  // A database is reflected through @mockdata/inputs, whose SQLite introspector opens the file itself — but
  // `openSqlite` verifies post-open that the path still resolves to the same file (dev/ino), so a swapped
  // symlink is refused; see the SEC-H1 note in packages/inputs/src/db/sqlite.ts.
  if (args.kind === "database" || (!args.kind && detectDatabase(target))) {
    return inferFromDatabase(target, opts);
  }
  if (statSync(target).isDirectory()) {
    // A folder of samples: names come from the directory listing, but every
    // file is read through the confined reader, and symlinked children are
    // skipped (with a warning) exactly as inferFromSource did.
    const SAMPLE_EXT = /\.(csv|json|ndjson|jsonl)$/i;
    const skipped: string[] = [];
    const names = readdirSync(target)
      .filter((f) => SAMPLE_EXT.test(f))
      .sort()
      .filter((f) => {
        const isLink = lstatSync(path.join(target, f)).isSymbolicLink();
        if (isLink) skipped.push(f);
        return !isLink;
      });
    const files: { name: string; text: string }[] = [];
    for (const f of names) {
      try {
        files.push({ name: f, text: readFileConfined(root, path.join(target, f), { maxBytes: MAX_SOURCE_BYTES }) });
      } catch (e) {
        if (e instanceof UserError && /symbolic link/.test(e.message)) {
          skipped.push(f);
          continue;
        }
        throw e;
      }
    }
    if (files.length === 0) throw new InferError(`No .csv, .json or .ndjson files in ${target}`);
    const dirResult = inferFromSampleFiles(files, opts);
    for (const f of skipped) dirResult.warnings.push(`Skipped ${f}: symlinks in a sample folder are not followed`);
    return dirResult;
  }
  // A single file: read its bytes through the confined fd, then interpret the
  // content in memory — no path-string read of it remains. This mirrors
  // inferFromSource's dispatch for non-database files.
  const text = readFileConfined(root, target, { maxBytes: MAX_SOURCE_BYTES });
  const ext = path.extname(target).toLowerCase();
  if (args.kind === "json-schema" || (!args.kind && (ext === ".yaml" || ext === ".yml"))) return fromJsonSchema(parseYaml(text), opts);
  if (!args.kind && ext === ".json") {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new InferError(`${target}: invalid JSON (${(e as Error).message})`);
    }
    if (looksLikeJsonSchema(doc)) return fromJsonSchema(doc as Record<string, unknown>, opts);
  }
  return inferFromSampleFiles([{ name: path.basename(target), text }], opts);
}
