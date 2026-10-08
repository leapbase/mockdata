# mockdata

Generate realistic, **related** test data from a schema you write, or from a schema inferred from a database, an OpenAPI/JSON Schema file, or sample rows.

- Tables are generated parents-first, so every foreign key points at a real row.
- Numbers, dates, keys and enums come from deterministic, seedable generators. Cross-column rules hold ("a ship date is never before the order date"). Violations are hard errors.
- Free text (reviews, bios, notes) can optionally be written by an LLM, which sees each row's values and the rows it belongs to.
- Use it from the command line, from an AI agent (MCP server), or as a library.

Inspired by [syda](https://github.com/syda-ai/syda), with the constraints enforced by code rather than by prompting.

mockdata is open source ([AGPL-3.0-or-later](#license)) at https://github.com/leapbase/mockdata.

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

Run `npm run build` first (and again after code changes). Needs Node 22.13 or newer. Both servers listen on 127.0.0.1 only unless you pass `--allow` (see "Opening it to your network").

| What | Command | Address |
|---|---|---|
| Web UI | `npm run ui -- <folder>` (`--port n` to change) | http://127.0.0.1:8000 (workspace at `/app`) |
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

The MCP server exposes the same abilities to agents: over stdio or local HTTP (below):

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
npm run ui -- examples          # or: node packages/server/dist/bin.js <folder> [--port 8000]
```

Open http://127.0.0.1:8000 for the workspace (also at `/app`), or http://127.0.0.1:8000/docs for the documentation (available in English, Español and 中文 from the language menu). The folder you pass is the root: schema files are listed in the sidebar, `.env` is read from there, and nothing outside it is ever read or written.

- **Schemas**: select, create, and save schemas in the left sidebar. The top bar holds the theme switch (System, Light, Dark; remembered in this browser) and the Local workspace label.
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

- **Browser:** open `http://<address>:8000/app?token=<token>` once. The server swaps it for an `HttpOnly`, `SameSite=Strict` cookie and redirects to a clean URL, so the token does not stay in the address bar or history.
- **Scripts and MCP clients:** send `Authorization: Bearer <token>`, for example `claude mcp add --transport http mockdata http://<address>:4748/mcp --header "Authorization: Bearer <token>"`. The MCP endpoint accepts the header only, never a cookie or query string.
- **Localhost** needs no token.

Traffic is plain http, so the token can be read by anyone who can see the network path. Use a network you trust, such as a Tailscale tailnet (already encrypted). Anyone holding the token can read and write schema files under the root, spend your LLM credits and use every MCP tool, so treat it like a password and keep sensitive files out of the root. Rotate it by changing `MOCKDATA_TOKEN` and restarting.

## Generation runs in worker threads

The web UI generates data (previews, runs with model-written columns, exports) in worker threads, so a big run no longer freezes the page or anyone else's requests. With 20,000 rows x 6 columns, a trivial request that waited up to 3.2 s behind ten concurrent generations on the main thread waits 2-5 ms with the pool, and preview throughput went from 4 to 11 requests a second.

| Variable | Meaning |
|---|---|
| `MOCKDATA_WORKERS` | threads (default: up to 4, always leaving a core for the server); `0` generates on the main thread as before |
| `MOCKDATA_WORKER_QUEUE` | jobs allowed to wait for a free thread (16); more are refused with 503 "busy" |
| `MOCKDATA_JOB_TIMEOUT_SECS` | a job running longer is stopped and answered with 504 (120); the clock starts once the thread has loaded, not while it starts |
| `MOCKDATA_WORKER_HEAP_MB` | each thread's memory limit (2048), so one pathological schema cannot take the server down |

Threads start when first needed and are reused. A worker that crashes or overruns costs only that job and one replacement thread. Closing the browser tab cancels a queued job and stops a model run before its next request. The same seed gives byte-identical output with or without the pool. Worker threads run the compiled code, so `npm run build` is needed (as it already is for `npm run ui`). The CLI and the MCP server still generate on their own thread.

## Building a hosted layer

The server has one seam for a multi-user site. Implement `HostedPlugin` (`packages/server/src/hosted.ts`) and pass it as `hosted` to `createApp` or `startServer`: the plugin names the caller of each request, gives that caller their own folder and a `Policy` (rate limits, schema and write limits, model and database access, run slots), may serve its own `/api/` routes and `/mcp`, and adds response headers. Without a plugin the server is the local workspace described above. `@mockdata/server` exports the helpers a plugin's routes need (`HttpError`, `readJson`, `sendJson`, `Ctx`, `publicMessage`, ...).

On the web side, `mountApp(slots)` from `@mockdata/web` takes a `gate` (sign-in around the workspace), `landing: true` (serve the landing page at `/`; the open build opens the workspace there), call-to-action labels for the landing page, landing copy and extra documentation pages. `vitest.aliases.ts` exports `mockdataAliases(repoRoot)` for a repository that embeds this one as a git submodule. The hosted site at https://mockdata.com is built this way, from a separate private repository.

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
