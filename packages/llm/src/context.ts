import type { DataSchemaT, Dataset, Row } from "@mockdata/core";

const MAX_OWN_COLUMNS = 10;
const MAX_PARENT_COLUMNS = 6;
const MAX_STRING = 60;

const clip = (v: unknown) => (typeof v === "string" && v.length > MAX_STRING ? v.slice(0, MAX_STRING - 3) + "..." : v);

/** "product_id" / "productId" -> "product"; undefined when the name has no such suffix. */
function relationName(column: string): string | undefined {
  return /^(.+?)(?:_id|Id|ID)$/.exec(column)?.[1];
}

/**
 * Builds the JSON context shown to the model for one row: the row's own
 * values plus, up to `depth` hops, the rows it points at through foreign
 * keys. A foreign key column that resolves to a parent row is replaced by
 * that parent's values (a raw id like 17 tells the model nothing), e.g.
 *
 *   {"rating":2,"product":{"name":"Acme Widget","category":"Gadgets"}}
 *
 * depth 0 gives just the row's own columns. Parent rows are looked up live,
 * so `llm` values filled into a parent earlier are visible to its children.
 */
export function createContextBuilder(schema: DataSchemaT, data: Dataset, depth: number) {
  const indexes = new Map<string, Map<string, Row>>();

  function findParent(table: string, keyColumn: string, value: unknown): Row | undefined {
    const id = `${table}.${keyColumn}`;
    let index = indexes.get(id);
    if (!index) {
      index = new Map((data[table] ?? []).map((r) => [String(r[keyColumn]), r] as const));
      indexes.set(id, index);
    }
    return index.get(String(value));
  }

  function build(table: string, row: Row, skip: Set<string>, levels: number, cap: number, isParent: boolean): Record<string, unknown> {
    const columns = schema.tables[table]!.columns;
    const context: Record<string, unknown> = {};
    const related: [column: string, parentTable: string, values: Record<string, unknown>][] = [];

    for (const [name, value] of Object.entries(row)) {
      if (skip.has(name) || value === null || value === undefined) continue;
      const ref = columns[name]?.ref;
      if (ref) {
        if (levels > 0) {
          const [parentTable, parentKey] = ref.split(".") as [string, string];
          const parent = findParent(parentTable, parentKey, value);
          if (parent) {
            const values = build(parentTable, parent, new Set([parentKey]), levels - 1, MAX_PARENT_COLUMNS, true);
            if (Object.keys(values).length > 0) related.push([name, parentTable, values]);
            continue; // the parent's values replace the raw id
          }
        } else if (isParent) {
          continue; // an unexpanded id inside a parent is just noise
        }
      }
      if (Object.keys(context).length < cap) context[name] = clip(value);
    }

    for (const [column, parentTable, values] of related) {
      let key = relationName(column) ?? parentTable;
      if (key in context) key = column; // never overwrite one of the row's own values
      context[key] = values;
    }
    return context;
  }

  return {
    /** JSON text describing `row` of `table`, leaving out the column being written. */
    describe(table: string, row: Row, writing: string): string {
      return JSON.stringify(build(table, row, new Set([writing]), depth, MAX_OWN_COLUMNS, false));
    },
    /** Whether rows of `table` can carry parent context at all. */
    hasRelated(table: string): boolean {
      return depth > 0 && Object.values(schema.tables[table]!.columns).some((c) => c.ref);
    },
  };
}
