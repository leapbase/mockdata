import type { DataSchemaT } from "./schema.js";

export class CycleError extends Error {
  constructor(public readonly tables: string[]) {
    super(`Foreign key cycle between tables: ${tables.join(", ")}`);
    this.name = "CycleError";
  }
}

interface Edge {
  table: string;
  column: string;
  parent: string;
  nullable: boolean;
}

/** Foreign key edges between different tables (self references are handled per row). */
function edges(schema: DataSchemaT): Edge[] {
  const out: Edge[] = [];
  for (const [table, t] of Object.entries(schema.tables)) {
    for (const [column, col] of Object.entries(t.columns)) {
      if (!col.ref) continue;
      const parent = col.ref.split(".")[0]!;
      if (parent !== table) out.push({ table, column, parent, nullable: !!col.nullable });
    }
  }
  return out;
}

/** table -> set of parent tables (self references excluded). */
export function tableDependencies(schema: DataSchemaT): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>(Object.keys(schema.tables).map((t) => [t, new Set<string>()]));
  for (const e of edges(schema)) deps.get(e.table)!.add(e.parent);
  return deps;
}

function levelsOf(deps: Map<string, Set<string>>): string[][] {
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

export interface GenerationPlan {
  /** Tables grouped so that parents always come before children. */
  levels: string[][];
  /**
   * "table.column" foreign keys that are nullable and were left null on the
   * first pass to break a table cycle; they are filled in afterwards.
   */
  deferred: string[];
}

/**
 * Plan generation order. A cycle is only broken by deferring a nullable
 * foreign key that lies on the cycle; otherwise CycleError is thrown rather
 * than guessing an order.
 */
export function planGeneration(schema: DataSchemaT): GenerationPlan {
  const all = edges(schema);
  const deferred = new Set<string>();
  for (;;) {
    const deps = new Map<string, Set<string>>(Object.keys(schema.tables).map((t) => [t, new Set<string>()]));
    for (const e of all) if (!deferred.has(`${e.table}.${e.column}`)) deps.get(e.table)!.add(e.parent);
    try {
      return { levels: levelsOf(deps), deferred: [...deferred] };
    } catch (err) {
      if (!(err instanceof CycleError)) throw err;
      const stuck = new Set(err.tables);
      const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
        if (from === to) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        return [...(deps.get(from) ?? [])].some((p) => stuck.has(p) && reaches(p, to, seen));
      };
      // An edge child->parent is on a cycle when the parent depends (transitively) on the child.
      const breakable = all.find(
        (e) => e.nullable && !deferred.has(`${e.table}.${e.column}`) && stuck.has(e.table) && stuck.has(e.parent) && reaches(e.parent, e.table),
      );
      if (!breakable) throw err;
      deferred.add(`${breakable.table}.${breakable.column}`);
    }
  }
}

export function generationLevels(schema: DataSchemaT): string[][] {
  return planGeneration(schema).levels;
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
