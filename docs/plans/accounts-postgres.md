# Accounts mode: SQLite or Postgres?

## Context

The question: should accounts mode (mockdata.com) move from SQLite (`node:sqlite`, one `<dataDir>/accounts.db` file) to Postgres? The two reasons given are best practice and wanting to run several servers.

What the code shows:

- **SQLite is not the bottleneck.** Load tests measured about 2,300 page loads a second with a session. Sign-ins top out at about 28 a second, because password hashing is deliberately slow (`CLAUDE.md`, `apps/loadtest`).
- **For one server, SQLite is a sound choice.** WAL mode, `busy_timeout`, `synchronous=normal` and owner-only file permissions are already set (`packages/accounts/src/db.ts:112`).
- **The weak spot is backups, not the engine.** The README only says "back it up". Copying a live WAL database file can produce a corrupt copy.
- **Several servers needs much more than Postgres.** All of these tie accounts mode to one process today:
  - **In memory:** 15 rate limiters (`ratelimit.ts`), the concurrent-run gate `RunGate` (`quota.ts:132`), the hashing and mail queues, and live MCP sessions (`McpSessions`).
  - **On local disk:** every user's files (`<dataDir>/users/<dirId>`, `runtime.ts:145`).
  - **Behind a single-connection lock:** two check-then-write steps are only safe because of the `gated` lock. They are `UsageStore.reserveLlmRows` (`quota.ts:76`) and the 10-key cap in `ApiKeyStore.create` (`apikeys.ts:55`).

**Answer:** don't switch now just as best practice. If you want several servers, Postgres is one of four pieces of work. In order:

1. Safe SQLite backups (now).
2. A database layer that can use either engine.
3. Shared rate limits and run slots.
4. Shared files and sticky routing for MCP sessions.

Each step ships on its own, and a single SQLite server keeps working throughout.

## Step 1: safe backups for the single server (small, do now)

- Add `mockdata-ui backup <file>` (`packages/server/src/bin.ts`). It runs `VACUUM INTO '<file>'` through `AccountsDb`, which gives a consistent copy of a live WAL database.
- Rewrite the README's accounts section on backups:
  - Use the backup command, or Litestream for continuous copies.
  - Never copy `accounts.db` alone; its `-wal` and `-shm` files belong with it.
  - Back up `users/` with any file-level tool.
  - Test a restore.
- Test: back up a database while it is being written to, open the copy, check the user count and schema version.

## Step 2: either engine behind one interface (medium)

- **New `Sql` interface** in `packages/accounts/src/sql.ts`: `query(sql, params)`, `one`, `run`, and `transaction(fn)`. There are two implementations:
  - `SqliteSql` wraps the current `AccountsDb` and keeps the `gated` lock.
  - `PgSql` uses a `pg` connection pool. `pg` is already a runtime dependency of `packages/inputs`, so add it to `packages/accounts` the same way, loaded only when needed.
  - Placeholders are written as `?` and converted to `$1, $2…` for Postgres.
- **Port the stores to `Sql`:** `SqliteAuthAdapter` (rename it `SqlAuthAdapter`), `SessionStore`, `OAuthStates`, `ApiKeyStore` and `UsageStore`. Keep their public methods, so the server code doesn't change. Fixes the port requires:
  - **Duplicate-key errors:** detect them by SQLite code 2067 or Postgres code 23505.
  - **`has_password`:** compare it as a boolean (`!!`), not `=== 1`.
  - **Counts and sums:** convert the bigint values Postgres returns with `Number()`.
  - **`begin immediate`:** becomes `transaction()`.
- **Fix the two check-then-write steps so they hold under concurrency:**
  - **`reserveLlmRows`:** one conditional `INSERT … ON CONFLICT … DO UPDATE … WHERE` that checks both limits, plus a guarded update of a server-wide total row, inside one transaction. On Postgres that transaction takes an advisory lock (`pg_advisory_xact_lock`).
  - **`ApiKeyStore.create`:** an insert that only happens when the user has fewer than 10 keys.
- **Schema:** one set of DDL that works on both engines (`id` columns differ: `integer primary key` versus `bigint generated always as identity`). Schema versions go in a `schema_migrations` table instead of `pragma user_version`. Existing SQLite files are upgraded in place.
- **Choosing the engine:** `MOCKDATA_ACCOUNTS_DB=postgres://…` (environment or `.env`). Without it, SQLite under the data directory is used. Never echo the URL; redact passwords in errors, reusing the existing redaction in `packages/inputs/src/db/index.ts`.
- **Tests:** run the accounts tests against both engines. `@electric-sql/pglite` (already a dev dependency) gives a real in-process Postgres. Add a test where 20 concurrent `reserveLlmRows` calls never exceed the limit, and one where 20 concurrent key creations stop at 10.

## Step 3: shared state for several servers (medium; only once Step 2 runs on Postgres)

- **Rate limits** (`packages/accounts/src/ratelimit.ts`): add a `RateLimiter` that stores fixed-window counters in a `rate_limits(key, window_start, count)` table with an atomic upsert. Keep the in-memory version for SQLite and single-server use, and pick by engine in `runtime.ts:123`. Clean up old windows in the existing hourly sweep.
- **Run slots** (`RunGate`, `quota.ts:132`): store leases in a `run_slots(user_id, server_id, expires_at)` table. A slot is taken by an insert, which only succeeds if this user holds no slot and fewer than `maxRuns` slots exist. The lease is renewed while the run lasts and released when it ends. A server that crashes loses its slots when they expire.
- **Leave per server, on purpose:** the hashing queue (about 28 sign-ins a second per server is fine) and the mail queue (already fire-and-forget). Document both.

## Step 4: files and routing for several servers (mostly configuration)

- **User files:** keep the filesystem code and mount `<dataDir>/users` on shared storage, such as NFS or EFS. Document that `accounts.db` must not live there when using Postgres. The disk-quota walk (`quota.ts:149`) works unchanged; it is slower on network storage, which is acceptable at 500 files per user. Moving files to object storage is out of scope.
- **MCP sessions** live in one server's memory. Route each session to the server that opened it, using the `Mcp-Session-Id` header (Caddy `lb_policy header Mcp-Session-Id`). Document a two-server Caddy example. A session that reaches the wrong server already gets a 404 and the client reconnects.
- **Docs:** README, CLAUDE.md and the docs "Accounts mode" page (English, Spanish and Chinese dictionaries) get a "Running several servers" section with the requirements: Postgres, shared `users/`, sticky MCP routing, and identical environment on every server.

## Critical files

- `packages/accounts/src/db.ts`, `sqliteAdapter.ts`, `sessions.ts`, `apikeys.ts`, `quota.ts`, `ratelimit.ts`, plus the new `sql.ts`
- `packages/server/src/accounts/runtime.ts` (choose the engine and limiter) and `packages/server/src/bin.ts` (the `backup` command)
- `packages/accounts/test/*`, `packages/server/test/helpers.ts` (`bootAccounts` gets an engine option)
- `README.md`, `CLAUDE.md`, `packages/web/src/docs/content.ts` plus `i18n/{es,zh}.ts`

## Verification

- **Tests:** `npm test` runs the accounts and server suites on SQLite and on PGlite. The new concurrency tests must pass on both.
- **Load test:** `npm run loadtest` against SQLite and against a real Postgres 16. Expect page loads no lower than about 2,300 a second, and sign-ins still about 28 a second per server.
- **Two servers by hand:**
  - Run two `mockdata-ui` instances on one Postgres, with a shared `users/` folder, behind Caddy.
  - Sign in on one, then use the other.
  - Hit a rate limit across both and confirm the count is shared.
  - Start runs on both and confirm `MOCKDATA_MAX_RUNS` is enforced across them.
  - Connect an MCP client through Caddy and confirm its session stays on one server.
- **Backups:** run `mockdata-ui backup` during the load test, then open the copy successfully.

## Status (implemented on branch `accounts-postgres`)

- Step 1: `mockdata-ui --backup <file>` (VACUUM INTO over a read-only connection) and backup/restore docs.
- Step 2: `AccountsDb` over `sql.ts` engines (SQLite, Postgres via `pg`); `MOCKDATA_ACCOUNTS_DB`; budget and key-cap checks under `tx.lock`; store tests on both engines; live concurrency tests (`MOCKDATA_TEST_POSTGRES_URL`) fail without the locks and pass with them; `MOCKDATA_*` names are never inference sources.
- Step 3: shared `SqlRateLimiter` (hashed keys) and `SqlRunSlots` (leases) on Postgres, schema version 3; every limiter call awaited, enforced by `limiter-await.test.ts`.
- Step 4: "Running several servers" in the README and docs (3 languages). Verified with two real servers on one Postgres and one data folder: a session from A works on B, files saved via A list on B, failed sign-ins alternated across A and B hit the shared limit at attempt 11, and an MCP session from A gets 404 on B (hence routing by `Mcp-Session-Id`).
- Load test: about 2,500 (SQLite) vs 2,360 (Postgres) page loads/s with a session; sign-ins 32/s on both.
- Not verified live: the Caddy `lb_policy header Mcp-Session-Id` config (no proxy installed here) and shared storage over a real network file system.
