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

type Json = Record<string, any>;

/** Resolve a local "#/a/b" JSON pointer. */
function resolveRef(doc: Json, ref: string): Json {
  if (!ref.startsWith("#/")) throw new InferError(`Only local $refs are supported (got "${ref}")`);
  let node: any = doc;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (node === undefined || typeof node !== "object") throw new InferError(`Unresolvable $ref "${ref}"`);
  return node;
}

/** Follow $ref chains and merge allOf into one schema with combined properties/required. */
function flatten(doc: Json, schema: Json, depth = 0): Json {
  if (depth > 20) throw new InferError("$ref/allOf nesting is too deep (cycle?)");
  if (schema.$ref) return flatten(doc, { ...resolveRef(doc, schema.$ref), ...omit(schema, "$ref") }, depth + 1);
  if (!Array.isArray(schema.allOf)) return schema;
  const merged: Json = { ...omit(schema, "allOf"), properties: { ...schema.properties }, required: [...(schema.required ?? [])] };
  for (const part of schema.allOf) {
    const p = flatten(doc, part, depth + 1);
    Object.assign(merged.properties, p.properties);
    merged.required.push(...(p.required ?? []));
    for (const [k, v] of Object.entries(p)) if (!["properties", "required", "allOf"].includes(k) && merged[k] === undefined) merged[k] = v;
  }
  return merged;
}

function omit(o: Json, key: string): Json {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

const isObjectSchema = (s: Json) => (s.type === "object" || s.properties !== undefined) && s.properties && Object.keys(s.properties).length > 0;

interface Converted {
  column?: ColumnDoc;
  nullable: boolean;
  skipReason?: string;
}

/** Convert one property schema into a column (or explain why it was skipped). */
function convertProperty(doc: Json, prop: Json): Converted {
  let s = flatten(doc, prop);
  let nullable = s.nullable === true;

  // anyOf/oneOf with null (Pydantic Optional[X], OpenAPI 3.1): peel null off.
  for (const key of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(s[key])) continue;
    const parts = s[key].map((p: Json) => flatten(doc, p));
    const nonNull = parts.filter((p: Json) => p.type !== "null");
    if (nonNull.length !== parts.length) nullable = true;
    if (nonNull.length !== 1) return { nullable, skipReason: `${key} with ${nonNull.length} alternatives` };
    s = { ...omit(omit(s, key), "nullable"), ...nonNull[0] };
  }

  let type = s.type;
  if (Array.isArray(type)) {
    if (type.includes("null")) nullable = true;
    const rest = type.filter((t: string) => t !== "null");
    if (rest.length !== 1) return { nullable, skipReason: `union type [${type.join(", ")}]` };
    type = rest[0];
  }

  if (s.const !== undefined) s = { ...s, enum: [s.const] };
  if (Array.isArray(s.enum)) {
    const values = s.enum.filter((v: unknown) => v !== null);
    if (values.length !== s.enum.length) nullable = true;
    if (values.length > 0 && values.every((v: unknown) => ["string", "number", "boolean"].includes(typeof v))) {
      const allInts = values.every((v: unknown) => Number.isInteger(v));
      const t = typeof values[0] === "string" ? "string" : typeof values[0] === "boolean" ? "boolean" : allInts ? "integer" : "float";
      return { nullable, column: { type: t, enum: values } };
    }
  }

  if (type === "array" || type === "object" || s.properties) {
    return { nullable, skipReason: type === "array" ? "array" : "nested object" };
  }
  if (type === undefined) return { nullable, skipReason: "no type" };

  const column: ColumnDoc = { type: "string" };
  switch (type) {
    case "integer":
      column.type = "integer";
      break;
    case "number":
      column.type = "float";
      break;
    case "boolean":
      column.type = "boolean";
      break;
    case "string": {
      const fmt = s.format;
      if (fmt === "date") column.type = "date";
      else if (fmt === "date-time") column.type = "datetime";
      else if (fmt === "uuid") column.type = "uuid";
      else if (fmt === "email") column.type = "email";
      break;
    }
    default:
      return { nullable, skipReason: `type "${String(type)}"` };
  }
  if ((column.type === "integer" || column.type === "float") && typeof s.minimum === "number") column.min = s.minimum;
  if ((column.type === "integer" || column.type === "float") && typeof s.maximum === "number") column.max = s.maximum;
  if (column.type === "string" && typeof s.pattern === "string") {
    // The generator builds strings from the regex body; anchors are implied.
    column.pattern = s.pattern.replace(/^\^/, "").replace(/\$$/, "");
  }
  if (typeof s["x-mockdata-ref"] === "string") column.ref = s["x-mockdata-ref"];
  return { nullable, column };
}

/**
 * Turn a JSON Schema document (including Pydantic's model_json_schema output)
 * or an OpenAPI 3.x / Swagger 2 spec into a mockdata schema. Every object
 * schema with properties becomes a table.
 *
 * Relationships are inferred (JSON Schema has no foreign keys): a property
 * named `<thing>_id` / `<thing>Id` becomes a foreign key to the table named
 * <thing> (or its plural) when that table has a same-typed `id`. Add
 * `x-mockdata-ref: "table.column"` on a property to be explicit, and `x-rows`
 * on a schema to choose its row count.
 */
export function fromJsonSchema(doc: Json, opts: InferOptions = {}): InferResult {
  if (doc === null || typeof doc !== "object") throw new InferError("Expected a JSON Schema or OpenAPI document (an object)");
  const warnings: string[] = [];

  // Collect candidate table schemas by name.
  const candidates: [string, Json][] = [];
  if (doc.openapi || doc.swagger) {
    const defs = doc.components?.schemas ?? doc.definitions;
    if (!defs) throw new InferError("OpenAPI document has no components.schemas");
    candidates.push(...Object.entries<Json>(defs));
  } else {
    for (const [name, s] of Object.entries<Json>({ ...doc.definitions, ...doc.$defs })) candidates.push([name, s]);
    if (isObjectSchema(flatten(doc, doc))) candidates.unshift([doc.title ?? "root", omit(omit(doc, "$defs"), "definitions")]);
  }

  const schema: SchemaDoc = { tables: {} };
  const tableNames = new Set<string>();
  const required = new Map<string, Set<string>>();
  for (const [rawName, raw] of candidates) {
    const flat = flatten(doc, raw);
    if (!isObjectSchema(flat)) continue;
    const tname = uniqueName(safeTableName(rawName), tableNames);
    const req = new Set<string>(flat.required ?? []);
    required.set(tname, req);
    const columns: Record<string, ColumnDoc> = {};
    const colNames = new Set<string>();
    for (const [rawCol, prop] of Object.entries<Json>(flat.properties)) {
      const conv = convertProperty(doc, prop);
      if (!conv.column) {
        warnings.push(`${tname}.${rawCol}: skipped (${conv.skipReason})`);
        continue;
      }
      const cname = uniqueName(safeColumnName(rawCol), colNames);
      const col = conv.column;
      const isKey = rawCol.toLowerCase() === "id" && ["integer", "uuid", "string"].includes(col.type) && !col.enum;
      if (isKey) {
        col.primaryKey = true;
        delete col.min;
        delete col.max;
        delete col.pattern;
      } else if (conv.nullable || !req.has(rawCol)) {
        col.nullable = true;
      }
      columns[cname] = col;
    }
    if (Object.keys(columns).length === 0) continue;
    schema.tables[tname] = { rows: Number.isInteger(flat["x-rows"]) ? flat["x-rows"] : (opts.rows ?? DEFAULT_ROWS), columns };
  }
  if (Object.keys(schema.tables).length === 0) throw new InferError("No object schemas with properties found");

  // Faker hints for plain string columns.
  for (const [tname, t] of Object.entries(schema.tables)) {
    for (const [cname, col] of Object.entries(t.columns)) {
      if (col.type === "string" && !col.enum && !col.pattern && !col.ref && !col.primaryKey) {
        const hint = fakerHint(tname, cname);
        if (hint) col.faker = hint;
      }
    }
  }

  // Foreign keys from naming conventions.
  const keys = new Map<string, KeyInfo>();
  for (const [tname, t] of Object.entries(schema.tables)) {
    const pk = Object.entries(t.columns).find(([, c]) => c.primaryKey);
    keys.set(tname, { key: pk ? { column: pk[0], type: pk[1].type } : undefined });
  }
  for (const [tname, t] of Object.entries(schema.tables)) {
    for (const [cname, col] of Object.entries(t.columns)) {
      if (col.primaryKey) continue;
      if (!col.ref) {
        const parent = guessParent(cname, col.type, tname, keys);
        if (parent) col.ref = `${parent.table}.${parent.column}`;
      }
      if (col.ref) {
        delete col.min;
        delete col.max;
        delete col.enum;
        delete col.faker;
        delete col.pattern;
      }
      if (typeof col.ref === "string" && col.ref.split(".")[0] === tname && !col.nullable) {
        col.nullable = true;
        warnings.push(`${tname}.${cname}: self-referencing foreign key made nullable (the first row has no parent)`);
      }
    }
  }
  return finalize(schema, warnings);
}
