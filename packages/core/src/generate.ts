import { Faker, en } from "@faker-js/faker";
import { columnOrder, planGeneration } from "./graph.js";
import { parseSchema, type Column, type DataSchemaT } from "./schema.js";

export type Row = Record<string, unknown>;
export type Dataset = Record<string, Row[]>;

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

const DAY = 86_400_000;
const DEFAULT_MIN_DATE = Date.UTC(2020, 0, 1);
const DEFAULT_MAX_DATE = Date.UTC(2025, 0, 1);

function toMs(v: number | string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const ms = typeof v === "number" ? v : Date.parse(v);
  if (Number.isNaN(ms)) throw new GenerationError(`Invalid date bound: ${v}`);
  return ms;
}

/** Pick an index in [0, n) with a Zipf-like skew (low indexes are hot). */
function zipfIndex(faker: Faker, n: number): number {
  const u = faker.number.float({ min: 0, max: 1 });
  return Math.min(n - 1, Math.floor(n ** u) - 1);
}

function resolveOwner(faker: Faker, path: string): unknown {
  const parts = path.split(".");
  parts.pop();
  return parts.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], faker);
}

function generateValue(faker: Faker, col: Column, lowerBoundMs?: number): unknown {
  if (col.enum) return faker.helpers.arrayElement(col.enum);
  switch (col.type) {
    case "integer":
      return faker.number.int({ min: Number(col.min ?? 0), max: Number(col.max ?? 1_000_000) });
    case "float":
      return faker.number.float({ min: Number(col.min ?? 0), max: Number(col.max ?? 1000), fractionDigits: 2 });
    case "boolean":
      return faker.datatype.boolean();
    case "uuid":
      return faker.string.uuid();
    case "email":
      return faker.internet.email().toLowerCase();
    case "date":
    case "datetime": {
      const min = Math.max(toMs(col.min, DEFAULT_MIN_DATE), lowerBoundMs ?? -Infinity);
      const span = col.within !== undefined && lowerBoundMs !== undefined ? lowerBoundMs + col.within * DAY : undefined;
      const max = Math.min(toMs(col.max, span ?? Math.max(DEFAULT_MAX_DATE, min + 365 * DAY)), span ?? Infinity);
      if (min > max) throw new GenerationError(`Empty date range [${new Date(min).toISOString()}, ${new Date(max).toISOString()}]`);
      const d = new Date(faker.number.int({ min, max }));
      return col.type === "date" ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    case "string": {
      if (col.pattern) return faker.helpers.fromRegExp(col.pattern);
      if (col.faker) {
        const owner = resolveOwner(faker, col.faker) as Record<string, unknown> | undefined;
        const fn = owner?.[col.faker.split(".").pop()!];
        if (typeof fn !== "function") throw new GenerationError(`Unknown faker path "${col.faker}"`);
        return String((fn as () => unknown).call(owner));
      }
      return faker.lorem.words(3);
    }
  }
}

/** Max children a single parent row may have for this foreign key. */
function parentCap(col: Column): number {
  if (col.unique) return 1;
  return col.maxPerParent ?? Infinity;
}

/**
 * How many children each parent row has, and which parents still have room. Finding "the first parent at or after
 * `start` with spare capacity" is a union-find over full parents (each full parent points at the next index, with
 * path compression), so a long run of full parents is skipped in near-constant time instead of probed one by one.
 * That matters for zipf skew, which piles picks onto the first few parents: a linear probe was quadratic.
 */
export class ParentUsage {
  private readonly counts: number[] = [];
  /** next[i] is i while parent i has room; once full it points further along. */
  private readonly next: number[] = [];

  private ensure(size: number): void {
    // Growing pools (self references) add parents with room at the end.
    while (this.next.length < size) {
      this.counts.push(0);
      this.next.push(this.next.length);
    }
  }

  /** The first index >= i below `size` that still has room, or `size` if there is none. */
  private find(i: number, size: number): number {
    let root = i;
    while (root < size && this.next[root] !== root) root = this.next[root]!;
    if (root > size) root = size;
    // Path compression: everything on the way now points straight at the answer.
    let node = i;
    while (node < size && this.next[node] !== node) {
      const following = this.next[node]!;
      this.next[node] = root;
      node = following;
    }
    return root;
  }

  /**
   * Take one slot from the first parent at or after `start` (wrapping round) with room under `cap`, as a forward
   * probe would. Undefined when every parent is full. With no cap nothing needs tracking.
   */
  pick(start: number, poolSize: number, cap: number): number | undefined {
    if (poolSize === 0) return undefined;
    if (cap === Infinity) return start;
    this.ensure(poolSize);
    let idx = this.find(start, poolSize);
    if (idx >= poolSize) {
      idx = this.find(0, poolSize);
      if (idx >= start) return undefined; // wrapped all the way round
    }
    this.counts[idx] = (this.counts[idx] ?? 0) + 1;
    if (this.counts[idx]! >= cap) this.next[idx] = idx + 1;
    return idx;
  }
}

/**
 * Choose a parent row index for a foreign key, honouring the distribution and the per-parent cap (moving on from
 * the pick when a parent is full). Returns undefined when every parent is at capacity.
 */
function pickParent(faker: Faker, col: Column, poolSize: number, used: ParentUsage): number | undefined {
  if (poolSize === 0) return undefined;
  const start = col.distribution === "zipf" ? zipfIndex(faker, poolSize) : faker.number.int({ min: 0, max: poolSize - 1 });
  return used.pick(start, poolSize, parentCap(col));
}

export interface GenerateOptions {
  /** Overrides schema.seed. */
  seed?: number;
  /**
   * Leave `llm` columns null instead of failing, so an async pass (see
   * @mockdata/llm) can fill them. The result is not fully validated until then.
   */
  deferLlm?: boolean;
}

/** Columns marked `llm`, in schema order. */
export function llmColumns(schema: DataSchemaT): { table: string; column: string; prompt?: string }[] {
  const out: { table: string; column: string; prompt?: string }[] = [];
  for (const [table, t] of Object.entries(schema.tables)) {
    for (const [column, col] of Object.entries(t.columns)) {
      if (col.llm) out.push({ table, column, prompt: col.llm === true ? undefined : col.llm.prompt });
    }
  }
  return out;
}

/** Deterministically generate every table, parents before children. */
export function generate(input: unknown, opts: GenerateOptions = {}): Dataset {
  const schema = parseSchema(input);
  const seed = opts.seed ?? schema.seed ?? 1;
  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const pending = llmColumns(schema);
  if (pending.length > 0 && !opts.deferLlm) {
    const first = pending[0]!;
    throw new GenerationError(
      `${first.table}.${first.column} uses "llm"; generate with an LLM provider (generateWithLlm in @mockdata/llm) instead of generate()`,
    );
  }

  const plan = planGeneration(schema);
  const deferred = new Set(plan.deferred);
  /** "table.column" -> parent row index -> number of children so far. */
  const usage = new Map<string, ParentUsage>();

  const data: Dataset = {};
  for (const level of plan.levels) {
    for (const tname of level) data[tname] = generateTable(schema, tname, data, faker, deferred, usage);
  }
  for (const key of plan.deferred) fillDeferred(schema, key, data, faker, usage);
  validate(schema, data, { skipLlm: pending.length > 0 });
  return data;
}

function usageFor(usage: Map<string, ParentUsage>, key: string): ParentUsage {
  let m = usage.get(key);
  if (!m) usage.set(key, (m = new ParentUsage()));
  return m;
}

function generateTable(
  schema: DataSchemaT,
  tname: string,
  data: Dataset,
  faker: Faker,
  deferred: Set<string>,
  usage: Map<string, ParentUsage>,
): Row[] {
  const table = schema.tables[tname]!;
  const order = columnOrder(schema, tname);
  const rows: Row[] = [];
  const seen = new Map<string, Set<unknown>>();

  for (let i = 0; i < table.rows; i++) {
    const row: Row = {};
    for (const cname of order) {
      const col = table.columns[cname]!;
      const key = `${tname}.${cname}`;
      // llm cells stay `undefined` (pending) for the async fill pass; null means intentionally null.
      row[cname] = deferred.has(key)
        ? null
        : col.llm
        ? col.nullable && faker.number.float({ min: 0, max: 1 }) < (col.nullRate ?? 0.1)
          ? null
          : undefined
        : generateCell(schema, tname, cname, col, i, row, rows, data, faker, seen, usageFor(usage, key), deferred);
    }
    rows.push(row);
  }
  return rows;
}

function generateCell(
  schema: DataSchemaT,
  tname: string,
  cname: string,
  col: Column,
  index: number,
  row: Row,
  earlier: Row[],
  data: Dataset,
  faker: Faker,
  seen: Map<string, Set<unknown>>,
  used: ParentUsage,
  deferred: Set<string>,
): unknown {
  const where = `${tname}.${cname}`;
  if (col.nullable && faker.number.float({ min: 0, max: 1 }) < (col.nullRate ?? 0.1)) return null;

  if (col.ref) {
    const [pt, pc] = col.ref.split(".") as [string, string];
    // Self reference: only point at earlier rows so no cycle forms.
    const pool = pt === tname ? earlier : (data[pt] ?? []);
    const pick = pickParent(faker, col, pool.length, used);
    if (pick === undefined) {
      if (col.nullable) return null;
      throw new GenerationError(
        pool.length === 0
          ? `${where}: no parent rows available in "${pt}"`
          : `${where}: all ${pool.length} parent rows in "${pt}" are at their per-parent limit of ${parentCap(col)}`,
      );
    }
    return pool[pick]![pc];
  }

  let lower: number | undefined;
  if (col.after) {
    const via = col.after.split(".");
    if (via.length === 2 && deferred.has(`${tname}.${via[0]}`)) {
      throw new GenerationError(`${where}: "after ${col.after}" reads through "${via[0]}", which is nullable and deferred to break a table cycle`);
    }
    lower = resolveAfter(schema, tname, col.after, row, data, where);
  }

  const unique = col.unique || col.primaryKey;
  if (unique && col.type === "integer" && !col.enum && col.min === undefined && col.max === undefined) {
    return index + 1; // sequential ids: unique by construction
  }

  const attempts = unique ? 50 : 1;
  const set = seen.get(cname) ?? new Set<unknown>();
  seen.set(cname, set);
  for (let a = 0; a < attempts; a++) {
    const v = generateValue(faker, col, lower);
    if (!unique) return v;
    if (!set.has(v)) {
      set.add(v);
      return v;
    }
  }
  throw new GenerationError(`${where}: could not generate a unique value after ${attempts} attempts`);
}

/** Second pass: fill a foreign key that was left null to break a table cycle. */
function fillDeferred(
  schema: DataSchemaT,
  key: string,
  data: Dataset,
  faker: Faker,
  usage: Map<string, ParentUsage>,
): void {
  const [tname, cname] = key.split(".") as [string, string];
  const col = schema.tables[tname]!.columns[cname]!;
  const [pt, pc] = col.ref!.split(".") as [string, string];
  const pool = data[pt] ?? [];
  const used = usageFor(usage, key);
  for (const row of data[tname] ?? []) {
    if (faker.number.float({ min: 0, max: 1 }) < (col.nullRate ?? 0.1)) continue; // stays null
    const pick = pickParent(faker, col, pool.length, used);
    if (pick === undefined) continue; // parents full: nullable, so leave null
    row[cname] = pool[pick]![pc];
  }
}

interface RowIndex {
  byKey: Map<unknown, Row>;
  /** How many rows of the table have been indexed so far (a table that is still being generated keeps growing). */
  upTo: number;
}
const rowIndexes = new WeakMap<Dataset, Map<string, RowIndex>>();

/**
 * The first row of `table` whose `column` equals `value`, through an index built lazily as rows appear. A scan per
 * lookup made `after: fk.col` quadratic. Referenced columns are primary keys or unique, so first-wins is exact.
 */
function lookupRow(data: Dataset, table: string, column: string, value: unknown): Row | undefined {
  let byTable = rowIndexes.get(data);
  if (!byTable) rowIndexes.set(data, (byTable = new Map()));
  const key = `${table}.${column}`;
  let index = byTable.get(key);
  if (!index) byTable.set(key, (index = { byKey: new Map(), upTo: 0 }));
  const rows = data[table] ?? [];
  for (; index.upTo < rows.length; index.upTo++) {
    const r = rows[index.upTo]!;
    if (!index.byKey.has(r[column])) index.byKey.set(r[column], r);
  }
  return index.byKey.get(value);
}

function resolveAfter(schema: DataSchemaT, tname: string, after: string, row: Row, data: Dataset, where: string): number | undefined {
  const parts = after.split(".");
  let value: unknown;
  if (parts.length === 1) {
    value = row[parts[0]!];
  } else {
    const fkCol = schema.tables[tname]!.columns[parts[0]!]!;
    const fkValue = row[parts[0]!];
    if (fkValue === null || fkValue === undefined) return undefined;
    const [pt, pc] = fkCol.ref!.split(".") as [string, string];
    value = lookupRow(data, pt, pc, fkValue)?.[parts[1]!];
  }
  if (value === null || value === undefined) return undefined;
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) throw new GenerationError(`${where}: "after" source "${after}" is not a date`);
  return ms;
}

export class ValidationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`${violations.length} constraint violation(s):\n  ` + violations.slice(0, 10).join("\n  "));
    this.name = "ValidationError";
  }
}

/** Hard post-check: generators should never violate these; if they do, fail loudly. */
export function validate(schema: DataSchemaT, data: Dataset, opts: { skipLlm?: boolean } = {}): void {
  const bad: string[] = [];
  for (const [tname, table] of Object.entries(schema.tables)) {
    const rows = data[tname] ?? [];
    for (const [cname, col] of Object.entries(table.columns)) {
      if (opts.skipLlm && col.llm) continue;
      const uniques = new Set<unknown>();
      const children = new Map<unknown, number>();
      const parentKeys = col.ref ? new Set((data[col.ref.split(".")[0]!] ?? []).map((r) => r[col.ref!.split(".")[1]!])) : undefined;
      const pattern = col.pattern ? new RegExp(`^(?:${col.pattern})$`) : undefined;
      rows.forEach((row, i) => {
        const v = row[cname];
        const at = `${tname}[${i}].${cname}`;
        if (v === null || v === undefined) {
          if (!col.nullable) bad.push(`${at}: null in non-nullable column`);
          return;
        }
        if (col.enum && !col.enum.includes(v as never)) bad.push(`${at}: ${String(v)} not in enum`);
        if (typeof v === "number") {
          if (col.min !== undefined && v < Number(col.min)) bad.push(`${at}: ${v} < min ${col.min}`);
          if (col.max !== undefined && v > Number(col.max)) bad.push(`${at}: ${v} > max ${col.max}`);
        }
        if (pattern && !pattern.test(String(v))) bad.push(`${at}: "${String(v)}" does not match /${col.pattern}/`);
        if (col.unique || col.primaryKey) {
          if (uniques.has(v)) bad.push(`${at}: duplicate ${String(v)}`);
          uniques.add(v);
        }
        if (col.ref) {
          const n = (children.get(v) ?? 0) + 1;
          children.set(v, n);
          if (n > parentCap(col) && n === parentCap(col) + 1) bad.push(`${at}: more than ${parentCap(col)} children for parent ${String(v)}`);
        }
        if (parentKeys && !parentKeys.has(v)) bad.push(`${at}: orphan foreign key ${String(v)} -> ${col.ref}`);
        if (col.after) {
          const lower = resolveAfter(schema, tname, col.after, row, data, at);
          if (lower !== undefined && Date.parse(String(v)) < lower) bad.push(`${at}: ${String(v)} is before ${col.after}`);
          if (lower !== undefined && col.within !== undefined && Date.parse(String(v)) > lower + col.within * DAY) {
            bad.push(`${at}: ${String(v)} is more than ${col.within} days after ${col.after}`);
          }
        }
      });
    }
  }
  if (bad.length) throw new ValidationError(bad);
}
