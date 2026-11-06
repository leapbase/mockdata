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
  /**
   * Memoised parent contexts: "parentTable\0keyColumn\0keyValue\0levelsLeft"
   * -> the object `build()` produced for that parent. Many children share a
   * parent, and without this the parent's values were re-walked and
   * re-serialised for every one of them. The cached object is only ever
   * read (embedded, then JSON.stringify'd by `describe`), never mutated,
   * so sharing it across rows is safe.
   *
   * Scoping: the cache lives for ONE column's fill (see `beginColumn`),
   * because a parent's values change when the model writes them — but
   * columns fill one at a time, parents before children, so within one
   * child column's fill the parent values are stable. The one exception
   * is a self-referencing table, whose rows are both parent and child of
   * the same fill: `invalidate` drops that table's entries after each
   * batch is written, so later batches see the fresh values. A fill-wide
   * cache would be wrong for both reasons.
   */
  const parentCache = new Map<string, Record<string, unknown>>();

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
            // The parent's context depends only on which parent row it is
            // and how many hops are left (its own foreign keys expand one
            // level less each hop); the column being written is skipped
            // only at the top level, never inside a parent.
            const cacheKey = `${parentTable}\0${parentKey}\0${String(value)}\0${levels}`;
            let values = parentCache.get(cacheKey);
            if (!values) {
              values = build(parentTable, parent, new Set([parentKey]), levels - 1, MAX_PARENT_COLUMNS, true);
              parentCache.set(cacheKey, values);
            }
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
    /**
     * Start a new column's fill: drop every cached parent context. Parent
     * values written by an earlier column's fill must appear in this
     * column's prompts, so no entry may survive across columns.
     */
    beginColumn(): void {
      parentCache.clear();
    },
    /**
     * Drop cached parent contexts for `table` only, after rows of that
     * table were written. Needed for self-referencing tables, where a
     * parent row's values change during its own column's fill; for any
     * other table the entries are untouched, so the cross-batch reuse
     * survives.
     */
    invalidate(table: string): void {
      const prefix = `${table}\0`;
      for (const key of [...parentCache.keys()]) if (key.startsWith(prefix)) parentCache.delete(key);
    },
  };
}
