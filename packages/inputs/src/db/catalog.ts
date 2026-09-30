import {
  DEFAULT_ROWS,
  fakerHint,
  finalize,
  safeColumnName,
  safeTableName,
  uniqueName,
  type ColumnDoc,
  type InferOptions,
  type InferResult,
  type SchemaDoc,
} from "../common.js";

/** What every dialect's introspection produces; catalogToSchema turns it into a schema. */
export interface RawColumn {
  name: string;
  /** Declared type as the database reports it, e.g. "character varying", "varchar(255)", "tinyint(1)". */
  dataType: string;
  nullable: boolean;
  enumValues?: string[];
}

export interface RawTable {
  name: string;
  columns: RawColumn[];
  primaryKey: string[];
  /** Each entry is the column list of one unique constraint or index. */
  uniques: string[][];
  foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
}

type Mapped = { type: string; enum?: string[]; note?: string };

/** Map a database type to a mockdata column type. */
export function mapDbType(dataType: string, enumValues?: string[]): Mapped {
  const t = dataType.toLowerCase().trim();
  const base = t.replace(/\(.*?\)/g, "").replace(/\s+(unsigned|zerofill|signed)\b/g, "").trim();

  if (enumValues && enumValues.length > 0) return { type: "string", enum: enumValues };
  if (t === "tinyint(1)" || /^bool(ean)?$/.test(base) || base === "bit" && t === "bit(1)") return { type: "boolean" };
  if (/^(tiny|small|medium|big)?int(eger)?[248]?$|^(small|big)?serial[248]?$|^int$/.test(base)) return { type: "integer" };
  if (/^(numeric|decimal|dec|real|double|double precision|float[48]?|number|money|smallmoney)$/.test(base)) return { type: "float" };
  if (base === "date") return { type: "date" };
  if (/^(datetime2?|smalldatetime|timestamp)( with(out)? time zone)?$/.test(base) || base === "timestamptz") return { type: "datetime" };
  if (base === "uuid" || base === "uniqueidentifier") return { type: "uuid" };
  if (/^(character varying|character|varchar|nvarchar|char|nchar|text|tinytext|mediumtext|longtext|citext|string|clob|name|bpchar|varchar2)$/.test(base) || base === "") {
    return { type: "string" };
  }
  if (/^time( with(out)? time zone)?$|^timetz$|^interval$|^year$/.test(base)) return { type: "string", note: `${dataType} has no mockdata type` };
  return { type: "string", note: `type "${dataType}" mapped to string` };
}

const EMAIL_NAME = /(^|_)e-?mail(_address)?$/i;

/**
 * Turn a reflected catalog into a schema. Constraints are carried over where
 * mockdata can express them (single-column keys, uniqueness, nullability,
 * enums, foreign keys); anything else is dropped with a warning.
 */
export function catalogToSchema(rawTables: RawTable[], opts: InferOptions = {}): InferResult {
  const warnings: string[] = [];
  const schema: SchemaDoc = { tables: {} };

  // Sanitised names, remembering the mapping so foreign keys can follow.
  const tableNames = new Set<string>();
  const tableName = new Map<string, string>();
  for (const t of rawTables) tableName.set(t.name, uniqueName(safeTableName(t.name), tableNames));
  const colName = new Map<string, string>(); // "table.col" (raw) -> safe col name
  const colType = new Map<string, string>(); // "table.col" (raw) -> mockdata type
  for (const t of rawTables) {
    const taken = new Set<string>();
    for (const c of t.columns) {
      colName.set(`${t.name}.${c.name}`, uniqueName(safeColumnName(c.name), taken));
      colType.set(`${t.name}.${c.name}`, mapDbType(c.dataType, c.enumValues).type);
    }
  }

  /** Columns other tables may reference: single-column PK or single-column unique. */
  const referencable = new Map<string, Set<string>>();
  for (const t of rawTables) {
    const set = new Set<string>();
    if (t.primaryKey.length === 1) set.add(t.primaryKey[0]!);
    for (const u of t.uniques) if (u.length === 1) set.add(u[0]!);
    referencable.set(t.name, set);
  }

  for (const t of rawTables) {
    const tname = tableName.get(t.name)!;
    const singlePk = t.primaryKey.length === 1 ? t.primaryKey[0]! : undefined;
    if (t.primaryKey.length > 1) {
      warnings.push(`${tname}: composite primary key (${t.primaryKey.join(", ")}) is not supported; uniqueness of the combination is not enforced`);
    }
    const uniqueCols = new Set(t.uniques.filter((u) => u.length === 1).map((u) => u[0]!));
    for (const u of t.uniques.filter((u) => u.length > 1)) {
      warnings.push(`${tname}: composite unique (${u.join(", ")}) is not supported and was ignored`);
    }

    const columns: Record<string, ColumnDoc> = {};
    for (const c of t.columns) {
      const name = colName.get(`${t.name}.${c.name}`)!;
      const mapped = mapDbType(c.dataType, c.enumValues);
      if (mapped.note) warnings.push(`${tname}.${name}: ${mapped.note}`);
      const col: ColumnDoc = { type: mapped.type };
      if (mapped.enum) col.enum = mapped.enum;
      if (c.name === singlePk) col.primaryKey = true;
      else if (uniqueCols.has(c.name)) col.unique = true;
      if (c.nullable && c.name !== singlePk) col.nullable = true;

      if (col.type === "string" && !col.enum && !col.primaryKey) {
        if (EMAIL_NAME.test(c.name)) col.type = "email";
        else {
          const hint = fakerHint(tname, name);
          if (hint) col.faker = hint;
        }
      }
      columns[name] = col;
    }

    for (const fk of t.foreignKeys) {
      const where = `${tname}.${fk.columns.map((c) => colName.get(`${t.name}.${c}`)).join("+")}`;
      if (fk.columns.length !== 1 || fk.refColumns.length !== 1) {
        warnings.push(`${where}: composite foreign key to ${fk.refTable} is not supported and was dropped`);
        continue;
      }
      const [from] = fk.columns as [string];
      const [to] = fk.refColumns as [string];
      const parentName = tableName.get(fk.refTable);
      if (!parentName) {
        warnings.push(`${where}: foreign key to "${fk.refTable}", which was not reflected; dropped`);
        continue;
      }
      if (!referencable.get(fk.refTable)?.has(to)) {
        warnings.push(`${where}: references ${fk.refTable}.${to}, which is not a single-column primary key or unique column; dropped`);
        continue;
      }
      if (colType.get(`${t.name}.${from}`) !== colType.get(`${fk.refTable}.${to}`)) {
        warnings.push(`${where}: type differs from ${fk.refTable}.${to}; foreign key dropped`);
        continue;
      }
      const col = columns[colName.get(`${t.name}.${from}`)!]!;
      col.ref = `${parentName}.${colName.get(`${fk.refTable}.${to}`)}`;
      delete col.enum;
      delete col.faker;
      if (fk.refTable === t.name && !col.nullable) {
        col.nullable = true;
        warnings.push(`${where}: self-referencing foreign key made nullable (the first row has no parent)`);
      }
    }
    schema.tables[tname] = { rows: opts.rows ?? DEFAULT_ROWS, columns };
  }
  return finalize(schema, warnings);
}
