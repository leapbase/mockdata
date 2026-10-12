# Direct Database Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dry-run-first `mockdata seed` command that inserts generated rows into an empty SQLite, PostgreSQL, or MySQL/MariaDB database only with `--apply`.

**Architecture:** Keep seeding in `@mockdata/cli`, which already owns schema loading and generation. Use raw catalog introspection from `@mockdata/inputs` for a shared preflight, then a small adapter per database for parameterized inserts and transactions. No web or MCP write path is added.

**Tech Stack:** TypeScript, Node 22.13+, Zod schema in `@mockdata/core`, `node:sqlite`, `pg`, `mysql2`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-database-seeding-design.md`

## Global Constraints

- CLI syntax: `mockdata seed <schema> --target <env:NAME|sqlite:path|*.db> [--seed n] [--pg-schema name] [--apply]`.
- Preview is the default and performs no writes; `--apply` is the sole write switch.
- Network database URLs come only from an environment variable or `.env`, never a raw command argument.
- Target tables must be empty; no truncation, update, deletion, disabled foreign keys, or credential output.
- Use exact table/column names and parameterized values. Reject deferred table cycles, unsupported types/composite constraints, and foreign keys outside the generated schema.
- Generate before opening a write transaction. Recheck catalog and emptiness inside the transaction; report committed counts only after commit.
- LLM columns may incur provider calls in preview and are regenerated on a later apply.

## File Map

- `packages/cli/src/seed/preflight.ts`: compare schema with raw catalog, compute insertion order and exact identifiers.
- `packages/cli/src/seed/session.ts`: common `SeedSession` interface and target selection, quoting, and safe error formatting.
- `packages/cli/src/seed/sqlite.ts`, `postgres.ts`, `mysql.ts`: dialect connections, catalog/empty queries, transactions, parameterized row insertion.
- `packages/cli/src/seed/command.ts`: CLI argument parsing, preview/apply orchestration and reports.
- `packages/cli/src/cli.ts`, `packages/cli/package.json`: command dispatch and direct driver dependencies.
- `packages/cli/test/seed-*.test.ts`: preflight, adapters, and CLI behavior with temporary SQLite plus narrow dialect fakes.
- `README.md`, `packages/web/src/docs/content.ts` and its `i18n` dictionaries: user-facing command contract and limitations.

## Review Focus

- Raw PostgreSQL/MySQL URL as `--target`: reject before connecting or echoing its password (Task 4).
- Sanitized name from `infer` that differs from the catalog: fail preflight instead of inserting into a similarly named table (Task 1).
- Existing rows or another insert failure: reject or roll back without a partial dataset (Tasks 2 and 4).
- A foreign-key cycle requiring a deferred link: reject before opening a write transaction (Task 1).
- MySQL nontransactional table: reject before `--apply` because rollback would be incomplete (Task 3).

---

### Task 1: Preflight plan from a schema and catalog

**Files:** Create `packages/cli/src/seed/preflight.ts`; test `packages/cli/test/seed-preflight.test.ts`.

**Interfaces:** `prepareSeedPlan(schema: DataSchemaT, catalog: RawTable[], kind: DbKind): SeedPlan`; `SeedPlan = { tables: { name: string; columns: string[]; rows: number }[] }` in insertion order. Export `SeedPreflightError` for caller-safe messages.

- [ ] **Step 1: Write failing tests.** Use a two-table hand-built catalog and schema. Assert parents precede children; exact names and columns pass; a renamed column, unsupported mapped type, composite key, external FK, or deferred cycle throws before returning a plan. Assert PostgreSQL `email` maps to a text column and other schema types match `mapDbType`.
- [ ] **Step 2: Run `npx vitest run packages/cli/test/seed-preflight.test.ts`.** Expected: fail because `prepareSeedPlan` does not exist.
- [ ] **Step 3: Implement `prepareSeedPlan`.** Use `parseSchema`/`planGeneration`, raw `RawTable` metadata, and `mapDbType`; reject type/PK/unique/FK/nullability mismatches and any catalog feature the seeder cannot represent. Preserve raw catalog identifiers in the plan.
- [ ] **Step 4: Rerun the focused test.** Expected: pass.
- [ ] **Step 5: Commit the preflight module and tests.**

### Task 2: SQLite session and atomic writes

**Files:** Create `packages/cli/src/seed/session.ts`, `packages/cli/src/seed/sqlite.ts`; test `packages/cli/test/seed-sqlite.test.ts`.

**Interfaces:** `SeedSession = { kind: DbKind; catalog(): Promise<RawTable[]>; hasRows(table: string): Promise<boolean>; begin(): Promise<void>; insert(table: string, columns: string[], row: Row): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; close(): Promise<void> }`. `openSqliteSeedSession(path: string, mode: "preview" | "apply"): Promise<SeedSession>`.

- [ ] **Step 1: Write failing tests.** A temporary SQLite database with customers/orders proves preview cannot write, empty-table checks, parent-first inserts, foreign key enforcement, and rollback after a second insert fails. Include quoted identifiers and a self reference to an earlier row.
- [ ] **Step 2: Run `npx vitest run packages/cli/test/seed-sqlite.test.ts`.** Expected: fail because the session constructor does not exist.
- [ ] **Step 3: Implement `SeedSession` and SQLite adapter.** Open preview with `readOnly: true`, apply with an existing-file check; enable `PRAGMA foreign_keys=ON`, use `BEGIN IMMEDIATE`, `COMMIT`/`ROLLBACK`, `introspectSqlite`, quoted identifiers, and prepared statements with bound values.
- [ ] **Step 4: Rerun the focused test.** Expected: pass.
- [ ] **Step 5: Commit the SQLite adapter and tests.**

### Task 3: PostgreSQL and MySQL sessions

**Files:** Create `packages/cli/src/seed/postgres.ts`, `packages/cli/src/seed/mysql.ts`; modify `packages/cli/src/seed/session.ts`, `packages/cli/package.json`; test `packages/cli/test/seed-dialects.test.ts`.

**Interfaces:** `openPostgresSeedSession(url: string, mode: "preview" | "apply", pgSchema: string): Promise<SeedSession>`; `openMysqlSeedSession(url: string, mode: "preview" | "apply"): Promise<SeedSession>`; `openSeedSession(target: string, mode: "preview" | "apply", pgSchema?: string): Promise<SeedSession>` selects a dialect.

- [ ] **Step 1: Write failing tests.** Inject small connection/query fakes at the adapter boundary. Assert PostgreSQL `"schema"."table"` with `$1...` parameters, MySQL backtick quoting with `?` parameters, begin/commit/rollback calls, read-only preview, credential-safe errors, and rejection of a MySQL table whose engine is not InnoDB. Add optional live tests gated by dedicated test DB URLs.
- [ ] **Step 2: Run `npx vitest run packages/cli/test/seed-dialects.test.ts`.** Expected: fail because the constructors do not exist.
- [ ] **Step 3: Implement both adapters.** Reuse `introspectPostgres`/`introspectMysql`, open connections lazily, set read-only transactions for preview, use explicit write transactions for apply, and bound row values. Query `information_schema.tables` for MySQL engines. Add direct `pg`, `mysql2`, and `@types/pg` dependencies as needed.
- [ ] **Step 4: Rerun the focused test and optional live tests when configured.** Expected: pass.
- [ ] **Step 5: Commit the adapters, dependency metadata, and tests.**

### Task 4: CLI seed command

**Files:** Create `packages/cli/src/seed/command.ts`; modify `packages/cli/src/cli.ts`; test `packages/cli/test/seed-command.test.ts`.

**Interfaces:** `runSeed(args: string[], io: IO): Promise<number>`; consumes `prepareSeedPlan`, `openSeedSession`, `loadSchemaFile`, `loadEnv`, and `generateWithLlm`.

- [ ] **Step 1: Write failing tests.** Via `run`, assert default preview reports kind/order/counts but leaves the temporary SQLite file unchanged; `--apply` inserts all rows; nonempty and mismatched targets return nonzero with no writes; bad arguments and raw network URLs fail before connection; error text never contains a password; seed override reaches generation; an LLM preview reports usage without a database write.
- [ ] **Step 2: Run `npx vitest run packages/cli/test/seed-command.test.ts`.** Expected: fail because `seed` is unknown.
- [ ] **Step 3: Implement `runSeed` and dispatch.** Parse flags, resolve only approved target forms, preflight before LLM calls, generate/validate, close preview session, then for `--apply` open a write session and recheck inside its transaction. Insert row by row in plan order; commit before success text. Roll back on any failure and close all sessions in `finally`.
- [ ] **Step 4: Rerun the focused test.** Expected: pass.
- [ ] **Step 5: Commit command, dispatch, and tests.**

### Task 5: Documentation and final verification

**Files:** Modify `README.md`, `packages/web/src/docs/content.ts`, `packages/web/src/docs/i18n/es.ts`, `packages/web/src/docs/i18n/zh.ts`; test existing documentation/i18n suites.

**Interfaces:** CLI help and docs state exact syntax, preview default, `--apply`, empty-table requirement, no overwrite, target restrictions, rollback, and LLM dry-run cost/re-run behavior.

- [ ] **Step 1: Update docs and translated strings.** Add short examples for SQLite and `env:TEST_DATABASE_URL`; explain that preview reports a plan, not the exact model-written text later applied.
- [ ] **Step 2: Run `npm run build` and `npm test` on Node 24.** Expected: zero failures; if the ignored empty `examples/test schema.yaml` exists, move it aside only during the test and restore it afterward. Local HTTP suites need permission to bind localhost in this environment.
- [ ] **Step 3: Review `git diff --check`, repository status, and the spec against the implementation.** Expected: only planned files changed and all spec requirements covered.
- [ ] **Step 4: Commit docs and any final focused corrections.** Do not push until requested.
