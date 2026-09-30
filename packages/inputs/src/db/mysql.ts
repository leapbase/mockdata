import { InferError } from "../common.js";
import type { RawTable } from "./catalog.js";

export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// Aliases matter: MySQL 8 returns information_schema column names in upper case otherwise.
const COLUMNS = `
  select c.table_name as table_name, c.column_name as column_name, c.column_type as column_type, c.is_nullable as is_nullable
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = ? and t.table_type = 'BASE TABLE'
  order by c.table_name, c.ordinal_position`;

const INDEXES = `
  select s.table_name as table_name, s.index_name as index_name, s.non_unique as non_unique,
         s.column_name as column_name, s.seq_in_index as seq
  from information_schema.statistics s
  where s.table_schema = ?
  order by s.table_name, s.index_name, s.seq_in_index`;

const FOREIGN_KEYS = `
  select k.table_name as table_name, k.constraint_name as constraint_name, k.column_name as column_name,
         k.referenced_table_name as ref_table, k.referenced_column_name as ref_column, k.ordinal_position as pos
  from information_schema.key_column_usage k
  where k.table_schema = ? and k.referenced_table_name is not null
  order by k.table_name, k.constraint_name, k.ordinal_position`;

/** enum('a','b','it''s') -> ["a", "b", "it's"] */
export function parseMysqlEnum(columnType: string): string[] | undefined {
  const m = /^(?:enum)\((.*)\)$/i.exec(columnType.trim());
  if (!m) return undefined;
  const values: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  for (let x = re.exec(m[1]!); x; x = re.exec(m[1]!)) values.push(x[1]!.replace(/''/g, "'"));
  return values;
}

/** Reflect one MySQL/MariaDB database (the schema in `database`) using catalog SELECTs only. */
export async function introspectMysql(query: Query, database: string): Promise<RawTable[]> {
  // Sequential: one connection, one query at a time.
  const columns = await query(COLUMNS, [database]);
  const indexes = await query(INDEXES, [database]);
  const fks = await query(FOREIGN_KEYS, [database]);

  const tables = new Map<string, RawTable>();
  for (const c of columns) {
    const name = String(c.table_name);
    const t = tables.get(name) ?? { name, columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
    const columnType = String(c.column_type);
    const enumValues = parseMysqlEnum(columnType);
    t.columns.push({
      name: String(c.column_name),
      dataType: columnType,
      nullable: c.is_nullable === "YES",
      ...(enumValues ? { enumValues } : {}),
    });
    tables.set(name, t);
  }

  // Group index rows by (table, index), already ordered by seq.
  const byIndex = new Map<string, { table: string; index: string; unique: boolean; columns: string[] }>();
  for (const r of indexes) {
    const key = `${r.table_name}\u0000${r.index_name}`;
    const idx = byIndex.get(key) ?? { table: String(r.table_name), index: String(r.index_name), unique: Number(r.non_unique) === 0, columns: [] };
    idx.columns.push(String(r.column_name));
    byIndex.set(key, idx);
  }
  for (const idx of byIndex.values()) {
    const t = tables.get(idx.table);
    if (!t) continue;
    if (idx.index === "PRIMARY") t.primaryKey = idx.columns;
    else if (idx.unique) t.uniques.push(idx.columns);
  }

  const byFk = new Map<string, { table: string; refTable: string; columns: string[]; refColumns: string[] }>();
  for (const r of fks) {
    const key = `${r.table_name}\u0000${r.constraint_name}`;
    const fk = byFk.get(key) ?? { table: String(r.table_name), refTable: String(r.ref_table), columns: [], refColumns: [] };
    fk.columns.push(String(r.column_name));
    fk.refColumns.push(String(r.ref_column));
    byFk.set(key, fk);
  }
  for (const fk of byFk.values()) {
    tables.get(fk.table)?.foreignKeys.push({ columns: fk.columns, refTable: fk.refTable, refColumns: fk.refColumns });
  }
  return [...tables.values()];
}

/** Connect with `mysql2` (loaded lazily) in a read-only session. The URL must name a database. */
export async function reflectMysql(url: string): Promise<RawTable[]> {
  const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!database) throw new InferError("The MySQL connection URL must include a database name, e.g. mysql://user@host/mydb");
  const { createConnection } = await import("mysql2/promise");
  const conn = await createConnection({ uri: url, connectTimeout: 10_000 });
  try {
    await conn.query("set session transaction read only");
    const query: Query = async (sql, params) => {
      const [rows] = await conn.query(sql, params);
      return rows as Record<string, unknown>[];
    };
    return await introspectMysql(query, database);
  } finally {
    await conn.end().catch(() => undefined);
  }
}
