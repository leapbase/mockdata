# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`mockdata` is a hybrid synthetic data generator (TypeScript/Node, React UI planned), modelled on `~/git/syda` but fixing its gaps. Deterministic generators handle structure, keys, numbers and dates; an LLM is meant to fill only semantic free-text columns. The approved plan is at `~/.claude/plans/i-want-to-create-woolly-sunrise.md` (planned packages: llm, inputs, cli, mcp, server, web).

Implemented so far: `packages/core` and `packages/cli`. Everything else in the plan is still to build.

`packages/cli/src/cli.ts` exports `run(argv, io)`, which returns an exit code and never calls `process.exit`, so tests call it directly. `bin.ts` is a thin wrapper. Commands: `generate <schema> [-o dir] [-f json|ndjson|csv] [-s seed]` and `validate <schema>`. Without `-o` it prints JSON to stdout; csv/ndjson need `-o`.

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

Not yet supported: any LLM generation, and non-core packages from the plan.

## Conventions

- Do not add a Co-Authored-By AI trailer to commit messages.
- Git config per README: `pull.rebase false`, `push.autoSetupRemote true`. `.remember/` is local session memory, not project code.
