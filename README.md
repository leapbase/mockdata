# mockdata

Generate realistic, **related** test data from a schema you write, or from a schema inferred from a database, an OpenAPI/JSON Schema file, or sample rows.

- Tables are generated parents-first, so every foreign key points at a real row.
- Numbers, dates, keys and enums come from deterministic, seedable generators. Cross-column rules hold ("a ship date is never before the order date"). Violations are hard errors.
- Free text (reviews, bios, notes) can optionally be written by an LLM, which sees each row's values and the rows it belongs to.
- Use it from the command line, from an AI agent (MCP server), or as a library.

Inspired by [syda](https://github.com/syda-ai/syda), with the constraints enforced by code rather than by prompting.

mockdata is open source ([AGPL-3.0-or-later](#license)) at https://github.com/leapbase/mockdata. A hosted copy at https://mockdata.com is free to use: sign in to use the web workspace and the [hosted MCP endpoint](#hosted-mcp-accounts-mode) without installing anything.

## Install

Needs Node 22.13 or newer (24 is what it is tested on). `infer` from SQLite uses Node's built-in `node:sqlite`.

```
npm install
npm run build
npx mockdata --help
```

## Quick start

```
npx mockdata generate examples/shop.yaml                      # JSON to stdout
npx mockdata generate examples/shop.yaml -o out -f csv        # one CSV per table
# CSV cells of text starting with = + - @ get a leading quote so spreadsheets do not run them as formulas
npx mockdata generate examples/shop.yaml -s 123               # same seed = same data
npx mockdata validate examples/shop.yaml                      # check a schema without generating
```

### Run the servers

Run `npm run build` first (and again after code changes). Needs Node 22.13 or newer. Both servers listen on 127.0.0.1 only unless you pass `--allow` (see "Opening it to your network") or turn on accounts (see "Accounts and going public").

| What | Command | Address |
|---|---|---|
| Web UI | `npm run ui -- <folder>` (`--port n` to change) | http://127.0.0.1:4747 (workspace at `/app`) |
| MCP server over HTTP | `MOCKDATA_ROOT=<folder> node packages/mcp/dist/bin.js --http` (`--port n`) | http://127.0.0.1:4748/mcp |
| MCP server over stdio | started by the client: `claude mcp add mockdata -e MOCKDATA_ROOT=<folder> -- node <repo>/packages/mcp/dist/bin.js` | (none) |

`<folder>` holds your schema files and `.env`; nothing outside it is read or written. `GET /healthz` on the web UI answers `{"ok":true}` for uptime monitors and reverse proxies (after the same host and token checks as everything else). Details: [Use it from an AI agent (MCP)](#use-it-from-an-ai-agent-mcp) and [Web UI](#web-ui).

`examples/shop.yaml`:

```yaml
seed: 42
tables:
  customers:
    rows: 20
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: string, faker: person.fullName }
      email: { type: email, unique: true }
      signup_date: { type: date, min: "2023-01-01", max: "2024-06-30" }
  orders:
    rows: 100
    columns:
      id: { type: integer, primaryKey: true }
      customer_id: { type: integer, ref: customers.id, distribution: zipf }
      placed_at: { type: date, after: customer_id.signup_date }   # never before the customer signed up
      shipped_at: { type: date, after: placed_at, nullable: true }
      status: { type: string, enum: [new, paid, shipped] }
      total: { type: float, min: 5, max: 500 }
```

## Example data

Everything in [`examples/`](examples) works as written (a test runs each one):

| File | What it shows |
|---|---|
| `shop.yaml` | Two related tables, a skewed foreign key, and date rules that reach across tables |
| `hr.yaml` | Regex patterns, a one-to-one link, a per-parent cap, a self reference, a table cycle, an `after` rule |
| `shop-llm.yaml` | The same shop with review text written by an LLM (needs a provider, see below) |
| `clinical-ehr.yaml` | A synthetic health record: date rules that reach from an encounter back to the patient, a one-to-one link, per-parent caps |
| `clinical-trial.yaml` | A synthetic multi-site trial: consent -> visit and onset -> resolution date chains, optional end dates, enrolment skewed to a few sites |
| `clinical-claims.yaml` | Synthetic insurance claims: service -> submission -> payment dates, an optional payment date, a cap on lines per claim |
| `clinical-rwd-omop.yaml` | Real-world data shaped like the OMOP Common Data Model: person, observation period, visits, conditions, drug exposures, one measurement table per kind with its own range and unit, death; event dates stay within days of their visit (`within`) |
| `clinical-sdtm.yaml` | Trial data laid out like CDISC SDTM (DM, EX, AE, DS, LB, VS) plus an ADaM-style ADSL, all dated from each subject's first dose (`after` + `within`), with string subject ids as foreign keys |
| `pharmacovigilance.yaml` | Post-marketing drug safety reports (E2B-style cases): first drug -> onset -> receipt -> follow-up date chains, caps per case, reports concentrated on a few products |
| `manufacturing-quality.yaml` | GMP manufacturing and quality: batches and their material lots, per-test QC results, stability studies, deviations with CAPAs (some still open), equipment calibration |
| `supply-chain.yaml` | Serialized track and trace: a pack moves manufacturer -> wholesaler -> pharmacy -> dispensing as one-to-one stages whose dates follow each other, plus suspect-product investigations |
| `samples/customers.csv`, `samples/orders.csv` | Sample rows (fake data) to try inferring a schema from |
| `petstore-openapi.yaml` | An OpenAPI document to infer a schema from |
| `make-sample-db.mjs` | Builds a small SQLite database (`node examples/make-sample-db.mjs`) to infer from |

The clinical schemas are synthetic: names, identifiers and codes (ICD-10, CPT, OMOP concept ids, drug names) are illustrative, never real patients.

Try inferring:

```
npx mockdata infer examples/samples                           # CSVs -> schema (finds the foreign key and date rules)
npx mockdata infer examples/petstore-openapi.yaml             # OpenAPI -> schema
node examples/make-sample-db.mjs && npx mockdata infer examples/sample.db
npx mockdata infer examples/samples -o my-schema.yaml && npx mockdata generate my-schema.yaml
```

## Schema reference

A schema is YAML or JSON: an optional `seed`, an optional `llm` block, and `tables`. Each table has `rows` and `columns`. Table names use letters, digits, `_` and `-`.

**Column types:** `integer`, `float`, `string`, `boolean`, `date`, `datetime`, `uuid`, `email`.

| Option | Meaning |
|---|---|
| `primaryKey: true` | Integer keys are numbered 1..rows |
| `unique: true` | Values never repeat. On a foreign key it means one-to-one |
| `nullable: true`, `nullRate: 0.2` | Some values are null (default rate 0.1) |
| `enum: [a, b]` | One of these values |
| `min`, `max` | Numbers, or ISO dates for `date`/`datetime` |
| `pattern: "[A-Z]{3}-[0-9]{4}"` | String matching this regex |
| `faker: person.fullName` | String from a faker `module.method` (no arguments) |
| `ref: table.column` | Foreign key. The target must be a primary key or unique column of the same type |
| `distribution: zipf` | A few parents get most of the children (default is uniform) |
| `maxPerParent: 3` | At most 3 children per parent |
| `after: other_col` | Date is on or after another column in the same row |
| `after: fk_col.parent_col` | Date is on or after a column of the parent row reached through `fk_col` |
| `within: 14` | With `after`: at most 14 days after that date (a bounded gap such as a hospital stay); an explicit `max` still applies |
| `llm: true` or `llm: {prompt: "..."}` | Text written by an LLM (string columns) |

**Relationships.** A self reference (`ref` to its own table) only points at earlier rows, so make it `nullable`. Tables that reference each other are only allowed when a nullable foreign key on the cycle can be filled afterwards (see `hr.yaml`); otherwise you get a clear error instead of a guessed order.

## Infer a schema from what you already have

```
mockdata infer <source> [-o schema.yaml] [--rows n] [--force] [--no-enums] [--from kind] [--pg-schema name]
```

| Source | Notes |
|---|---|
| `postgres://…`, `mysql://…`, `mariadb://…` | Live database. Reads structure only, in read-only mode, never table rows |
| `sqlite:file`, `*.db`, `*.sqlite`, `*.sqlite3` | SQLite file |
| `env:VARIABLE` | Take the database URL from an environment variable or `.env`, so the password never appears on the command line |
| `api.yaml`, `api.json` | JSON Schema or OpenAPI 3.x / Swagger 2 (each object schema becomes a table). Pydantic: use `Model.model_json_schema()` |
| `data.csv`, `.json`, `.ndjson` | Sample rows |
| a folder | Several sample files, one table each; foreign keys are found across them |

What is inferred, and what is not:

- **From a database:** types, primary keys, unique columns, nullability, enums, foreign keys. Composite keys, views and unusual types are reported as warnings and skipped or mapped to strings.
- **From OpenAPI/JSON Schema:** types, formats, enums, ranges, patterns, optional fields (become nullable). A property named `<thing>_id` links to the table `<thing>` when it has a same-typed `id`. Add `x-mockdata-ref: "Table.id"` to a property to be explicit, and `x-rows` on a schema to set its row count.
- **From samples:** types, ranges, null rates, small enums, foreign keys, skew, one-to-one links, name-based faker hints, and `after` date rules that hold in every one of at least 20 rows. Only the shape is copied. Rows and free-text values are not, but low-cardinality columns become `enum` lists of the observed values (`--no-enums` turns that off).
- **SQLAlchemy models:** create the tables in a SQLite file (`Base.metadata.create_all(engine)`) and infer from that.

Warnings are printed to stderr (the schema goes to stdout, so it can be piped). Always read them: they list everything that was skipped or guessed.

## LLM-written text

Mark a string column and give a provider:

```yaml
columns:
  body: { type: string, llm: { prompt: "A one or two sentence review whose tone matches the rating" } }
```

Only these columns go to a model. Each row's prompt includes that row's other values and, through foreign keys, the parent rows it belongs to, so a review can be written about the actual product. Parent tables are filled first, so children also see the text written for their parents. `llm.contextDepth` (0-2, default 1) controls how many foreign-key hops are shown.

Settings come from a `.env` file in the directory you run from (copy `.env.example`; `.env` is git-ignored). Real environment variables override it, and an `llm:` block in the schema overrides both.

| Variable | Meaning |
|---|---|
| `AI_PROVIDER` | `anthropic`, `openai`, `ollama` or `openai-compatible` |
| `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `OLLAMA_MODEL` | Model name for that provider (there is no default) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | API keys |
| `OLLAMA_BASE_URL` | Ollama host, e.g. `http://localhost:11434` (`/v1` is added) |
| `DATABASE_URL` | Optional: used as `mockdata infer env:DATABASE_URL` |

Because a schema can come from someone else, its `llm:` block cannot redirect your keys. `baseUrl` is only accepted for `ollama` and `openai-compatible` (not `anthropic`/`openai`, whose keys go only to the official API) and never for link-local/metadata addresses. A schema's `baseUrl` must also be localhost or a public host: private, internal and LAN addresses (`10.x`, `192.168.x`, `100.64.x`, `*.internal`, short names) are refused. To use an Ollama server on your network, put its address in `OLLAMA_BASE_URL` (environment or `.env`), which is trusted. Hostnames are checked by name, not by DNS lookup, so a public name that resolves to a private address is not caught. `apiKeyEnv` must be an upper-case name ending `_API_KEY` or `_API_TOKEN`, and `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` work only with their own provider. A key is sent only over https (or to localhost). Error messages show a remote body only for localhost and the official APIs.

```
cp .env.example .env        # fill in AI_PROVIDER and the matching model / key
npx mockdata generate examples/shop-llm.yaml
```

The run prints how many calls and tokens it used. LLM output is not reproducible from the seed (only the other columns are), and it costs tokens, so try a small `rows` first. Ollama is verified live; Anthropic and OpenAI follow their documented APIs but have only been tested against fakes.

## Use it from an AI agent (MCP)

The MCP server exposes the same abilities to agents: over stdio or local HTTP (below), or hosted by a site running in accounts mode, such as https://mockdata.com (see [Hosted MCP](#hosted-mcp-accounts-mode)):

| Tool | Does |
|---|---|
| `describe_schema_format` | Returns the schema reference so an agent can write valid schemas |
| `validate_schema` | Checks a schema |
| `infer_schema` | Builds a schema from a file/folder under the root, inline content, or a database URL held in an environment variable |
| `generate_data` | Returns row counts and a small preview; can write every row to files |
| `get_run_report` | Seed, row counts, files written, LLM calls and tokens for the last run |

`generate_data` and the web UI's Export refuse schemas that add up to more than 1,000,000 rows, since they build everything in memory for a caller you may not control. The CLI has no such limit. Inferring from a folder of samples skips symlinks and reports them as warnings. Both servers answer only requests addressed to localhost, and a browser page must be same-origin with the address it called. Idle MCP HTTP sessions close after 30 minutes.

Register it in `.mcp.json` (or with `claude mcp add`), using absolute paths:

```json
{
  "mcpServers": {
    "mockdata": {
      "command": "node",
      "args": ["/path/to/mockdata/packages/mcp/dist/bin.js"],
      "env": { "MOCKDATA_ROOT": "/path/to/a/working/folder" }
    }
  }
}
```

**Over HTTP** (for clients that connect to a URL instead of starting a process):

```
MOCKDATA_ROOT=/path/to/a/working/folder node packages/mcp/dist/bin.js --http [--port 4748]
claude mcp add --transport http mockdata http://127.0.0.1:4748/mcp
```

It serves MCP at `/mcp` on 127.0.0.1 only (unless you use `--allow`, below) and refuses requests whose `Host` or `Origin` is not localhost. There is no login: the tools read and write files and can spend LLM credits, so do not put it behind a public address or tunnel. Each client session gets its own server (so `get_run_report` is per client), up to 20 open sessions.

The agent can only read schemas and write output inside `MOCKDATA_ROOT`. It never reads `.env` files and never overwrites an existing file unless asked. It cannot supply a connection string: `infer_schema` only accepts the *name* of an environment variable that looks like database config (for example `DATABASE_URL`).

## Web UI

A local editor and preview, for people who prefer a browser to a terminal.

```
npm run build
npm run ui -- examples          # or: node packages/server/dist/bin.js <folder> [--port 4747]
```

Open http://127.0.0.1:4747 for the landing page (what mockdata does, examples, FAQ), http://127.0.0.1:4747/docs for the documentation (also at https://mockdata.com/docs; the landing page and docs are available in English, Español and 中文 from the language menu), or go straight to the workspace at http://127.0.0.1:4747/app. The folder you pass is the root: schema files are listed in the sidebar, `.env` is read from there, and nothing outside it is ever read or written.

- **Schemas**: select, create, and save schemas in the left sidebar. The top bar holds the theme switch (System, Light, Dark; remembered in this browser) and account actions, or shows Local workspace when accounts are disabled.
- **Editor / Diagram**: edit YAML or JSON with live validation, or switch to a read-only table and relationship diagram with pan, zoom, and fit controls. Errors appear inline and in the status strip, which also shows the generation order. Switching views preserves edits.
- **Generate data**: open the collapsible right panel for seed, row count, and generation controls. Generate shows the first 50 rows of every table; foreign key values link to the parent row. Collapsing preserves settings and results and keeps a run going. Cancel stops a run and retains the previous preview.
- **Fill LLM columns**: turn it on to run `llm` columns with progress and a Cancel button. It is only enabled when a provider is configured in `.env` (see LLM setup); the toggle shows which one. Cancelling discards the partial run.
- **Import**: use the left sidebar's Import tab to pick a file under the root, paste sample rows or a JSON Schema/OpenAPI document, or choose a database variable by name. The result opens as an unsaved draft with the warnings listed.
- **Export**: from the generation panel, write json/ndjson/csv files to a folder under the root (existing files are kept unless you tick Overwrite) or download a zip.

On smaller screens the generation panel opens over the schema; on phones the schema sidebar also becomes a drawer. Escape closes a drawer and returns focus to its opening button.

The server listens on 127.0.0.1 only (unless you use `--allow`, below) and rejects requests from other hosts or origins. Connection strings are never typed into the browser: keep them in `.env` and pick the variable name. For development run `npm run dev -w packages/web` (Vite on its own port, proxying `/api` to a running `mockdata-ui`).

## Opening it to your network

By default both servers answer on 127.0.0.1 only. To let other machines on a trusted network use them, say which ranges may connect:

```
npm run ui -- <folder> --allow 100.100.1.x
MOCKDATA_ROOT=<folder> node packages/mcp/dist/bin.js --http --allow 100.100.1.x
```

`--allow` takes a comma-separated list of `100.100.1.x` (a /24), CIDRs such as `192.168.0.0/16`, or single IPs. Only private ranges are accepted (10/8, 172.16/12, 192.168/16 and 100.64/10, which covers Tailscale), each at most a /16 wide; anything else is refused at startup. With `--allow` the server binds 0.0.0.0, drops connections from outside the list, requires a token (below), and accepts requests addressed to one of this machine's IP addresses or to an allowed IP (never a host name, which DNS could re-point). Localhost keeps working. `--host <address>` binds one address instead, and binding beyond loopback without `--allow` is refused. On start it prints the addresses to browse to.

Everyone outside this machine also needs a shared secret token. Set `MOCKDATA_TOKEN` (16 or more characters from `A-Z a-z 0-9 . _ ~ -`, in the environment or `.env`; `.env` is never served) or let the server generate one and print it at start. There is deliberately no `--token` flag, since command lines show up in process lists.

- **Browser:** open `http://<address>:4747/app?token=<token>` once. The server swaps it for an `HttpOnly`, `SameSite=Strict` cookie and redirects to a clean URL, so the token does not stay in the address bar or history.
- **Scripts and MCP clients:** send `Authorization: Bearer <token>`, for example `claude mcp add --transport http mockdata http://<address>:4748/mcp --header "Authorization: Bearer <token>"`. The MCP endpoint accepts the header only, never a cookie or query string.
- **Localhost** needs no token.

Traffic is plain http, so the token can be read by anyone who can see the network path. Use a network you trust, such as a Tailscale tailnet (already encrypted). Anyone holding the token can read and write schema files under the root, spend your LLM credits and use every MCP tool, so treat it like a password and keep sensitive files out of the root. Rotate it by changing `MOCKDATA_TOKEN` and restarting.

## Generation runs in worker threads

The web UI generates data (previews, runs with model-written columns, exports) in worker threads, so a big run no longer freezes the page, sign-ins or anyone else's requests. With 20,000 rows x 6 columns, a trivial request that waited up to 3.2 s behind ten concurrent generations on the main thread waits 2-5 ms with the pool, and preview throughput went from 4 to 11 requests a second (`npm run loadtest` measures this on your machine).

| Variable | Meaning |
|---|---|
| `MOCKDATA_WORKERS` | threads (default: up to 4, always leaving a core for the server); `0` generates on the main thread as before |
| `MOCKDATA_WORKER_QUEUE` | jobs allowed to wait for a free thread (16); more are refused with 503 "busy" |
| `MOCKDATA_JOB_TIMEOUT_SECS` | a job running longer is stopped and answered with 504 (120); the clock starts once the thread has loaded, not while it starts |
| `MOCKDATA_WORKER_HEAP_MB` | each thread's memory limit (2048), so one pathological schema cannot take the server down |

Threads start when first needed and are reused. A worker that crashes or overruns costs only that job and one replacement thread. Closing the browser tab cancels a queued job and stops a model run before its next request. The same seed gives byte-identical output with or without the pool. Worker threads run the compiled code, so `npm run build` is needed (as it already is for `npm run ui`). The CLI and the MCP server still generate on their own thread.

## Accounts and going public

For a site other people sign in to, set `MOCKDATA_PUBLIC_URL` and start the UI as usual. Accounts are an opt-in mode; without that variable nothing here applies.

| Mode | Turned on by | Who gets in |
|---|---|---|
| Local (default) | nothing | anyone on this machine; nothing is reachable from outside |
| Private network | `--allow ranges` | the listed private ranges, with a shared token |
| **Accounts** | `MOCKDATA_PUBLIC_URL` | everyone signs in, **including localhost**; no token, no allow list |

Localhost is not trusted in accounts mode because a reverse proxy that terminates https connects from localhost on behalf of the whole internet. To keep the no-login local workflow, run without `MOCKDATA_PUBLIC_URL`; to try accounts on your own machine, use `MOCKDATA_PUBLIC_URL=http://localhost:4747`.

**What you configure** (environment or `.env`; see `.env.example`):

| Variable | Meaning |
|---|---|
| `MOCKDATA_PUBLIC_URL` | `https://your-domain` (plain http is accepted only for localhost) |
| `MOCKDATA_DATA_DIR` or `--data-dir` | accounts database and every user's private folder (default `./mockdata-data`); back it up (see Backups below) |
| `MOCKDATA_ACCOUNTS_DB` | optional `postgres://` URL: keep the account database in Postgres instead of SQLite under the data folder. One server runs well on SQLite; Postgres is what lets several servers share accounts. The schema is created on first start. User files still live under `MOCKDATA_DATA_DIR/users` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | email for verification and password reset. **Resend:** `smtp.resend.com`, port `465`, secure `true`, user `resend`, password = your Resend API key; verify your sending domain in Resend first |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional Google sign-in; in Google Cloud add the redirect URI `<MOCKDATA_PUBLIC_URL>/api/auth/google/callback` |
| `MOCKDATA_TRUST_PROXY` | `1` or `0`. Rate limits need each visitor's address, which a reverse proxy on this machine supplies in `X-Forwarded-For` (the **last** entry is used, and only when the connection comes from localhost). Default: on for an `https` address, off for plain-http localhost. Set `0` if a CDN sits in front of your proxy, because the last entry would then be the CDN, not the visitor |
| `MOCKDATA_LLM_DAILY_ROWS`, `MOCKDATA_LLM_GLOBAL_DAILY_ROWS` | model-written rows per user per day (2000) and across all users per day (20000): the second is your overall spending ceiling |
| `MOCKDATA_MAX_ROWS`, `MOCKDATA_MAX_CELLS` | rows per run (200000) and rows x columns per run (500000, about one second of server time) |
| `MOCKDATA_USER_QUOTA_MB`, `MOCKDATA_USER_MAX_FILES`, `MOCKDATA_MAX_RUNS` | storage per user (50 MB), files per user (500), and runs at once across all users (4) |

It refuses to start unless people can sign up (email and/or Google) and the address is valid. The UI listens on 127.0.0.1; put a reverse proxy in front that provides https. With Caddy (certificates are automatic):

```
mockdata.example.com {
  reverse_proxy 127.0.0.1:4747
}
```

```
MOCKDATA_PUBLIC_URL=https://mockdata.example.com MOCKDATA_TRUST_PROXY=1 npm run ui -- /path/holding/.env
```

**Backups.** With `MOCKDATA_ACCOUNTS_DB` set, back the account database up with `pg_dump` or your provider's backups. Otherwise it is SQLite in WAL mode, so copying `accounts.db` on its own while the server runs can give you a broken copy (recent writes sit in `accounts.db-wal`). Use the built-in command, which is safe while the server is running and never changes the source:

```
npm run ui -- /path/holding/.env --backup /backups/accounts-$(date +%F).db    # or: node packages/server/dist/bin.js ... --backup <file>
```

It writes a consistent, owner-only copy and refuses to overwrite a file. Back up `<data-dir>/users/` (every user's files) with any file-level tool, and test a restore: stop the server, put the copy at `<data-dir>/accounts.db` (with no `-wal`/`-shm` files beside it) and start it again. For continuous copies, [Litestream](https://litestream.io) can stream `accounts.db` to object storage.

**How it behaves.** Sign-up needs a verified email (a link mailed to the address; Google accounts need Google to report the address as verified). Sessions are a random id in an `HttpOnly`, `SameSite=Lax` cookie (named `__Host-mockdata_session` and `Secure` over https, so a sibling subdomain cannot plant one), stored hashed on the server, sliding over 30 days and never longer than 90. Sign-up, sign-in and reset answer the same whether or not an address exists, and email is sent after the answer so a slow mail server does not show in response times. Confirming an address needs both proofs: the emailed link (the mailbox) **and** the password chosen at sign-up, typed on a confirm screen, so a stranger who signs up first with someone else's address cannot be handed that account when the real owner clicks. That owner recovers with "Forgot password?", which proves the mailbox, replaces the password and signs everyone else out. Signing up again with an address that is already registered changes nothing (not the password, not the sessions, not earlier links); an unverified one is mailed one more link, limited to five mails an hour per mailbox. Resetting or changing a password signs out the other sessions, and "Sign out everywhere" ends all of them. Emailed links keep their one-time token in the URL fragment, so it never reaches a proxy log, a Referer header or a mail scanner (verifying is a POST, not a link that does something when opened). Each user gets a private folder named by a random id; nobody can read or write outside their own, and the account database (kept private to the server's user) lives outside all of them.

**What users cannot do**, because the server's keys and databases are the operator's: infer a schema from a database variable, or choose a model, provider, address or key in a schema's `llm:` block (the operator's settings are used; batch size is at least 10, retries at most 2, context depth at most 1, and a column's instruction at most 500 characters). Schemas are limited to 50 tables, 100 columns per table and 64-character names, plus the row and cell limits above. Password hashing is the costly part of an anonymous request, so at most two run at once (a short queue, then a 503), every sign-in attempt is counted before it is hashed, and failed sign-ins are tracked per mailbox and address so a stranger cannot lock the owner out from elsewhere. Sign-ups, mail requests and Google starts are rate limited per visitor (an IPv6 visitor by its /64), and each signed-in user has a row, cell, storage, file, daily model-row and concurrent-run limit, at most 30 runs (generate, run, export, infer) and 120 schema checks a minute, and 5 password changes per 15 minutes. Every unauthenticated request that hashes a password, and every sign-in attempt, is counted before the hash runs.

**Known limits.** The same person signing in with email and with Google gets two separate accounts. Password hashing is bounded (two at once, a short queue), so a large distributed flood can still make sign-ins answer "busy" (503) for everyone until it stops; front the site with a CDN or firewall rate limit if you expect that. About 100 failed sign-ins a quarter-hour against one mailbox, spread over many addresses, will lock its owner out of password sign-in for a while (Forgot password still works). If the mail queue is full (a flood from many addresses) messages are dropped with a log line while the visitor is told to check their email. Model spend is charged per requested row up front (with the caps above), not per token, so the two daily row limits are the real ceiling; nothing stops someone making many accounts except those limits and the per-address sign-up limit (consider a verified-domain allowlist or a CAPTCHA if that matters to you). Empty folders are not counted against a user's limits. On SQLite, rate limits and run slots live in memory, so they reset on restart and assume a single server process; with `MOCKDATA_ACCOUNTS_DB` they live in Postgres (rate-limit keys stored only as hashes, run slots as leases that expire if a server dies) and are shared by every server. SMTP credentials and model keys sit in the operator's environment.

### Hosted MCP (accounts mode)

In accounts mode the web server also serves MCP (Streamable HTTP) at `<MOCKDATA_PUBLIC_URL>/mcp`, for example `https://mockdata.com/mcp`. Clients authenticate with a per-user **API key**: sign in, open the account menu, choose **API keys**, and create one. The key is shown once; only its SHA-256 is stored, and the list shows each key's name, first characters and when it was last used.

```
claude mcp add --transport http mockdata https://mockdata.com/mcp --header "Authorization: Bearer <your API key>"
```

- The key goes in the `Authorization` header only. The session cookie is not accepted at `/mcp`, so a web page cannot use a signed-in browser to call it.
- The tools work in that user's private folder, with everything in "What users cannot do" above: the operator's model settings, the row, cell, storage, file and daily model limits, and no inference from database variables. Generation runs in the worker pool, like the web UI's runs.
- A session belongs to the user who opened it; a request for it with another user's key is answered as if it did not exist. At most 5 open sessions per user and 500 in total; idle ones close after 30 minutes. Each user may send 240 requests a minute, and an address that sends 30 wrong keys in 15 minutes is refused for a while.
- Each user may hold 10 keys and revoke any of them at any time. Resetting a password through "Forgot password?" revokes all of that user's keys, because whoever knew the old password may have made one. Changing the password while signed in, or "Sign out everywhere", does not; revoke keys in the list if you need to.

The local `--http` server (above) is separate and keeps its no-login, localhost-only setup.

## Use it as a library

The packages are not published to npm yet; inside this repo (npm workspaces):

```ts
import { generate } from "@mockdata/core";                 // deterministic, synchronous
import { generateWithLlm } from "@mockdata/llm";           // also fills `llm` columns
import { inferFromSource } from "@mockdata/inputs";        // schema from a db / file / folder

const data = generate(schemaObjectOrYamlParsed, { seed: 1 });   // { customers: [...], orders: [...] }
```

## Project layout

| Package | Role |
|---|---|
| `packages/core` | Schema validation, table ordering, generation, constraint checks |
| `packages/auth-kit` | Vendored account logic from itravelmap: password hashing, validation, verification and reset tokens, mailer |
| `packages/accounts` | SQLite account store, sessions, OAuth state, rate limits, quotas, emails |
| `packages/llm` | Providers (Anthropic, OpenAI, Ollama/OpenAI-compatible), prompts with parent context, retries |
| `packages/inputs` | Schema inference from databases, OpenAPI/JSON Schema, sample data |
| `packages/cli` | The `mockdata` command |
| `packages/mcp` | The MCP server (`mockdata-mcp`) |
| `packages/server` | The local web UI server (`mockdata-ui`) |
| `packages/web` | The React app the server hosts (Vite, CodeMirror) |

## Development

```
npm test              # everything (vitest); no network, no API keys, no database servers needed
npm run build         # tsc for each package, in dependency order
npm run loadtest      # dev-only: ramps sign-ins, page loads and generation against a real accounts-mode server (apps/loadtest)
```

A live MySQL test runs when `MOCKDATA_TEST_MYSQL_URL` is set. See `CLAUDE.md` for the architecture notes.

Run `npm run build` before `npm test` to include the production bundle checks (they skip when no Vite manifest exists). These guard the 250 kB startup JavaScript budget, the 500 kB per-chunk limit, and lazy-loading boundaries for the workspace, editor, and diagram. The sign-in screen does not load workspace code; the diagram loads on first selection, while the editor stays mounted to preserve undo history.

## Git setup

```
git config user.name $GITHUB_USER_NAME
git config user.email $GITHUB_USER_EMAIL

git config credential.helper 'cache --timeout=3600'
git config credential.helper store

git config --add --bool push.autoSetupRemote true
git config pull.rebase false
git config --list
```

## License

[GNU Affero General Public License](LICENSE), version 3 or (at your option) any later version (`AGPL-3.0-or-later`). You may use, change and share mockdata, including commercially. If you run a modified version as a network service, the AGPL requires you to offer its users the source code of your version.

Data you generate with mockdata is yours and is not covered by the license.
