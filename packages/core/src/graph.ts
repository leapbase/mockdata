import type { DataSchemaT } from "./schema.js";

export class CycleError extends Error {
  constructor(public readonly tables: string[]) {
    super(`Foreign key cycle between tables: ${tables.join(", ")}`);
    this.name = "CycleError";
  }
}

/** table -> set of parent tables (self references excluded; they are handled per row). */
export function tableDependencies(schema: DataSchemaT): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const [tname, table] of Object.entries(schema.tables)) {
    const parents = new Set<string>();
    for (const col of Object.values(table.columns)) {
      if (!col.ref) continue;
      const parent = col.ref.split(".")[0]!;
      if (parent !== tname) parents.add(parent);
    }
    deps.set(tname, parents);
  }
  return deps;
}

/**
 * Group tables into levels: level 0 has no parents, level N depends only on
 * earlier levels. Throws CycleError instead of guessing an order.
 */
export function generationLevels(schema: DataSchemaT): string[][] {
  const deps = tableDependencies(schema);
  const done = new Set<string>();
  const levels: string[][] = [];
  while (done.size < deps.size) {
    const ready = [...deps.entries()]
      .filter(([t, ps]) => !done.has(t) && [...ps].every((p) => done.has(p)))
      .map(([t]) => t);
    if (ready.length === 0) {
      throw new CycleError([...deps.keys()].filter((t) => !done.has(t)));
    }
    ready.forEach((t) => done.add(t));
    levels.push(ready);
  }
  return levels;
}

/**
 * Order a table's columns so that `after` sources come first. Foreign keys
 * are placed before anything that reads through them.
 */
export function columnOrder(schema: DataSchemaT, tableName: string): string[] {
  const table = schema.tables[tableName]!;
  const names = Object.keys(table.columns);
  const needs = (c: string): string[] => {
    const col = table.columns[c]!;
    if (!col.after) return [];
    return [col.after.split(".")[0]!];
  };
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (c: string) => {
    if (state.get(c) === "done") return;
    if (state.get(c) === "visiting") throw new CycleError([tableName + "." + c]);
    state.set(c, "visiting");
    needs(c).forEach(visit);
    state.set(c, "done");
    out.push(c);
  };
  names.forEach(visit);
  return out;
}
