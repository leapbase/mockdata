import { z } from "zod";

export const COLUMN_TYPES = [
  "integer",
  "float",
  "string",
  "boolean",
  "date",
  "datetime",
  "uuid",
  "email",
] as const;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const ColumnSchema = z
  .object({
    type: z.enum(COLUMN_TYPES),
    primaryKey: z.boolean().optional(),
    unique: z.boolean().optional(),
    nullable: z.boolean().optional(),
    /** Fraction of rows set to null when nullable (default 0.1). */
    nullRate: z.number().min(0).max(1).optional(),
    enum: z.array(scalar).min(1).optional(),
    min: z.union([z.number(), z.string()]).optional(),
    max: z.union([z.number(), z.string()]).optional(),
    /** Foreign key, "table.column". */
    ref: z.string().regex(/^[^.\s]+\.[^.\s]+$/, 'expected "table.column"').optional(),
    /** How child rows pick parents when `ref` is set. */
    distribution: z.enum(["uniform", "zipf"]).optional(),
    /**
     * Cross-column rule: this value must be >= another date column.
     * "col" is a column in the same row; "fkCol.col" is a column on the
     * parent row reached through the foreign key column `fkCol`.
     */
    after: z.string().optional(),
    /** Faker path such as "person.fullName" for string columns. */
    faker: z.string().optional(),
    /** Regex the string must match, e.g. "[A-Z]{3}-[0-9]{4}". */
    pattern: z.string().optional(),
    /**
     * Foreign keys only: cap on children per parent. `unique: true` on a
     * foreign key means one-to-one (cap of 1).
     */
    maxPerParent: z.number().int().positive().optional(),
  })
  .strict();

export const TableSchema = z
  .object({
    rows: z.number().int().nonnegative(),
    columns: z.record(ColumnSchema),
  })
  .strict();

export const DataSchema = z
  .object({
    seed: z.number().int().optional(),
    tables: z.record(TableSchema),
  })
  .strict();

export type Column = z.infer<typeof ColumnSchema>;
export type Table = z.infer<typeof TableSchema>;
export type DataSchemaT = z.infer<typeof DataSchema>;

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

/** Parse and cross-validate a schema (references, rules), throwing SchemaError. */
export function parseSchema(input: unknown): DataSchemaT {
  const result = DataSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new SchemaError(`Invalid schema: ${issues}`);
  }
  const schema = result.data;

  for (const [tname, table] of Object.entries(schema.tables)) {
    for (const [cname, col] of Object.entries(table.columns)) {
      const where = `${tname}.${cname}`;
      if (col.pattern !== undefined) {
        if (col.type !== "string") throw new SchemaError(`${where}: "pattern" only applies to string columns`);
        try {
          new RegExp(col.pattern);
        } catch {
          throw new SchemaError(`${where}: invalid pattern "${col.pattern}"`);
        }
      }
      if (col.maxPerParent !== undefined && !col.ref) {
        throw new SchemaError(`${where}: "maxPerParent" only applies to foreign keys`);
      }
      if (col.ref) {
        const [pt, pc] = col.ref.split(".") as [string, string];
        const parent = schema.tables[pt];
        if (!parent) throw new SchemaError(`${where}: ref to unknown table "${pt}"`);
        const pcol = parent.columns[pc];
        if (!pcol) throw new SchemaError(`${where}: ref to unknown column "${col.ref}"`);
        if (!pcol.primaryKey && !pcol.unique) {
          throw new SchemaError(`${where}: ref target "${col.ref}" must be primaryKey or unique`);
        }
        if (pcol.type !== col.type) {
          throw new SchemaError(`${where}: type "${col.type}" differs from ref target type "${pcol.type}"`);
        }
      }
      if (col.after) {
        if (col.type !== "date" && col.type !== "datetime") {
          throw new SchemaError(`${where}: "after" only applies to date/datetime columns`);
        }
        const parts = col.after.split(".");
        if (parts.length === 1) {
          if (!table.columns[parts[0]!]) throw new SchemaError(`${where}: after unknown column "${col.after}"`);
        } else if (parts.length === 2) {
          const fk = table.columns[parts[0]!];
          if (!fk?.ref) throw new SchemaError(`${where}: after "${col.after}" needs "${parts[0]}" to be a foreign key`);
          const [pt] = fk.ref.split(".") as [string];
          if (!schema.tables[pt]!.columns[parts[1]!]) {
            throw new SchemaError(`${where}: after unknown parent column "${col.after}"`);
          }
        } else {
          throw new SchemaError(`${where}: invalid after "${col.after}"`);
        }
      }
    }
  }
  return schema;
}
