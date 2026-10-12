import { parseArgs } from "node:util";
import { parseSchema } from "@mockdata/core";
import { detectDatabase } from "@mockdata/inputs";
import { generateWithLlm } from "@mockdata/llm";
import type { IO } from "../cli.js";
import { loadSchemaFile } from "../cli.js";
import { loadEnv } from "../env.js";
import { prepareSeedPlan, type SeedPlan } from "./preflight.js";
import { openSeedSession, safeSeedError, type SeedSession } from "./session.js";

export const SEED_HELP = `Usage: mockdata seed <schema.(yaml|yml|json)> --target <env:NAME|sqlite:path|file.db> [--seed n] [--pg-schema name] [--apply]

Preview is the default and never writes. --apply inserts into empty target tables in one transaction.
PostgreSQL/MySQL URLs must come from env:NAME (process environment or .env), never from a command argument.
LLM columns can incur provider costs in preview and are regenerated on a later --apply.
`;

function targetFromArg(argument: string, env: Record<string, string | undefined>): string {
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) {
    const name = argument.slice(4);
    const value = env[name];
    if (!value) throw new Error(`Missing connection variable ${name}`);
    if (!detectDatabase(value)) throw new Error(`Connection variable ${name} is not a supported database target`);
    return value;
  }
  const detected = detectDatabase(argument);
  if (detected?.kind === "sqlite" && (/^sqlite:/i.test(argument) || /\.(db|sqlite|sqlite3)$/i.test(argument))) return argument;
  throw new Error("Network database URLs must use --target env:NAME; SQLite needs sqlite:path or a .db/.sqlite file");
}

async function verifyEmpty(session: SeedSession, plan: SeedPlan): Promise<void> {
  for (const table of plan.tables) if (await session.hasRows(table.name)) throw new Error(`Target table "${table.name}" is not empty`);
}

export async function runSeed(args: string[], io: IO): Promise<number> {
  let target = "";
  try {
    const parsed = parseArgs({
      args, allowPositionals: true, tokens: true,
      options: {
        target: { type: "string" },
        seed: { type: "string", short: "s" },
        "pg-schema": { type: "string" },
        apply: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    const { values, positionals, tokens } = parsed;
    if (values.help && positionals.length === 0 && tokens?.length === 1) { io.out(SEED_HELP); return 0; }
    for (const name of ["target", "seed", "pg-schema", "apply", "help"]) {
      if ((tokens ?? []).filter((token) => token.kind === "option" && token.name === name).length > 1) throw new Error(`Repeated --${name} option`);
    }
    if (positionals.length !== 1 || !values.target || values.help) throw new Error(`Expected one schema file and --target\n\n${SEED_HELP}`);
    let seed: number | undefined;
    if (values.seed !== undefined) {
      seed = Number(values.seed);
      if (!Number.isInteger(seed)) throw new Error("--seed needs an integer");
    }
    const env = loadEnv(io.cwd ?? process.cwd(), io.llm?.env ?? process.env);
    target = targetFromArg(values.target, env);
    const detected = detectDatabase(target)!;
    if (values["pg-schema"] && detected.kind !== "postgres") throw new Error("--pg-schema applies only to PostgreSQL targets");
    const pgSchema = values["pg-schema"] ?? "public";
    const schema = parseSchema(loadSchemaFile(positionals[0]!));

    let preview: SeedSession | undefined;
    let plan: SeedPlan;
    try {
      preview = await openSeedSession(target, "preview", pgSchema);
      plan = prepareSeedPlan(schema, await preview.catalog(), preview.kind);
      await verifyEmpty(preview, plan);
      if (values.apply) await preview.ensureTransactional?.(plan.tables.map((table) => table.name));
    } finally { await preview?.close().catch(() => undefined); }

    const { data, report } = await generateWithLlm(schema, { seed, ...io.llm, env });
    const effectiveSeed = seed ?? schema.seed ?? 1;
    const detail = plan.tables.map((table) => `${table.name}: ${table.rows} rows`).join("\n");
    const llm = report.calls ? `\nLLM: ${report.calls} call${report.calls === 1 ? "" : "s"}, ${report.inputTokens} input / ${report.outputTokens} output tokens` : "";
    if (!values.apply) {
      io.out(`seed preview (${detected.kind}), seed ${effectiveSeed}\n${detail}${llm}\nNo rows written.\n`);
      return 0;
    }

    let writer: SeedSession | undefined;
    try {
      writer = await openSeedSession(target, "apply", pgSchema);
      await writer.ensureTransactional?.(plan.tables.map((table) => table.name));
      await writer.begin();
      const current = prepareSeedPlan(schema, await writer.catalog(), writer.kind);
      await verifyEmpty(writer, current);
      for (const table of current.tables) {
        for (const row of data[table.name] ?? []) await writer.insert(table.name, table.columns, row);
      }
      await writer.commit();
    } catch (error) {
      await writer?.rollback().catch(() => undefined);
      throw error;
    } finally { await writer?.close().catch(() => undefined); }
    io.out(`seed committed (${detected.kind}), seed ${effectiveSeed}\n${detail}${llm}\n`);
    return 0;
  } catch (error) {
    io.err(`${safeSeedError(error, target).message}\n`);
    return 1;
  }
}
