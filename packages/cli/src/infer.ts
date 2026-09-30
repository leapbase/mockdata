import { existsSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { Document, visit } from "yaml";
import { inferFromSource, type SourceKind } from "@mockdata/inputs";
import { loadEnv } from "./env.js";
import type { IO } from "./cli.js";

/** YAML text for a schema. Date-like strings are quoted: other YAML parsers would turn bare 2024-01-01 into a date object. */
function toYaml(schema: unknown): string {
  const doc = new Document(schema);
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && /^\d{4}-\d{2}-\d{2}/.test(node.value)) node.type = "QUOTE_DOUBLE";
    },
  });
  return doc.toString({ lineWidth: 0 });
}

export const INFER_HELP = `mockdata infer - build a schema from an existing source

Usage:
  mockdata infer <source> [options]

<source> is one of:
  postgres://... | mysql://... | mariadb://...   a live database (reads metadata only, read-only)
  env:VARIABLE                                   a database URL held in an environment variable or ./.env
                                                 (keeps passwords off the command line)
  sqlite:file | file.db | .sqlite | .sqlite3     a SQLite file
  api.yaml | api.json                            a JSON Schema or OpenAPI document (Pydantic model_json_schema() works)
  data.csv | .json | .ndjson                     sample rows
  directory                                      a folder of sample files, one table per file

Options:
  -o, --out <file>     write the schema here (.json for JSON, otherwise YAML); default: stdout
      --force          replace --out if it already exists
      --from <kind>    json-schema | sample | database (default: detect)
      --rows <n>       rows per table in the schema (default 100, or the sample size)
      --pg-schema <s>  Postgres schema to reflect (default public)
      --no-enums       do not copy observed values of low-cardinality columns into the schema
  -h, --help
`;

const KINDS = ["json-schema", "sample", "database"] as const;

/** `env:NAME` -> the value of NAME from the environment/.env; anything else is returned as-is. */
export function resolveSource(source: string, env: Record<string, string | undefined>): string {
  if (!source.startsWith("env:")) return source;
  const name = source.slice(4);
  const value = env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set (checked the environment and ./.env)`);
  return value;
}

export async function runInfer(args: string[], io: IO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        force: { type: "boolean" },
        from: { type: "string" },
        rows: { type: "string" },
        "pg-schema": { type: "string" },
        "no-enums": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${INFER_HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(INFER_HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    io.err(`Expected exactly one source\n\n${INFER_HELP}`);
    return 1;
  }
  if (values.from !== undefined && !(KINDS as readonly string[]).includes(values.from)) {
    io.err(`Invalid --from "${values.from}" (expected ${KINDS.join(", ")})\n`);
    return 1;
  }
  let rows: number | undefined;
  if (values.rows !== undefined) {
    rows = Number(values.rows);
    if (!Number.isInteger(rows) || rows < 0) {
      io.err(`Invalid --rows "${values.rows}" (expected a non-negative integer)\n`);
      return 1;
    }
  }
  if (values.out && existsSync(values.out) && !values.force) {
    io.err(`Refusing to overwrite ${values.out} (use --force)\n`);
    return 1;
  }

  try {
    const env = loadEnv(io.cwd ?? process.cwd(), io.llm?.env ?? process.env);
    const source = resolveSource(positionals[0]!, env);
    const { schema, warnings } = await inferFromSource(source, {
      kind: values.from as SourceKind | undefined,
      rows,
      schema: values["pg-schema"],
      enums: values["no-enums"] ? false : undefined,
    });
    for (const w of warnings) io.err(`warning: ${w}\n`);
    const text = values.out && extname(values.out).toLowerCase() === ".json" ? JSON.stringify(schema, null, 2) + "\n" : toYaml(schema);
    if (values.out) {
      writeFileSync(values.out, text);
      const n = Object.keys(schema.tables).length;
      io.err(`wrote ${values.out} (${n} table${n === 1 ? "" : "s"})\n`);
    } else {
      io.out(text);
    }
    return 0;
  } catch (e) {
    const err = e as Error;
    io.err(`${err.name === "Error" ? "" : err.name + ": "}${err.message}\n`);
    return 1;
  }
}
