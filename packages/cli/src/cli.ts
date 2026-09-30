import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { parseSchema, type Dataset, type Row } from "@mockdata/core";
import { generateWithLlm, type GenerateWithLlmOptions, type LlmReport } from "@mockdata/llm";
import { loadEnv } from "./env.js";
import { runInfer } from "./infer.js";

export { loadEnv };
export { toYaml } from "./infer.js";
export * from "./confined.js";
export * from "./network.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Overrides for the LLM layer (tests inject a fake provider). */
  llm?: Pick<GenerateWithLlmOptions, "provider" | "fetch" | "env" | "sleep">;
  /** Where to look for .env (default: process.cwd()). */
  cwd?: string;
}

const HELP = `mockdata - synthetic data generator

Usage:
  mockdata generate <schema.(yaml|yml|json)> [options]
  mockdata validate <schema.(yaml|yml|json)>
  mockdata infer <source> [options]        build a schema from a database, OpenAPI/JSON Schema, or sample data
                                           (run "mockdata infer --help")

generate options:
  -o, --out <dir>       write one file per table into <dir> (default: print JSON to stdout)
  -f, --format <fmt>    json | ndjson | csv (default: json)
  -s, --seed <n>        override the schema seed
  -h, --help            show this help
`;

const FORMATS = ["json", "ndjson", "csv"] as const;
type Format = (typeof FORMATS)[number];

/** Parse schema text. YAML is a superset of JSON, so one parser handles both. */
export function parseSchemaText(text: string): unknown {
  return parseYaml(text);
}

export function loadSchemaFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseSchemaText(text);
}

/** Spreadsheets run text that starts with one of these as a formula; numbers are left alone. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serialize(rows: Row[], columns: string[], format: Format): string {
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2) + "\n";
    case "ndjson":
      return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    case "csv":
      return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
  }
}

function describeUsage(r: LlmReport): string {
  const cols = Object.entries(r.columns).map(([c, n]) => `${c} (${n} rows)`).join(", ");
  return `llm: ${r.calls} call${r.calls === 1 ? "" : "s"}, ${r.inputTokens} input / ${r.outputTokens} output tokens; filled ${cols}\n`;
}

/** Returns a process exit code. Never calls process.exit, so it is testable. */
export async function run(argv: string[], io: IO): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    io.out(HELP);
    return command ? 0 : 1;
  }
  if (command === "infer") return runInfer(rest, io);
  if (command !== "generate" && command !== "validate") {
    io.err(`Unknown command "${command}"\n\n${HELP}`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        format: { type: "string", short: "f", default: "json" },
        seed: { type: "string", short: "s" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(HELP);
    return 0;
  }
  const file = positionals[0];
  if (!file || positionals.length > 1) {
    io.err(`Expected exactly one schema file\n\n${HELP}`);
    return 1;
  }

  try {
    const raw = loadSchemaFile(file);
    if (command === "validate") {
      const schema = parseSchema(raw);
      const n = Object.keys(schema.tables).length;
      io.out(`OK: ${n} table${n === 1 ? "" : "s"}\n`);
      return 0;
    }

    const format = values.format as Format;
    if (!FORMATS.includes(format)) {
      io.err(`Invalid --format "${values.format}" (expected ${FORMATS.join(", ")})\n`);
      return 1;
    }
    let seed: number | undefined;
    if (values.seed !== undefined) {
      seed = Number(values.seed);
      if (!Number.isInteger(seed)) {
        io.err(`Invalid --seed "${values.seed}" (expected an integer)\n`);
        return 1;
      }
    }

    const schema = parseSchema(raw);
    const { data, report } = await generateWithLlm(schema, {
      seed,
      ...io.llm,
      env: loadEnv(io.cwd ?? process.cwd(), io.llm?.env ?? process.env),
    });
    if (report.calls > 0) io.err(describeUsage(report));
    if (!values.out) {
      if (format !== "json") {
        io.err(`--format ${format} needs --out <dir> (one file per table)\n`);
        return 1;
      }
      io.out(JSON.stringify(data, null, 2) + "\n");
      return 0;
    }

    mkdirSync(values.out, { recursive: true });
    for (const [table, rows] of Object.entries(data)) {
      const columns = Object.keys(schema.tables[table]!.columns);
      writeFileSync(join(values.out, `${table}.${format}`), serialize(rows, columns, format));
      io.err(`wrote ${table}.${format} (${rows.length} rows)\n`);
    }
    return 0;
  } catch (e) {
    const err = e as Error;
    io.err(`${err.name === "Error" ? "" : err.name + ": "}${err.message}\n`);
    return 1;
  }
}
