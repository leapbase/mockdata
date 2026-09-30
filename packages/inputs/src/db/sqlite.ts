import { InferError } from "../common.js";
import type { RawTable } from "./catalog.js";

type Row = Record<string, unknown>;

/** Minimal surface of node:sqlite's DatabaseSync that introspection needs. */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Reflect a SQLite database with PRAGMAs. Read-only; nothing is written. */
export function introspectSqlite(db: SqliteLike): RawTable[] {
  const tables = db
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all()
    .map((r) => String(r.name));

  return tables.map((name) => {
    const info = db.prepare(`pragma table_info(${quote(name)})`).all();
    const pk = info
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => String(c.name));

    // Foreign keys: rows sharing an id form one (possibly composite) key.
    const fkRows = db.prepare(`pragma foreign_key_list(${quote(name)})`).all();
    const fkById = new Map<number, { columns: string[]; refTable: string; refColumns: (string | null)[] }>();
    for (const r of fkRows.sort((a, b) => Number(a.seq) - Number(b.seq))) {
      const id = Number(r.id);
      const fk = fkById.get(id) ?? { columns: [], refTable: String(r.table), refColumns: [] };
      fk.columns.push(String(r.from));
      fk.refColumns.push(r.to === null || r.to === undefined ? null : String(r.to));
      fkById.set(id, fk);
    }
    const foreignKeys = [...fkById.values()].map((fk) => {
      // `to` is NULL when the key implicitly targets the parent's primary key.
      let refColumns = fk.refColumns as string[];
      if (fk.refColumns.some((c) => c === null)) {
        const parentPk = db
          .prepare(`pragma table_info(${quote(fk.refTable)})`)
          .all()
          .filter((c) => Number(c.pk) > 0)
          .sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((c) => String(c.name));
        refColumns = parentPk;
      }
      return { columns: fk.columns, refTable: fk.refTable, refColumns };
    });

    const uniques: string[][] = [];
    for (const idx of db.prepare(`pragma index_list(${quote(name)})`).all()) {
      if (Number(idx.unique) !== 1 || Number(idx.partial) === 1) continue;
      if (idx.origin === "pk") continue; // the primary key, reported separately
      const cols = db
        .prepare(`pragma index_info(${quote(String(idx.name))})`)
        .all()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => String(c.name));
      uniques.push(cols);
    }

    return {
      name,
      columns: info.map((c) => ({
        name: String(c.name),
        dataType: String(c.type ?? ""),
        // A lone INTEGER PRIMARY KEY is a rowid alias and never null even without NOT NULL.
        nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
      })),
      primaryKey: pk,
      uniques,
      foreignKeys,
    };
  });
}

/** Open a SQLite file read-only using Node's built-in driver. */
export async function openSqlite(path: string): Promise<{ db: SqliteLike; close: () => void }> {
  let mod: typeof import("node:sqlite");
  try {
    mod = await import("node:sqlite");
  } catch {
    throw new InferError("SQLite support needs Node 22.5 or newer (node:sqlite is not available)");
  }
  try {
    const db = new mod.DatabaseSync(path, { readOnly: true });
    return { db: db as unknown as SqliteLike, close: () => db.close() };
  } catch (e) {
    throw new InferError(`Cannot open SQLite database "${path}": ${(e as Error).message}`);
  }
}
