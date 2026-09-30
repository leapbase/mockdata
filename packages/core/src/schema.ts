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
    /**
     * String columns only: fill with an LLM instead of a deterministic
     * generator. `true` uses the column name and row context; an object can
     * add an instruction. The provider comes from the top-level `llm` config
     * and/or the environment (AI_PROVIDER, ...).
     */
    llm: z.union([z.literal(true), z.object({ prompt: z.string().optional() }).strict()]).optional(),
  })
  .strict();

export const LLM_PROVIDERS = ["anthropic", "openai", "ollama", "openai-compatible"] as const;

/**
 * Non-secret LLM settings. Every field is optional here: whatever the schema
 * leaves out is filled from the environment / .env (see @mockdata/llm
 * resolveLlmConfig), which also enforces that provider and model end up set.
 * API keys are read from the environment, never from the schema.
 */
export const LlmConfigSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS).optional(),
    model: z.string().min(1).optional(),
    /** Required for openai-compatible; ollama defaults to OLLAMA_BASE_URL or localhost. */
    baseUrl: z.string().url().optional(),
    /** Env var holding the API key (defaults: ANTHROPIC_API_KEY / OPENAI_API_KEY). */
    apiKeyEnv: z.string().optional(),
    /** Rows per request (default 20). */
    batchSize: z.number().int().positive().max(200).optional(),
    /** Retries per request on rate limits, server errors, or unusable replies (default 3). */
    maxRetries: z.number().int().min(0).max(10).optional(),
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
    llm: LlmConfigSchema.optional(),
    /** Table names double as file names, so they are restricted to a safe alphabet. */
    tables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "table names may use letters, digits, _ and -"), TableSchema),
  })
  .strict();

export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type Column = z.infer<typeof ColumnSchema>;
export type Table = z.infer<typeof TableSchema>;
export type DataSchemaT = z.infer<typeof DataSchema>;

/** Faker methods that evaluate a template string; never callable from a schema. */
const FAKER_DENY = new Set(["helpers.fake", "helpers.mustache", "helpers.fromRegExp"]);
const FAKER_PATH = /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;
const FAKER_BAD_SEGMENTS = new Set(["constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]);

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
      if (col.llm) {
        if (col.type !== "string") throw new SchemaError(`${where}: "llm" only applies to string columns`);
        const clash = (["ref", "enum", "pattern", "faker", "after", "primaryKey"] as const).find((k) => col[k]);
        if (clash) throw new SchemaError(`${where}: "llm" cannot be combined with "${clash}"`);
      }
      if (col.faker !== undefined) {
        if (!FAKER_PATH.test(col.faker) || FAKER_DENY.has(col.faker) || col.faker.split(".").some((seg) => FAKER_BAD_SEGMENTS.has(seg))) {
          throw new SchemaError(`${where}: invalid faker path "${col.faker}" (expected "module.method", e.g. person.fullName)`);
        }
      }
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
