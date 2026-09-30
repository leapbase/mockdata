import { Faker, en } from "@faker-js/faker";
import { columnOrder, generationLevels } from "./graph.js";
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
      const max = toMs(col.max, Math.max(DEFAULT_MAX_DATE, min + 365 * DAY));
      if (min > max) throw new GenerationError(`Empty date range [${new Date(min).toISOString()}, ${new Date(max).toISOString()}]`);
      const d = new Date(faker.number.int({ min, max }));
      return col.type === "date" ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    case "string": {
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

function resolveOwner(faker: Faker, path: string): unknown {
  const parts = path.split(".");
  parts.pop();
  return parts.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], faker);
}

export interface GenerateOptions {
  /** Overrides schema.seed. */
  seed?: number;
}

/** Deterministically generate every table, parents before children. */
export function generate(input: unknown, opts: GenerateOptions = {}): Dataset {
  const schema = parseSchema(input);
  const seed = opts.seed ?? schema.seed ?? 1;
  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const data: Dataset = {};
  for (const level of generationLevels(schema)) {
    for (const tname of level) data[tname] = generateTable(schema, tname, data, faker);
  }
  validate(schema, data);
  return data;
}

function generateTable(schema: DataSchemaT, tname: string, data: Dataset, faker: Faker): Row[] {
  const table = schema.tables[tname]!;
  const order = columnOrder(schema, tname);
  const rows: Row[] = [];
  const seen = new Map<string, Set<unknown>>();

  for (let i = 0; i < table.rows; i++) {
    const row: Row = {};
    for (const cname of order) {
      const col = table.columns[cname]!;
      row[cname] = generateCell(schema, tname, cname, col, i, row, rows, data, faker, seen);
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
): unknown {
  const where = `${tname}.${cname}`;
  if (col.nullable && faker.number.float({ min: 0, max: 1 }) < (col.nullRate ?? 0.1)) return null;

  if (col.ref) {
    const [pt, pc] = col.ref.split(".") as [string, string];
    // Self reference: only point at earlier rows so no cycle forms.
    const pool = pt === tname ? earlier : data[pt];
    if (!pool || pool.length === 0) {
      if (col.nullable) return null;
      throw new GenerationError(`${where}: no parent rows available in "${pt}"`);
    }
    const pick = col.distribution === "zipf" ? zipfIndex(faker, pool.length) : faker.number.int({ min: 0, max: pool.length - 1 });
    return pool[pick]![pc];
  }

  let lower: number | undefined;
  if (col.after) lower = resolveAfter(schema, tname, col.after, row, data, where);

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
    const parentRow = (data[pt] ?? []).find((r) => r[pc] === fkValue);
    value = parentRow?.[parts[1]!];
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
export function validate(schema: DataSchemaT, data: Dataset): void {
  const bad: string[] = [];
  for (const [tname, table] of Object.entries(schema.tables)) {
    const rows = data[tname] ?? [];
    for (const [cname, col] of Object.entries(table.columns)) {
      const uniques = new Set<unknown>();
      const parentKeys = col.ref ? new Set((data[col.ref.split(".")[0]!] ?? []).map((r) => r[col.ref!.split(".")[1]!])) : undefined;
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
        if ((col.unique || col.primaryKey) && !col.ref) {
          if (uniques.has(v)) bad.push(`${at}: duplicate ${String(v)}`);
          uniques.add(v);
        }
        if (parentKeys && !parentKeys.has(v)) bad.push(`${at}: orphan foreign key ${String(v)} -> ${col.ref}`);
        if (col.after) {
          const lower = resolveAfter(schema, tname, col.after, row, data, at);
          if (lower !== undefined && Date.parse(String(v)) < lower) bad.push(`${at}: ${String(v)} is before ${col.after}`);
        }
      });
    }
  }
  if (bad.length) throw new ValidationError(bad);
}
