import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNotEnv, assertNotSymlink, assertRowBudget, checkSchemaPath, inferConfined, loadEnv, parseSchemaText, resolveInside, serialize, UserError, writeFileConfined } from "@mockdata/cli";
import { llmColumns, parseSchema, type Dataset } from "@mockdata/core";
import { generateWithLlm, type GenerateWithLlmOptions, type LlmReport } from "@mockdata/llm";
import { SCHEMA_REFERENCE } from "./reference.js";

export interface ServerOptions {
  /** Directory schemaPath/outputDir are confined to, and where .env is read from. Default: cwd. */
  root?: string;
  /** Environment (default process.env); .env under root is merged beneath it. */
  env?: Record<string, string | undefined>;
  /** Test hooks for the LLM layer. */
  llm?: Pick<GenerateWithLlmOptions, "provider" | "fetch" | "sleep">;
}

interface RunSummary {
  at: string;
  seed: number;
  durationMs: number;
  rows: Record<string, number>;
  files?: string[];
  llm?: LlmReport;
}

const FORMATS = ["json", "ndjson", "csv"] as const;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });

/** Run a tool body, turning any thrown error into an MCP tool error. */
async function guarded(body: () => unknown | Promise<unknown>) {
  try {
    return text(await body());
  } catch (e) {
    const err = e as Error;
    return fail(err instanceof UserError ? err.message : `${err.name}: ${err.message}`);
  }
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const root = path.resolve(opts.root ?? process.cwd());
  const baseEnv = opts.env ?? process.env;
  let lastRun: RunSummary | undefined;

  const server = new McpServer({ name: "mockdata", version: "0.0.1" });

  const schemaInput = {
    schema: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe("The schema, either as an object or as YAML/JSON text. Provide this or schemaPath."),
    schemaPath: z
      .string()
      .optional()
      .describe("Path to a .yaml/.yml/.json schema file, relative to the server root. Provide this or schema."),
  };

  function loadRaw(args: { schema?: string | Record<string, unknown>; schemaPath?: string }): unknown {
    if ((args.schema === undefined) === (args.schemaPath === undefined)) {
      throw new UserError('Provide exactly one of "schema" or "schemaPath"');
    }
    if (args.schema !== undefined) return typeof args.schema === "string" ? parseSchemaText(args.schema) : args.schema;
    const ext = checkSchemaPath(args.schemaPath!);
    const file = resolveInside(root, args.schemaPath!);
    if (!existsSync(file)) throw new UserError(`No such file: ${args.schemaPath}`);
    assertNotEnv(file);
    const content = readFileSync(file, "utf8");
    return ext === ".json" ? JSON.parse(content) : parseSchemaText(content);
  }

  server.registerTool(
    "describe_schema_format",
    {
      title: "Describe schema format",
      description: "Reference for the mockdata schema format (column types, foreign keys, cross-column rules, LLM columns). Read this before writing a schema.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(() => SCHEMA_REFERENCE),
  );

  server.registerTool(
    "validate_schema",
    {
      title: "Validate a schema",
      description: "Check a schema (references, rules, LLM settings syntax) without generating anything. Returns a summary or the first problem found.",
      inputSchema: schemaInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guarded(() => {
        const schema = parseSchema(loadRaw(args));
        return {
          ok: true,
          tables: Object.fromEntries(Object.entries(schema.tables).map(([n, t]) => [n, { rows: t.rows, columns: Object.keys(t.columns) }])),
          llmColumns: llmColumns(schema).map((c) => `${c.table}.${c.column}`),
        };
      }),
  );

  server.registerTool(
    "infer_schema",
    {
      title: "Infer a schema",
      description:
        "Build a mockdata schema from an existing source instead of writing one by hand. Give exactly one of: " +
        "`path` (a file or folder under the server root: SQLite .db/.sqlite, JSON Schema/OpenAPI .json/.yaml, or sample .csv/.json/.ndjson files), " +
        "`content` (inline JSON Schema/OpenAPI or sample text; set `name` like orders.csv so the format is known), or " +
        "`connectionEnv` (NAME of an environment variable holding a postgres://, mysql:// or sqlite: URL, for example DATABASE_URL; " +
        "connection strings themselves are never accepted). Databases are reflected read-only, metadata only. " +
        "Returns the schema plus warnings about anything skipped or guessed; review them, then pass the schema to generate_data.",
      inputSchema: {
        path: z.string().optional().describe("File or folder relative to the server root."),
        content: z.string().optional().describe("Inline JSON Schema/OpenAPI document or sample rows (max 5 MB)."),
        name: z.string().optional().describe("With content: a file name such as orders.csv, used to pick the format and table name."),
        connectionEnv: z.string().optional().describe("Name of an environment variable (or .env entry) holding a database URL."),
        kind: z.enum(["json-schema", "sample", "database"]).optional().describe("Force the interpretation instead of detecting it."),
        rows: z.number().int().min(0).max(10_000_000).optional().describe("Rows per table in the resulting schema."),
        pgSchema: z.string().optional().describe("Postgres schema to reflect (default public)."),
        enums: z.boolean().default(true).describe("For sample data: copy observed values of low-cardinality columns into enum lists."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const result = await inferConfined(root, baseEnv, args);
        return { tables: Object.keys(result.schema.tables), warnings: result.warnings, schema: result.schema };
      }),
  );

  server.registerTool(
    "generate_data",
    {
      title: "Generate synthetic data",
      description:
        "Generate related synthetic tables (parents before children, valid foreign keys, cross-column rules). " +
        "Returns row counts and a small preview; set outputDir to write every row to files. " +
        "Columns marked `llm` send prompts (with that row's other values) to the configured AI provider.",
      inputSchema: {
        ...schemaInput,
        seed: z.number().int().optional().describe("Overrides the schema seed. Same seed gives the same deterministic columns."),
        previewRows: z.number().int().min(0).max(50).default(5).describe("Rows per table to include in the response."),
        outputDir: z.string().optional().describe("Directory (relative to the server root) to write one file per table into."),
        format: z.enum(FORMATS).default("json").describe("File format when outputDir is set."),
        overwrite: z.boolean().default(false).describe("Allow replacing files that already exist in outputDir."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const started = Date.now();
        const schema = parseSchema(loadRaw(args));

        // Decide where files go (and fail on conflicts) before spending any LLM calls.
        let outDir: string | undefined;
        let targets: { table: string; file: string }[] = [];
        if (args.outputDir !== undefined) {
          outDir = resolveInside(root, args.outputDir);
          targets = Object.keys(schema.tables).map((table) => ({ table, file: path.join(outDir!, `${table}.${args.format}`) }));
          for (const t of targets) assertNotSymlink(t.file);
          const clashes = targets.filter((t) => existsSync(t.file));
          if (clashes.length > 0 && !args.overwrite) {
            throw new UserError(
              `Refusing to overwrite existing files: ${clashes.map((t) => path.relative(root, t.file)).join(", ")} (pass overwrite: true to replace them)`,
            );
          }
        }

        assertRowBudget(schema);
        const env = loadEnv(root, baseEnv);
        const { data, report } = await generateWithLlm(schema, { seed: args.seed, ...opts.llm, env });

        const files: string[] = [];
        if (outDir) {
          for (const { table, file } of targets) {
            writeFileConfined(root, file, serialize(data[table]!, Object.keys(schema.tables[table]!.columns), args.format), { overwrite: args.overwrite });
            files.push(path.relative(root, file));
          }
        }

        const rows = Object.fromEntries(Object.entries(data).map(([t, r]) => [t, r.length]));
        lastRun = {
          at: new Date().toISOString(),
          seed: args.seed ?? schema.seed ?? 1,
          durationMs: Date.now() - started,
          rows,
          ...(files.length ? { files } : {}),
          ...(report.calls > 0 ? { llm: report } : {}),
        };
        return { ...lastRun, preview: preview(data, args.previewRows) };
      }),
  );

  server.registerTool(
    "get_run_report",
    {
      title: "Get last run report",
      description: "Summary of the most recent generate_data call in this server session: seed, row counts, files written, LLM calls and token usage.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(() => {
        if (!lastRun) throw new UserError("No generate_data run yet in this server session");
        return lastRun;
      }),
  );

  return server;
}

function preview(data: Dataset, n: number): Dataset {
  return Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.slice(0, n)]));
}
