import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { InferError } from "../common.js";
import type { RawTable } from "./catalog.js";

type Row = Record<string, unknown>;

/** Minimal surface of node:sqlite's DatabaseSync that introspection needs. */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
}

/** Reflect a SQLite database with table-valued PRAGMAs. Read-only; nothing is written. */
export function introspectSqlite(db: SqliteLike): RawTable[] {
  // Three catalog queries for the whole database, instead of several
  // PRAGMA round trips per table (plus a repeat parent lookup whenever a
  // foreign key's target was implicit): table-valued PRAGMAs join against
  // sqlite_master, and the parent primary keys needed for implicit targets
  // come from the same column pass, in memory.
  const columnRows = db
    .prepare(
      `select m.name as t, p.cid as cid, p.name as name, p.type as type, p."notnull" as "notnull", p.pk as pk
       from sqlite_master m, pragma_table_info(m.name) p
       where m.type = 'table' and m.name not like 'sqlite_%'
       order by m.name, p.cid`,
    )
    .all();
  const fkRows = db
    .prepare(
      `select m.name as t, f.id as id, f.seq as seq, f."table" as "table", f."from" as "from", f."to" as "to"
       from sqlite_master m, pragma_foreign_key_list(m.name) f
       where m.type = 'table' and m.name not like 'sqlite_%'
       order by m.name, f.id, f.seq`,
    )
    .all();
  const indexRows = db
    .prepare(
      `select m.name as t, l.seq as iseq, l.name as idx, l."unique" as "unique", l.origin as origin, l.partial as partial,
              i.seqno as seqno, i.name as col
       from sqlite_master m, pragma_index_list(m.name) l, pragma_index_info(l.name) i
       where m.type = 'table' and m.name not like 'sqlite_%'
       order by m.name, l.seq, i.seqno`,
    )
    .all();

  const tables = new Map<string, RawTable>();
  const pkRows: { table: string; pos: number; name: string }[] = [];
  for (const c of columnRows) {
    const name = String(c.t);
    let t = tables.get(name);
    if (!t) {
      t = { name, columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
      tables.set(name, t);
    }
    t.columns.push({
      name: String(c.name),
      dataType: String(c.type ?? ""),
      // A lone INTEGER PRIMARY KEY is a rowid alias and never null even without NOT NULL.
      nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
    });
    if (Number(c.pk) > 0) pkRows.push({ table: name, pos: Number(c.pk), name: String(c.name) });
  }
  // Primary-key columns are ordered by their pk position, not by cid.
  for (const r of pkRows.sort((a, b) => a.pos - b.pos)) tables.get(r.table)!.primaryKey.push(r.name);

  // Foreign keys: rows sharing an id form one (possibly composite) key.
  const fkById = new Map<string, { table: string; columns: string[]; refTable: string; refColumns: (string | null)[] }>();
  for (const r of fkRows) {
    const key = `${r.t}\u0000${r.id}`;
    const fk = fkById.get(key) ?? { table: String(r.t), columns: [], refTable: String(r.table), refColumns: [] };
    fk.columns.push(String(r.from));
    fk.refColumns.push(r.to === null || r.to === undefined ? null : String(r.to));
    fkById.set(key, fk);
  }
  for (const fk of fkById.values()) {
    // `to` is NULL when the key implicitly targets the parent's primary key.
    const refColumns = fk.refColumns.some((c) => c === null)
      ? (tables.get(fk.refTable)?.primaryKey ?? [])
      : (fk.refColumns as string[]);
    tables.get(fk.table)?.foreignKeys.push({ columns: fk.columns, refTable: fk.refTable, refColumns });
  }

  // Unique indexes in index order. Partial and expression indexes are left out of `uniques` (inference cannot express
  // them) but recorded in `unsupportedForSeed`, since seeding rows straight into such a table could violate them.
  const uniquesByIndex = new Map<string, { table: string; name: string; partial: boolean; columns: string[] }>();
  for (const r of indexRows) {
    if (Number(r.unique) !== 1) continue;
    if (r.origin === "pk") continue; // the primary key, reported separately
    const key = `${r.t}\u0000${r.idx}`;
    const idx = uniquesByIndex.get(key) ?? { table: String(r.t), name: String(r.idx), partial: Number(r.partial) === 1, columns: [] };
    idx.columns.push(String(r.col)); // an expression column has a NULL name, which reads as "null"
    uniquesByIndex.set(key, idx);
  }
  for (const idx of uniquesByIndex.values()) {
    const t = tables.get(idx.table);
    if (!t) continue;
    const unsupported = idx.partial ? `partial unique index ${idx.name}` : idx.columns.includes("null") ? `expression unique index ${idx.name}` : undefined;
    if (unsupported) (t.unsupportedForSeed ??= []).push(unsupported);
    else t.uniques.push(idx.columns);
  }

  return [...tables.values()];
}

/**
 * Identity of the file a SQLite path resolves to right now: canonical path
 * plus device/inode. Exported for testing; see verifySqliteIdentity.
 */
export interface SqliteIdentity {
  dev: number;
  ino: number;
  real: string;
}

/**
 * Capture the identity of the file `path` resolves to, by opening the
 * resolved file and fstat'ing it. Returns undefined for `:memory:`, for an
 * empty path, and when the file cannot be resolved/opened at all (the
 * DatabaseSync open then reports the failure in its usual form).
 */
export function captureSqliteIdentity(path: string): SqliteIdentity | undefined {
  if (path === "" || path === ":memory:") return undefined;
  try {
    const real = realpathSync(path);
    const fd = openSync(real, constants.O_RDONLY);
    try {
      const st = fstatSync(fd);
      return { dev: st.dev, ino: st.ino, real };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Check that `path` still resolves to the file captured by
 * captureSqliteIdentity: same canonical target and same device/inode.
 * Throws InferError if it does not (the path was swapped, renamed or
 * deleted in between) or can no longer be resolved.
 */
export function verifySqliteIdentity(path: string, expected: SqliteIdentity): void {
  let real: string;
  try {
    real = realpathSync(path);
    const st = statSync(path);
    if (real !== expected.real || st.dev !== expected.dev || st.ino !== expected.ino) {
      throw new InferError(`SQLite database "${path}" changed while opening; refusing to read it`);
    }
  } catch (e) {
    if (e instanceof InferError) throw e;
    throw new InferError(`SQLite database "${path}" changed while opening; refusing to read it`);
  }
}

/**
 * Open a SQLite file read-only using Node's built-in driver.
 *
 * SEC-H1 remainder: node:sqlite's DatabaseSync takes a path, not an fd, so
 * the open cannot be anchored to an already-open file descriptor the way the
 * confined file reader is. The best available hardening is check-then-open-
 * then-verify: capture the identity of the file the path resolves to,
 * construct DatabaseSync (which opens the file eagerly — a missing file
 * throws in the constructor), and verify the path still resolves to that
 * same file before returning. A symlink swapped in between the caller's
 * confinement check and this open is therefore detected and refused, unless
 * it is swapped back again inside that microsecond window (see below).
 */
export async function openSqlite(path: string): Promise<{ db: SqliteLike; close: () => void }> {
  let mod: typeof import("node:sqlite");
  try {
    mod = await import("node:sqlite");
  } catch {
    throw new InferError("SQLite support needs Node 22.5 or newer (node:sqlite is not available)");
  }
  const expected = captureSqliteIdentity(path);
  let db: InstanceType<typeof mod.DatabaseSync>;
  try {
    db = new mod.DatabaseSync(path, { readOnly: true });
  } catch (e) {
    throw new InferError(`Cannot open SQLite database "${path}": ${(e as Error).message}`);
  }
  if (expected) {
    try {
      verifySqliteIdentity(path, expected);
    } catch (e) {
      db.close();
      throw e;
    }
  }
  return { db: db as unknown as SqliteLike, close: () => db.close() };
}
