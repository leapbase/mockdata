# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`mockdata` is a hybrid synthetic data generator (TypeScript/Node, React UI planned), modelled on `~/git/syda` but fixing its gaps. Deterministic generators handle structure, keys, numbers and dates; an LLM is meant to fill only semantic free-text columns. The approved plan is at `~/.claude/plans/i-want-to-create-woolly-sunrise.md` (planned packages: llm, inputs, cli, mcp, server, web).

Implemented so far: `packages/core`, `packages/llm`, `packages/inputs`, `packages/cli`, `packages/mcp`. The server/web UI from the plan is still to build.

`packages/cli/src/cli.ts` exports async `run(argv, io)`, which resolves to an exit code and never calls `process.exit`, so tests call it directly (`io.llm` injects a fake provider). `bin.ts` is a thin wrapper. Commands: `generate <schema> [-o dir] [-f json|ndjson|csv] [-s seed]`, `validate <schema>`, and `infer <source>` (see Input loaders). Without `-o` generate prints JSON to stdout; csv/ndjson need `-o`.

## Commands

npm workspaces (pnpm is not installed).

```
npm install
npm test                                   # vitest, whole repo
npx vitest run packages/core/test/generate.test.ts -t "orphan"   # single file / test name
npm run build                              # tsc core then cli (cli imports core's dist; typecheck is an alias)
node packages/cli/dist/bin.js generate examples/shop.yaml -o out -f csv
MOCKDATA_ROOT=$PWD node packages/mcp/dist/bin.js   # MCP server on stdio
```

Build order is core, llm, inputs, cli, mcp (each imports the earlier ones' `dist`). Each package sets its own `outDir` (a base-config `outDir` resolves relative to the repo root, not the package). Vitest aliases `@mockdata/core` to its source (`vitest.config.ts`), so tests need no build.

## Core architecture (`packages/core/src`)

- `schema.ts`: Zod schema plus `parseSchema`, which also cross-validates refs (target must exist, be primaryKey/unique, and have the same type) and `after` rules.
- `graph.ts`: `generationLevels` groups tables so parents come first and throws `CycleError` on FK cycles (never guesses an order). Self references are excluded there and handled per row. `columnOrder` sorts columns within a table by `after` dependencies.
- `generate.ts`: `generate(schema, {seed})` walks the levels, fills each row, then runs `validate`, which hard-fails on violations (enum, min/max, unique, null, orphan FK, `after`). Constraints are enforced by construction and re-checked, not left to a prompt.

Schema DSL points that are easy to miss:
- FK is `ref: "table.column"`, with optional `distribution: "zipf"`. A self reference only samples earlier rows, so it should be `nullable`.
- Cross-column rule is `after`: `"col"` for the same row, `"fkCol.parentCol"` to read through a foreign key to the parent row.
- Output is deterministic per `seed` via a seeded Faker instance.

- `pattern` is a regex, generated with `faker.helpers.fromRegExp` and re-checked anchored in `validate`.
- Cardinality lives on the FK column: `unique: true` means one-to-one, `maxPerParent: n` caps children per parent. `pickParent` probes forward from the sampled parent when one is full, so caps hold under zipf skew; it throws if total capacity is too small.
- Cycles: `planGeneration` (in `graph.ts`) defers a *nullable* FK that lies on the cycle. That column is left null on the first pass and filled by `fillDeferred` after all tables exist. With no nullable FK on the cycle it still throws `CycleError`. `after` rules that read through a deferred FK throw `GenerationError`.

## LLM layer (`packages/llm/src`)

Only columns marked `llm` (string type) go to a model; everything else stays deterministic.

**Provider settings come from `.env`** (git-ignored; `.env.example` lists the names). The CLI merges `./.env` under the real environment (real env wins) and passes it to `resolveLlmConfig` (`config.ts`), where the schema's optional top-level `llm: {provider, model, baseUrl, batchSize, maxRetries, apiKeyEnv}` block wins over the environment:
- provider <- `AI_PROVIDER` (anthropic | openai | ollama | openai-compatible); model <- `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `OLLAMA_MODEL` by provider (no default on purpose).
- `ollama` uses the OpenAI chat format at `OLLAMA_BASE_URL` (host only; `/v1` is appended; default localhost:11434), no key. Keys: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
- Errors name variables, never values. Never print or commit `.env`; to inspect it list variable names only.

- Core support: `generate(schema, {deferLlm: true})` leaves llm cells `undefined` (pending; `null` means intentionally null via `nullable`/`nullRate`) and skips validating them. Plain `generate()` throws on llm columns so they are never silently empty.
- `generateWithLlm` (`fill.ts`) = deferred generate, `fillLlmColumns`, then full `validate`. Columns fill one at a time, parent tables before child tables (via `planGeneration` levels, then schema order), in batches (default 20 rows). Replies must be a JSON array of exactly N strings; bad replies, 429s and 5xx are retried with backoff (default 3 retries), 4xx auth errors are not. `unique` columns re-ask for duplicates (max 3 rounds) with an "avoid" list.
- Parent-row context (`context.ts`, `createContextBuilder`): each row's prompt shows its own values plus, up to `llm.contextDepth` hops (default 1, max 2, 0 = off), the rows it references. A foreign key id is replaced by the parent's values under a name derived from the column (`product_id` -> `"product": {...}`; falls back to the column name on a clash), the parent's key and unexpanded ids are dropped, strings clip at 60 chars, parents show at most 6 columns. Parent rows are looked up live, so text the model wrote for a parent appears in its children's prompts. The prompt only carries the "nested value = related row" sentence when the table has foreign keys and depth > 0.
- Truncation: output budget is `256 + 150 * rows` tokens (max 8192). A cut-off reply (provider `truncated` flag from `stop_reason`/`finish_reason`, or an unclosed `[` as fallback) is retried with the limit doubled rather than repeated; at the cap it fails with advice to lower `llm.batchSize`. (Found live: a 100-per-row budget cut off descriptive text and doubled cost through retries.)
- `provider.ts`: raw `fetch` to Anthropic Messages and OpenAI chat completions (ollama / openai-compatible = same wire format + base URL, key optional). Requests time out after 120s (retryable) so an unreachable host cannot hang the CLI.
- Tests use fake `fetch`/providers only (CLI tests use an empty temp cwd so a real `.env` never leaks in). A live run against Ollama has been verified manually; Anthropic/OpenAI request shapes are not yet verified live. LLM output is not reproducible by seed (only the deterministic columns are).
- Known limits: no cost estimate (tokens only), calls are sequential, parent context is repeated per row (no dedup of shared parents), and a child's other parents are not shown to a parent's own prompt (context only flows child <- parent).

## Input loaders (`packages/inputs/src`)

Build a schema from an existing source; every loader returns `{schema, warnings}` and ends in `finalize` (`common.ts`), which re-checks the result with `parseSchema` + `planGeneration` and turns any problem into a warning so the user still gets a file to fix. Warnings are part of the output contract: anything skipped, guessed or approximated must be reported.

- `jsonschema.ts` `fromJsonSchema`: JSON Schema, OpenAPI 3.x/Swagger 2, and Pydantic `model_json_schema()` output. Each object schema is a table; nested objects/arrays are skipped with a warning; optional properties become nullable; `<thing>_id` / `<thing>Id` links to a table named <thing> with a same-typed `id`. Explicit overrides: `x-mockdata-ref`, `x-rows`. Local `$ref` only.
- `sample.ts` `inferFromSamples` / `parseSample`: CSV (own RFC 4180 parser), JSON, NDJSON, or a folder of files. Infers types, ranges, null rates, small enums, faker hints by column name, foreign keys (name-based, subset-checked), zipf skew, one-to-one, and `after` date rules only when they hold in every row and there are at least 20 rows. Copies shape, never rows; enums do copy observed values of low-cardinality columns (`enums: false` / `--no-enums` disables).
- `db/`: `catalog.ts` (`RawTable` -> schema; `mapDbType`) plus one introspector per dialect: `sqlite.ts` (built-in `node:sqlite`, PRAGMAs, opened read-only), `postgres.ts` (`information_schema` + `pg_constraint`, in a `begin read only` transaction, default schema `public`), `mysql.ts` (`information_schema`, read-only session; URL must name the database). Each takes an injectable `query` function so tests need no server. Queries run sequentially (one connection, one query at a time). Only catalog metadata is read, never table rows. `db/index.ts` `inferFromDatabase` redacts passwords from every error.
- Not supported and reported as warnings: composite primary/unique/foreign keys, views, non-scalar types (mapped to string), self-referencing NOT NULL foreign keys (forced nullable).
- `source.ts` `inferFromSource` detects the kind from a URL/extension/directory; sample files over 100 MB are refused.
- Python models: Pydantic goes through `Model.model_json_schema()` -> `fromJsonSchema`. There is no SQLAlchemy helper script; create the tables in a SQLite file (`Base.metadata.create_all`) and infer from that.

Verified against real engines (Postgres 16 server, MySQL 9.3 server, SQLite) in throwaway instances; the automated suite uses SQLite files, `@electric-sql/pglite` (real Postgres, in-process) and canned MySQL rows. A live MySQL test runs when `MOCKDATA_TEST_MYSQL_URL` is set (it expects tables `mockdata_customers`/`mockdata_orders`). Connection strings should go in `.env` and be used as `mockdata infer env:VAR`, so they never appear on a command line.

## MCP server (`packages/mcp/src`)

`createServer({root, env, llm})` in `server.ts` (official `@modelcontextprotocol/sdk`, stdio via `bin.ts`; register with e.g. `claude mcp add mockdata -e MOCKDATA_ROOT=/some/dir -- node <repo>/packages/mcp/dist/bin.js`). Tools: `describe_schema_format` (text in `reference.ts`, keep it in sync with the schema DSL), `validate_schema`, `infer_schema` (path under root, inline content, or `connectionEnv`), `generate_data` (row counts + capped preview; optional `outputDir`/`format`/`overwrite`), `get_run_report` (last run, in memory). Reuses `loadEnv`/`parseSchemaText`/`serialize` from `@mockdata/cli`.

Tool inputs come from an agent, so file access is strict: `schemaPath` and `outputDir` must be relative and stay inside `root` (`resolveInside` also blocks symlink escapes), `schemaPath` must be .yaml/.yml/.json and never `.env*`, existing files are never overwritten without `overwrite: true`, and conflicts are checked before any LLM call. stdout is the protocol channel: never `console.log` in this package or anything it imports; use stderr.

`infer_schema` never accepts a connection string from the caller: `connectionEnv` names an env var/.env entry, the name must be upper-case and mention DATABASE/DB/POSTGRES/MYSQL/MARIADB/SQLITE (so it cannot be pointed at an API key), the value must be a supported database URL, and values are never echoed. `path` follows the same root confinement and `.env` rules as `schemaPath`.

Schema hardening that exists because schemas may be untrusted: table names must match `^[A-Za-z_][A-Za-z0-9_-]*$` (they become file names), and `faker:` must be `module.method` with no `constructor`/`prototype` segments and not `helpers.fake`/`mustache`/`fromRegExp`.

## Conventions

- Do not add a Co-Authored-By AI trailer to commit messages.
- Git config per README: `pull.rebase false`, `push.autoSetupRemote true`. `.remember/` is local session memory, not project code.
