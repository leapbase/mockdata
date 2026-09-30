import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadEnv, parseSchemaText, serialize } from "@mockdata/cli";
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

/** Problems caused by the caller's input; reported as tool errors, not crashes. */
class UserError extends Error {}

interface RunSummary {
  at: string;
  seed: number;
  durationMs: number;
  rows: Record<string, number>;
  files?: string[];
  llm?: LlmReport;
}

const FORMATS = ["json", "ndjson", "csv"] as const;
const SCHEMA_EXT = new Set([".yaml", ".yml", ".json"]);

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

/**
 * Resolve a caller-supplied relative path inside `root`. Rejects absolute
 * paths, `..` escapes, and symlinks that lead outside the root.
 */
function resolveInside(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new UserError(`Path "${rel}" must be relative to the server root`);
  const rootReal = realpathSync(root);
  const target = path.resolve(rootReal, rel);
  const within = (p: string) => {
    const r = path.relative(rootReal, p);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  let probe = target;
  while (!existsSync(probe)) probe = path.dirname(probe);
  if (!within(target) || !within(realpathSync(probe))) throw new UserError(`Path "${rel}" is outside the server root`);
  return target;
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
    const ext = path.extname(args.schemaPath!).toLowerCase();
    if (!SCHEMA_EXT.has(ext) || path.basename(args.schemaPath!).startsWith(".env")) {
      throw new UserError(`schemaPath must be a .yaml, .yml or .json file (got "${args.schemaPath}")`);
    }
    const file = resolveInside(root, args.schemaPath!);
    if (!existsSync(file)) throw new UserError(`No such file: ${args.schemaPath}`);
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
          const clashes = targets.filter((t) => existsSync(t.file));
          if (clashes.length > 0 && !args.overwrite) {
            throw new UserError(
              `Refusing to overwrite existing files: ${clashes.map((t) => path.relative(root, t.file)).join(", ")} (pass overwrite: true to replace them)`,
            );
          }
        }

        const env = loadEnv(root, baseEnv);
        const { data, report } = await generateWithLlm(schema, { seed: args.seed, ...opts.llm, env });

        const files: string[] = [];
        if (outDir) {
          mkdirSync(outDir, { recursive: true });
          for (const { table, file } of targets) {
            writeFileSync(file, serialize(data[table]!, Object.keys(schema.tables[table]!.columns), args.format));
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
