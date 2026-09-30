import { CycleError, parseSchema, planGeneration, SchemaError } from "@mockdata/core";

/** A schema as plain data, ready to serialise to YAML/JSON. */
export type SchemaDoc = { tables: Record<string, TableDoc> };
export type TableDoc = { rows: number; columns: Record<string, ColumnDoc> };
export type ColumnDoc = Record<string, unknown> & { type: string };

export interface InferResult {
  schema: SchemaDoc;
  /** Things that were skipped, guessed or approximated; worth a human look. */
  warnings: string[];
}

export interface InferOptions {
  /** Rows per table in the generated schema (default: 100, or the sample size for sample data). */
  rows?: number;
}

export class InferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferError";
  }
}

export const DEFAULT_ROWS = 100;

/** Table names double as file names; force them into the core alphabet. */
export function safeTableName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (s === "") s = "table";
  if (!/^[A-Za-z_]/.test(s)) s = `t_${s}`;
  return s;
}

/** Column names may not contain "." (refs and `after` split on it) or whitespace. */
export function safeColumnName(raw: string): string {
  const s = raw.trim().replace(/[.\s]+/g, "_");
  return s === "" ? "column" : s;
}

/** Make names unique by suffixing _2, _3, ... */
export function uniqueName(name: string, taken: Set<string>): string {
  let out = name;
  for (let i = 2; taken.has(out); i++) out = `${name}_${i}`;
  taken.add(out);
  return out;
}

export const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function singular(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith("ies") && n.length > 3) return n.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(n)) return n.slice(0, -2);
  if (n.endsWith("s") && !n.endsWith("ss") && n.length > 1) return n.slice(0, -1);
  return n;
}

/** "customer_id" / "customerId" / "CustomerID" -> "customer". */
export function foreignKeyBase(column: string): string | undefined {
  const m = /^(.+?)(?:_id|Id|ID)$/.exec(column);
  return m ? m[1] : undefined;
}

export interface KeyInfo {
  /** Primary-key (or unique) column other tables may reference, and its type. */
  key?: { column: string; type: string };
}

/**
 * Find the table a `<thing>_id` column most likely points at: a table whose
 * (singular) name equals <thing> and that has a same-typed key. Never the
 * column's own table.
 */
export function guessParent(
  column: string,
  columnType: string,
  ownTable: string,
  tables: Map<string, KeyInfo>,
): { table: string; column: string } | undefined {
  const base = foreignKeyBase(column);
  if (!base) return undefined;
  const want = normalize(base);
  for (const [name, info] of tables) {
    if (name === ownTable || !info.key || info.key.type !== columnType) continue;
    if (normalize(singular(name)) === want || normalize(name) === want) return { table: name, column: info.key.column };
  }
  return undefined;
}

const PERSON_TABLES = /^(customer|user|person|people|employee|contact|member|author|patient|student|teacher|owner|client|lead|account|profile)s?$/;

/** Faker path for common columns, by name. Returns undefined when there is no confident match. */
export function fakerHint(table: string, column: string): string | undefined {
  const c = normalize(column);
  const byName: Record<string, string> = {
    fullname: "person.fullName",
    firstname: "person.firstName",
    givenname: "person.firstName",
    lastname: "person.lastName",
    surname: "person.lastName",
    familyname: "person.lastName",
    jobtitle: "person.jobTitle",
    city: "location.city",
    country: "location.country",
    state: "location.state",
    zip: "location.zipCode",
    zipcode: "location.zipCode",
    postalcode: "location.zipCode",
    address: "location.streetAddress",
    streetaddress: "location.streetAddress",
    street: "location.streetAddress",
    phone: "phone.number",
    phonenumber: "phone.number",
    mobile: "phone.number",
    telephone: "phone.number",
    company: "company.name",
    companyname: "company.name",
    organization: "company.name",
    url: "internet.url",
    website: "internet.url",
    username: "internet.username",
    productname: "commerce.productName",
    description: "lorem.sentence",
    summary: "lorem.sentence",
    comment: "lorem.sentence",
    notes: "lorem.sentence",
    bio: "lorem.sentence",
  };
  if (byName[c]) return byName[c];
  if (c === "name" && PERSON_TABLES.test(normalize(table))) return "person.fullName";
  return undefined;
}

/**
 * Last step for every loader: confirm the result is a schema mockdata accepts
 * and can order, turning any problem into a warning so the user still gets
 * the file to fix by hand.
 */
export function finalize(schema: SchemaDoc, warnings: string[]): InferResult {
  try {
    const parsed = parseSchema(schema);
    planGeneration(parsed);
  } catch (e) {
    if (e instanceof SchemaError || e instanceof CycleError) {
      warnings.push(`The inferred schema does not validate as-is: ${e.message}`);
    } else {
      throw e;
    }
  }
  return { schema, warnings };
}
