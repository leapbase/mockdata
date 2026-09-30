import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  detectDatabase,
  fromJsonSchema,
  inferFromDatabase,
  inferFromSampleFiles,
  inferFromSource,
  looksLikeJsonSchema,
  type InferResult,
} from "@mockdata/inputs";
import { loadEnv } from "./env.js";

/**
 * Helpers for servers (MCP, web UI) that act on input from an untrusted
 * caller: every path is confined to a root, and secrets are only ever named,
 * never accepted or echoed. Do not write to stdout here (MCP uses it as its protocol channel).
 */

/** Problems caused by the caller's input; servers report them as 4xx / tool errors, not crashes. */
export class UserError extends Error {}

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
  return target;
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
  if (args.kind === "database" && !detectDatabase(target)) throw new UserError("kind database with a path needs a SQLite file (.db, .sqlite, .sqlite3)");
  return inferFromSource(target, opts);
}
