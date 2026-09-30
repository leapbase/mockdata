# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`mockdata` is a hybrid synthetic data generator (TypeScript/Node, React UI planned), modelled on `~/git/syda` but fixing its gaps. Deterministic generators handle structure, keys, numbers and dates; an LLM is meant to fill only semantic free-text columns. The approved plan is at `~/.claude/plans/i-want-to-create-woolly-sunrise.md` (planned packages: llm, inputs, cli, mcp, server, web).

Implemented so far: `packages/core`, `packages/llm`, `packages/cli`. The MCP server, input loaders (OpenAPI, sample inference, DB reflection) and server/web UI from the plan are still to build.

`packages/cli/src/cli.ts` exports async `run(argv, io)`, which resolves to an exit code and never calls `process.exit`, so tests call it directly (`io.llm` injects a fake provider). `bin.ts` is a thin wrapper. Commands: `generate <schema> [-o dir] [-f json|ndjson|csv] [-s seed]` and `validate <schema>`. Without `-o` it prints JSON to stdout; csv/ndjson need `-o`.

## Commands

npm workspaces (pnpm is not installed).

```
npm install
npm test                                   # vitest, whole repo
npx vitest run packages/core/test/generate.test.ts -t "orphan"   # single file / test name
npm run build                              # tsc core then cli (cli imports core's dist; typecheck is an alias)
node packages/cli/dist/bin.js generate examples/shop.yaml -o out -f csv
```

Each package sets its own `outDir` (a base-config `outDir` resolves relative to the repo root, not the package). Vitest aliases `@mockdata/core` to its source (`vitest.config.ts`), so tests need no build.

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

Only columns marked `llm` (string type, needs a top-level `llm` config with provider/model) go to a model; everything else stays deterministic.

- Core support: `generate(schema, {deferLlm: true})` leaves llm cells `undefined` (pending; `null` means intentionally null via `nullable`/`nullRate`) and skips validating them. Plain `generate()` throws on llm columns so they are never silently empty.
- `generateWithLlm` (`fill.ts`) = deferred generate, `fillLlmColumns`, then full `validate`. Columns fill one at a time in schema order, in batches (default 20 rows), each row prompted with its other column values. Replies must be a JSON array of exactly N strings; bad replies, 429s and 5xx are retried with backoff (default 3 retries), 4xx auth errors are not. `unique` columns re-ask for duplicates (max 3 rounds) with an "avoid" list.
- `provider.ts`: raw `fetch` to Anthropic Messages and OpenAI chat completions (openai-compatible = same wire format + `baseUrl`, key optional). API keys come only from env vars (`apiKeyEnv`, defaults ANTHROPIC_API_KEY / OPENAI_API_KEY), never the schema. `model` has no default on purpose.
- Tests use fake `fetch`/providers only; nothing has been run against a live API. LLM output is not reproducible by seed (only the deterministic columns are).
- Known limits: no parent-row context in prompts yet, no cost estimate (tokens only), calls are sequential.

## Conventions

- Do not add a Co-Authored-By AI trailer to commit messages.
- Git config per README: `pull.rebase false`, `push.autoSetupRemote true`. `.remember/` is local session memory, not project code.
