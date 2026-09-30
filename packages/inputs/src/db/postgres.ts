import type { RawTable } from "./catalog.js";

export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const COLUMNS = `
  select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = $1 and t.table_type = 'BASE TABLE'
  order by c.table_name, c.ordinal_position`;

const ENUMS = `
  select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder)::text[] as labels
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = $1
  group by t.typname`;

// Key columns come back in constraint order, as text[] (name[] is not parsed by drivers).
const CONSTRAINTS = `
  select
    cl.relname as table_name,
    c.contype as kind,
    array(
      select a.attname::text
      from unnest(c.conkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      order by k.ord
    )::text[] as columns,
    fcl.relname as ref_table,
    array(
      select a.attname::text
      from unnest(c.confkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum
      order by k.ord
    )::text[] as ref_columns
  from pg_constraint c
  join pg_class cl on cl.oid = c.conrelid
  join pg_namespace n on n.oid = cl.relnamespace
  left join pg_class fcl on fcl.oid = c.confrelid
  where n.nspname = $1 and c.contype in ('p', 'u', 'f')
  order by cl.relname, c.conname`;

/** Reflect one Postgres schema (default "public") using catalog SELECTs only. */
export async function introspectPostgres(query: Query, schemaName = "public"): Promise<RawTable[]> {
  // Sequential on purpose: one connection runs one query at a time (pg deprecates overlapping calls).
  const columns = await query(COLUMNS, [schemaName]);
  const enums = await query(ENUMS, [schemaName]);
  const constraints = await query(CONSTRAINTS, [schemaName]);
  const enumValues = new Map(enums.map((e) => [String(e.name), e.labels as string[]]));

  const tables = new Map<string, RawTable>();
  for (const c of columns) {
    const name = String(c.table_name);
    const t = tables.get(name) ?? { name, columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
    const udt = String(c.udt_name);
    const isEnum = c.data_type === "USER-DEFINED" && enumValues.has(udt);
    t.columns.push({
      name: String(c.column_name),
      // For arrays and other exotic types keep udt_name so the warning is informative.
      dataType: c.data_type === "USER-DEFINED" || c.data_type === "ARRAY" ? (isEnum ? "enum" : udt) : String(c.data_type),
      nullable: c.is_nullable === "YES",
      ...(isEnum ? { enumValues: enumValues.get(udt) } : {}),
    });
    tables.set(name, t);
  }
  for (const k of constraints) {
    const t = tables.get(String(k.table_name));
    if (!t) continue;
    const cols = k.columns as string[];
    if (k.kind === "p") t.primaryKey = cols;
    else if (k.kind === "u") t.uniques.push(cols);
    else if (k.kind === "f") t.foreignKeys.push({ columns: cols, refTable: String(k.ref_table), refColumns: k.ref_columns as string[] });
  }
  return [...tables.values()];
}

/** Connect with `pg` (loaded lazily) and run introspection inside a read-only transaction. */
export async function reflectPostgres(url: string, schemaName?: string): Promise<RawTable[]> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await client.connect();
  try {
    await client.query("begin read only");
    const query: Query = async (sql, params) => (await client.query(sql, params as unknown[])).rows;
    return await introspectPostgres(query, schemaName);
  } finally {
    await client.end().catch(() => undefined);
  }
}
