import { InferError, type InferOptions, type InferResult } from "../common.js";
import { catalogToSchema } from "./catalog.js";
import { reflectMysql } from "./mysql.js";
import { reflectPostgres } from "./postgres.js";
import { introspectSqlite, openSqlite } from "./sqlite.js";

export interface DatabaseOptions extends InferOptions {
  /** Postgres schema to reflect (default "public"). */
  schema?: string;
}

export type DbKind = "postgres" | "mysql" | "sqlite";

const URL_KINDS: Record<string, DbKind> = {
  "postgres:": "postgres",
  "postgresql:": "postgres",
  "mysql:": "mysql",
  "mariadb:": "mysql",
  "sqlite:": "sqlite",
};

/** Which database a URL or path refers to, or undefined if it is neither. */
export function detectDatabase(target: string): { kind: DbKind; path?: string } | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(target)?.[1]?.toLowerCase();
  if (scheme && URL_KINDS[scheme]) {
    const kind = URL_KINDS[scheme]!;
    return kind === "sqlite" ? { kind, path: target.replace(/^sqlite:(\/\/)?/i, "") } : { kind };
  }
  if (/\.(db|sqlite|sqlite3)$/i.test(target)) return { kind: "sqlite", path: target };
  return undefined;
}

/** Remove passwords (raw and URL-encoded) from text before it reaches a user or an agent. */
function redact(message: string, target: string): string {
  let out = message;
  try {
    const u = new URL(target);
    for (const secret of [u.password, decodeURIComponent(u.password)]) if (secret) out = out.split(secret).join("***");
  } catch {
    /* not a URL; nothing to redact */
  }
  return out;
}

/**
 * Reflect a live database into a schema: postgres:// or postgresql://,
 * mysql:// or mariadb://, or a SQLite file (sqlite:path or *.db/.sqlite/.sqlite3).
 * Only catalog metadata is read, in read-only mode; no table rows are touched.
 */
export async function inferFromDatabase(target: string, opts: DatabaseOptions = {}): Promise<InferResult> {
  const db = detectDatabase(target);
  if (!db) throw new InferError("Unrecognised database (expected postgres://, mysql://, mariadb://, sqlite:<file>, or a .db/.sqlite file)");
  try {
    if (db.kind === "sqlite") {
      const { db: handle, close } = await openSqlite(db.path!);
      try {
        return catalogToSchema(introspectSqlite(handle), opts);
      } finally {
        close();
      }
    }
    const tables = db.kind === "postgres" ? await reflectPostgres(target, opts.schema) : await reflectMysql(target);
    if (tables.length === 0) throw new InferError(`No tables found${opts.schema ? ` in schema "${opts.schema}"` : ""}`);
    return catalogToSchema(tables, opts);
  } catch (e) {
    if (e instanceof InferError) throw new InferError(redact(e.message, target));
    throw new InferError(`Database error: ${redact((e as Error).message || String(e), target)}`);
  }
}
