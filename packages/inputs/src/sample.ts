import {
  DEFAULT_ROWS,
  fakerHint,
  finalize,
  guessParent,
  InferError,
  safeColumnName,
  safeTableName,
  uniqueName,
  type ColumnDoc,
  type InferOptions,
  type InferResult,
  type KeyInfo,
  type SchemaDoc,
} from "./common.js";

export type SampleRow = Record<string, unknown>;
export type SampleFormat = "csv" | "json" | "ndjson";

/** Minimal RFC 4180 CSV parser: quoted fields, "" escapes, CRLF, newlines inside quotes. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawAnything = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      sawAnything = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      sawAnything = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (sawAnything || field !== "") {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      sawAnything = false;
    } else {
      field += ch;
      sawAnything = true;
    }
  }
  if (quoted) throw new InferError("CSV has an unterminated quoted field");
  if (sawAnything || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Guess the format from a file name (or content when there is no useful extension). */
export function guessSampleFormat(name: string, text: string): SampleFormat {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "ndjson" || ext === "jsonl") return "ndjson";
  if (ext === "json") return "json";
  const t = text.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) return t.includes("\n{") && !t.startsWith("[") && t.split("\n").filter(Boolean).length > 1 ? "ndjson" : "json";
  return "csv";
}

/**
 * Parse sample text into tables. CSV and NDJSON are one table named `name`;
 * JSON may be an array of objects (one table) or an object mapping table
 * names to arrays of objects (many).
 */
export function parseSample(text: string, name: string, format?: SampleFormat): Record<string, SampleRow[]> {
  const fmt = format ?? guessSampleFormat(name, text);
  const table = safeTableName(name.replace(/\.[A-Za-z0-9]+$/, ""));
  const asRows = (v: unknown, where: string): SampleRow[] => {
    if (!Array.isArray(v) || !v.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      throw new InferError(`${where}: expected an array of objects`);
    }
    return v as SampleRow[];
  };
  if (fmt === "csv") {
    const [header, ...body] = parseCsv(text);
    if (!header) throw new InferError(`${name}: empty CSV`);
    const names = new Set<string>();
    const cols = header.map((h) => uniqueName(safeColumnName(h), names));
    return { [table]: body.map((cells) => Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]))) };
  }
  if (fmt === "ndjson") {
    const rows = text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new InferError(`${name}: line ${i + 1} is not valid JSON`);
      }
    });
    return { [table]: asRows(rows, name) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new InferError(`${name}: invalid JSON (${(e as Error).message})`);
  }
  if (Array.isArray(parsed)) return { [table]: asRows(parsed, name) };
  if (parsed && typeof parsed === "object") {
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [safeTableName(k), asRows(v, `${name}: "${k}"`)]));
  }
  throw new InferError(`${name}: expected a JSON array or an object of arrays`);
}

// --- value classification ---------------------------------------------------

type Kind = "integer" | "float" | "boolean" | "date" | "datetime" | "uuid" | "email" | "string";

const RE = {
  int: /^-?(0|[1-9]\d{0,14})$/,
  float: /^-?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/,
  bool: /^(true|false)$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

/** Classify a value. CSV cells are all strings, so `textual` lets "42" count as an integer. */
function classify(v: unknown, textual: boolean): Kind {
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "float";
  if (typeof v === "boolean") return "boolean";
  const s = String(v);
  if (textual) {
    if (RE.int.test(s)) return "integer";
    if (RE.float.test(s) && s !== "") return "float";
    if (RE.bool.test(s)) return "boolean";
  }
  if (RE.date.test(s) && !Number.isNaN(Date.parse(s))) return "date";
  if (RE.datetime.test(s) && !Number.isNaN(Date.parse(s))) return "datetime";
  if (RE.uuid.test(s)) return "uuid";
  if (RE.email.test(s)) return "email";
  return "string";
}

function unify(kinds: Set<Kind>): Kind {
  if (kinds.size === 1) return [...kinds][0]!;
  if (kinds.size === 2 && kinds.has("integer") && kinds.has("float")) return "float";
  if (kinds.size === 2 && kinds.has("date") && kinds.has("datetime")) return "datetime";
  return "string";
}

const isNull = (v: unknown) => v === null || v === undefined || v === "";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

interface Analysis {
  column: ColumnDoc;
  kind: Kind;
  values: unknown[]; // non-null
  distinct: number;
  nullCount: number;
}

export interface SampleOptions extends InferOptions {
  /** Emit `enum` for low-cardinality string columns (copies observed values into the schema). Default true. */
  enums?: boolean;
}

const MIN_ROWS_FOR_UNIQUE = 20;
const MIN_ROWS_FOR_RULES = 20;

function analyzeColumn(rows: SampleRow[], name: string, textual: boolean, opts: SampleOptions): Analysis | undefined {
  const raw = rows.map((r) => r[name]);
  const values = raw.filter((v) => !isNull(v));
  if (values.length === 0) return undefined;
  if (values.some((v) => typeof v === "object")) return undefined; // nested data is out of scope
  const kinds = new Set(values.map((v) => classify(v, textual)));
  const kind = unify(kinds);
  const distinctSet = new Set(values.map(String));
  const column: ColumnDoc = { type: kind };

  if (kind === "integer" || kind === "float") {
    const nums = values.map(num);
    column.min = round(Math.min(...nums), 4);
    column.max = round(Math.max(...nums), 4);
  } else if (kind === "date" || kind === "datetime") {
    const sorted = values.map(String).sort();
    column.min = sorted[0];
    column.max = sorted[sorted.length - 1];
  }

  const nullCount = raw.length - values.length;
  if (nullCount > 0) {
    column.nullable = true;
    column.nullRate = Math.max(0.01, round(nullCount / raw.length));
  }

  const allDistinct = distinctSet.size === values.length;
  if (allDistinct && (kind === "uuid" || kind === "email" || (values.length >= MIN_ROWS_FOR_UNIQUE && (kind === "integer" || kind === "string")))) {
    column.unique = true;
  }

  if (kind === "string" && opts.enums !== false && values.length >= 10 && distinctSet.size <= 12 && distinctSet.size <= values.length / 2) {
    const freq = new Map<string, number>();
    for (const v of values) freq.set(String(v), (freq.get(String(v)) ?? 0) + 1);
    column.enum = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  }
  return { column, kind, values, distinct: distinctSet.size, nullCount };
}

/** Rank how strongly the children of a foreign key cluster on few parents (0..1). */
function topShare(childValues: unknown[]): { share: number; parents: number } {
  const counts = new Map<string, number>();
  for (const v of childValues) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const top = Math.max(1, Math.ceil(sorted.length * 0.2));
  return { share: sorted.slice(0, top).reduce((a, b) => a + b, 0) / childValues.length, parents: sorted.length };
}

/**
 * Infer a schema from example rows. Only shape is copied: types, ranges,
 * null rates, small enums, name-based faker hints, relationships and date
 * ordering. Individual rows and free-text values are not.
 *
 * `tables` maps table name -> rows. `textual` says values came from CSV, so
 * numeric-looking strings are numbers.
 */
export function inferFromSamples(
  tables: Record<string, SampleRow[]>,
  opts: SampleOptions & { textual?: boolean | Record<string, boolean> } = {},
): InferResult {
  const warnings: string[] = [];
  const schema: SchemaDoc = { tables: {} };
  const analyses = new Map<string, Map<string, Analysis>>();
  const textualFor = (t: string) => (typeof opts.textual === "object" ? (opts.textual[t] ?? false) : (opts.textual ?? false));

  for (const [tname, rows] of Object.entries(tables)) {
    if (rows.length === 0) {
      warnings.push(`${tname}: no rows, skipped`);
      continue;
    }
    const colNames = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cols = new Map<string, Analysis>();
    for (const c of colNames) {
      const a = analyzeColumn(rows, c, textualFor(tname), opts);
      if (a) cols.set(c, a);
      else warnings.push(`${tname}.${c}: skipped (empty or nested values)`);
    }
    if (cols.size === 0) continue;
    analyses.set(tname, cols);
    schema.tables[tname] = { rows: opts.rows ?? rows.length ?? DEFAULT_ROWS, columns: Object.fromEntries([...cols].map(([c, a]) => [c, a.column])) };
  }
  if (Object.keys(schema.tables).length === 0) throw new InferError("No usable sample rows found");

  // Primary keys: an all-distinct `id` / `<table>_id` integer or uuid column.
  const keys = new Map<string, KeyInfo>();
  for (const [tname, cols] of analyses) {
    const singularName = tname.toLowerCase().replace(/s$/, "");
    const pkName = [...cols.keys()].find((c) => {
      const n = c.toLowerCase();
      const a = cols.get(c)!;
      return (n === "id" || n === `${singularName}_id` || n === `${tname.toLowerCase()}_id`) && (a.kind === "integer" || a.kind === "uuid") && a.distinct === a.values.length && a.nullCount === 0;
    });
    if (pkName) {
      const col = schema.tables[tname]!.columns[pkName]!;
      col.primaryKey = true;
      delete col.unique;
      if (col.type === "integer") {
        delete col.min; // integer keys are generated 1..rows
        delete col.max;
      }
    }
    keys.set(tname, { key: pkName ? { column: pkName, type: cols.get(pkName)!.kind } : undefined });
  }

  // Foreign keys (by name, then shape), faker hints, self-reference safety.
  for (const [tname, cols] of analyses) {
    const t = schema.tables[tname]!;
    for (const [cname, a] of cols) {
      const col = t.columns[cname]!;
      if (col.primaryKey) continue;
      const parent = guessParent(cname, a.kind, tname, keys);
      if (parent) {
        col.ref = `${parent.table}.${parent.column}`;
        delete col.min;
        delete col.max;
        delete col.unique;
        const parentKeys = new Set(analyses.get(parent.table)!.get(parent.column)!.values.map(String));
        if (!a.values.every((v) => parentKeys.has(String(v)))) {
          warnings.push(`${tname}.${cname}: some values are not present in ${parent.table}.${parent.column} (the sample of ${parent.table} may be partial)`);
        }
        if (a.distinct === a.values.length && a.values.length >= 5) col.unique = true; // one-to-one
        const { share, parents } = topShare(a.values);
        if (parents >= 10 && share > 0.6) col.distribution = "zipf";
      } else if (col.type === "string" && !col.enum) {
        const hint = fakerHint(tname, cname);
        if (hint) col.faker = hint;
      }
    }
  }

  inferDateRules(schema, analyses, tables, warnings);
  return finalize(schema, warnings);
}

const ms = (v: unknown) => Date.parse(String(v));

/** Propose `after` rules that hold in every observed row (and only with enough rows to mean something). */
function inferDateRules(
  schema: SchemaDoc,
  analyses: Map<string, Map<string, Analysis>>,
  samples: Record<string, SampleRow[]>,
  warnings: string[],
): void {
  const isDate = (a?: Analysis) => a?.kind === "date" || a?.kind === "datetime";

  for (const [tname, cols] of analyses) {
    const rows = samples[tname]!;
    const t = schema.tables[tname]!;
    const dateCols = [...cols].filter(([, a]) => isDate(a)).map(([c]) => c);

    for (const a of dateCols) {
      if (t.columns[a]!.after) continue;
      const candidates: { source: string; typical: number }[] = [];

      // Same-row: a >= b in every row where both are present.
      for (const b of dateCols) {
        if (a === b) continue;
        const pairs = rows.filter((r) => !isNull(r[a]) && !isNull(r[b])).map((r) => [ms(r[a]), ms(r[b])] as const);
        if (pairs.length < MIN_ROWS_FOR_RULES) continue;
        const holds = pairs.every(([x, y]) => x >= y);
        const strict = pairs.filter(([x, y]) => x > y).length;
        if (holds && strict >= pairs.length / 2) candidates.push({ source: b, typical: pairs.map(([, y]) => y).sort((p, q) => p - q)[Math.floor(pairs.length / 2)]! });
      }

      // Through a foreign key: child date >= parent date in every joined row.
      for (const [fkName, fkCol] of Object.entries(t.columns)) {
        if (typeof fkCol.ref !== "string") continue;
        const [pt, pc] = fkCol.ref.split(".") as [string, string];
        const parentRows = samples[pt];
        const parentCols = analyses.get(pt);
        if (!parentRows || !parentCols) continue;
        for (const [pd, pa] of parentCols) {
          if (!isDate(pa)) continue;
          const byKey = new Map(parentRows.map((r) => [String(r[pc]), r[pd]] as const));
          const pairs = rows
            .filter((r) => !isNull(r[a]) && !isNull(r[fkName]) && !isNull(byKey.get(String(r[fkName]))))
            .map((r) => [ms(r[a]), ms(byKey.get(String(r[fkName])))] as const);
          if (pairs.length < MIN_ROWS_FOR_RULES) continue;
          const strict = pairs.filter(([x, y]) => x > y).length;
          if (pairs.every(([x, y]) => x >= y) && strict >= pairs.length / 2) {
            candidates.push({ source: `${fkName}.${pd}`, typical: pairs.map(([, y]) => y).sort((p, q) => p - q)[Math.floor(pairs.length / 2)]! });
          }
        }
      }

      if (candidates.length === 0) continue;
      // The latest typical lower bound is the tightest constraint.
      candidates.sort((p, q) => q.typical - p.typical);
      const chosen = candidates[0]!.source;
      t.columns[a]!.after = chosen;
      // A fixed upper bound could leave no valid range once the lower bound moves; the generator extends it.
      delete t.columns[a]!.max;
      warnings.push(`${tname}.${a}: inferred "after ${chosen}" (held in every sample row)`);
    }
  }
}
