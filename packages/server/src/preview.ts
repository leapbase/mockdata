import { UserError } from "@mockdata/cli";
import { llmColumns, type DataSchemaT, type Dataset } from "@mockdata/core";

/** The preview generates the full tables in memory, so its size is bounded. */
export const PREVIEW_MAX_TOTAL_ROWS = 200_000;

export interface PreviewTable {
  columns: string[];
  /** column -> "parentTable.parentColumn" for foreign keys */
  refs: Record<string, string>;
  rows: Record<string, unknown>[];
}

export interface Preview {
  seed: number;
  counts: Record<string, number>;
  tables: Record<string, PreviewTable>;
  /** "table.column" of llm columns that have no values yet. */
  pending: string[];
}

/** Optionally set every table to `rows`, then refuse schemas too large to preview. */
export function applyRowOverride(schema: DataSchemaT, rows: number | undefined): DataSchemaT {
  const out = structuredClone(schema);
  if (rows !== undefined) for (const t of Object.values(out.tables)) t.rows = rows;
  const total = Object.values(out.tables).reduce((n, t) => n + t.rows, 0);
  if (total > PREVIEW_MAX_TOTAL_ROWS) {
    throw new UserError(`The preview would generate ${total} rows; the limit is ${PREVIEW_MAX_TOTAL_ROWS}. Lower the row counts or set a smaller row override, then use Export for the full data.`);
  }
  return out;
}

export function buildPreview(schema: DataSchemaT, data: Dataset, opts: { seed?: number; rows: number; tables?: string[] }): Preview {
  const names = Object.keys(schema.tables).filter((n) => !opts.tables || opts.tables.includes(n));
  const tables: Record<string, PreviewTable> = {};
  for (const name of names) {
    const cols = schema.tables[name]!.columns;
    const columns = Object.keys(cols);
    const refs: Record<string, string> = {};
    for (const [c, col] of Object.entries(cols)) if (col.ref) refs[c] = col.ref;
    tables[name] = {
      columns,
      refs,
      // undefined (a pending llm cell) becomes null so JSON keeps the key.
      rows: (data[name] ?? []).slice(0, opts.rows).map((r) => Object.fromEntries(columns.map((c) => [c, r[c] === undefined ? null : r[c]]))),
    };
  }
  return {
    seed: opts.seed ?? schema.seed ?? 1,
    counts: Object.fromEntries(Object.entries(data).map(([t, r]) => [t, r.length])),
    tables,
    // A cell is pending while it is undefined (null means intentionally null).
    pending: llmColumns(schema)
      .filter((c) => (data[c.table] ?? []).some((r) => r[c.column] === undefined))
      .map((c) => `${c.table}.${c.column}`),
  };
}
