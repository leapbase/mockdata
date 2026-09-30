# mockdata

Generate realistic, **related** test data from a schema you write, or from a schema inferred from a database, an OpenAPI/JSON Schema file, or sample rows.

- Tables are generated parents-first, so every foreign key points at a real row.
- Numbers, dates, keys and enums come from deterministic, seedable generators. Cross-column rules hold ("a ship date is never before the order date"). Violations are hard errors.
- Free text (reviews, bios, notes) can optionally be written by an LLM, which sees each row's values and the rows it belongs to.
- Use it from the command line, from an AI agent (MCP server), or as a library.

Inspired by [syda](https://github.com/syda-ai/syda), with the constraints enforced by code rather than by prompting.

## Install

Needs Node 22.5 or newer (24 is what it is tested on). `infer` from SQLite uses Node's built-in `node:sqlite`.

```
npm install
npm run build
npx mockdata --help
```

## Quick start

```
npx mockdata generate examples/shop.yaml                      # JSON to stdout
npx mockdata generate examples/shop.yaml -o out -f csv        # one CSV per table
npx mockdata generate examples/shop.yaml -s 123               # same seed = same data
npx mockdata validate examples/shop.yaml                      # check a schema without generating
```

### Run the servers

Run `npm run build` first (and again after code changes). Both servers listen on 127.0.0.1 only.

| What | Command | Address |
|---|---|---|
| Web UI | `npm run ui -- <folder>` (`--port n` to change) | http://127.0.0.1:4747 |
| MCP server over HTTP | `MOCKDATA_ROOT=<folder> node packages/mcp/dist/bin.js --http` (`--port n`) | http://127.0.0.1:4748/mcp |
| MCP server over stdio | started by the client: `claude mcp add mockdata -e MOCKDATA_ROOT=<folder> -- node <repo>/packages/mcp/dist/bin.js` | (none) |

`<folder>` holds your schema files and `.env`; nothing outside it is read or written. Details: [Use it from an AI agent (MCP)](#use-it-from-an-ai-agent-mcp) and [Web UI](#web-ui).

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
| `samples/customers.csv`, `samples/orders.csv` | Sample rows (fake data) to try inferring a schema from |
| `petstore-openapi.yaml` | An OpenAPI document to infer a schema from |
| `make-sample-db.mjs` | Builds a small SQLite database (`node examples/make-sample-db.mjs`) to infer from |

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

```
cp .env.example .env        # fill in AI_PROVIDER and the matching model / key
npx mockdata generate examples/shop-llm.yaml
```

The run prints how many calls and tokens it used. LLM output is not reproducible from the seed (only the other columns are), and it costs tokens, so try a small `rows` first. Ollama is verified live; Anthropic and OpenAI follow their documented APIs but have only been tested against fakes.

## Use it from an AI agent (MCP)

The MCP server exposes the same abilities to agents, over stdio or HTTP:

| Tool | Does |
|---|---|
| `describe_schema_format` | Returns the schema reference so an agent can write valid schemas |
| `validate_schema` | Checks a schema |
| `infer_schema` | Builds a schema from a file/folder under the root, inline content, or a database URL held in an environment variable |
| `generate_data` | Returns row counts and a small preview; can write every row to files |
| `get_run_report` | Seed, row counts, files written, LLM calls and tokens for the last run |

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

It serves MCP at `/mcp` on 127.0.0.1 only and refuses requests whose `Host` or `Origin` is not localhost. There is no login: the tools read and write files and can spend LLM credits, so do not put it behind a public address or tunnel. Each client session gets its own server (so `get_run_report` is per client), up to 20 open sessions.

The agent can only read schemas and write output inside `MOCKDATA_ROOT`. It never reads `.env` files and never overwrites an existing file unless asked. It cannot supply a connection string: `infer_schema` only accepts the *name* of an environment variable that looks like database config (for example `DATABASE_URL`).

## Web UI

A local editor and preview, for people who prefer a browser to a terminal.

```
npm run build
npm run ui -- examples          # or: node packages/server/dist/bin.js <folder> [--port 4747]
```

Open http://127.0.0.1:4747. The folder you pass is the root: schema files are listed in the sidebar, `.env` is read from there, and nothing outside it is ever read or written.

- **Edit**: YAML with live validation (errors appear inline and in the status strip, which also shows the generation order). Save writes the file back.
- **Preview**: Generate shows the first 50 rows of every table. Set a seed or a row count for all tables. Foreign key values are links to the parent row.
- **Fill LLM columns**: turn it on to run `llm` columns with progress and a Cancel button. It is only enabled when a provider is configured in `.env` (see LLM setup); the toggle shows which one. Cancelling discards the partial run.
- **Infer from source**: pick a file under the root, paste sample rows or a JSON Schema/OpenAPI document, or choose a database variable by name. The result opens as an unsaved draft with the warnings listed.
- **Export**: write json/ndjson/csv files to a folder under the root (existing files are kept unless you tick Overwrite) or download a zip.

The server listens on 127.0.0.1 only and rejects requests from other hosts or origins. Connection strings are never typed into the browser: keep them in `.env` and pick the variable name. For development run `npm run dev -w packages/web` (Vite on its own port, proxying `/api` to a running `mockdata-ui`).

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
