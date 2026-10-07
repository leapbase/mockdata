/**
 * The documentation at /docs, in English. Public copy: describe only what exists (as the README and CLI help do), and keep it in
 * step with README.md, the CLI help text and packages/mcp/src/reference.ts. Translations are dictionaries in i18n/ keyed by
 * these English strings; i18n.test.tsx lists any string an edit here leaves untranslated. Inline text supports `code`, **bold**
 * and [links](/docs/page#section); links to /docs pages are checked by Docs.test.tsx.
 */

export type Block =
  | { p: string }
  | { code: string; title?: string }
  | { table: { head: string[]; rows: string[][] } }
  | { list: string[]; ordered?: boolean }
  | { note: string; title?: string; tone?: "info" | "warn" }
  | { cards: { title: string; href: string; body: string }[] };

export type Section = { id: string; title: string; blocks: Block[] };
export type DocPage = { slug: string; title: string; group: string; summary: string; icon: IconName; sections: Section[] };
export type IconName = "book" | "rocket" | "table" | "link" | "rule" | "folder" | "window" | "terminal" | "import" | "spark" | "agent" | "server" | "network" | "users" | "key";

export const SOURCE_URL = "https://github.com/leapbase/mockdata";
export const MCP_URL = "https://mockdata.com/mcp";

const SHOP = `seed: 42
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
      total: { type: float, min: 5, max: 500 }`;

export const PAGES: DocPage[] = [
  {
    slug: "", title: "mockdata documentation", group: "Getting started", icon: "book",
    summary: "Generate realistic, related test data from a schema you write, or from one inferred from a database, an OpenAPI or JSON Schema file, or sample rows.",
    sections: [
      { id: "welcome", title: "Welcome to mockdata", blocks: [
        { p: "mockdata turns a short YAML or JSON schema into tables of test data that hang together: every foreign key points at a real row, dates follow each other, and values stay inside the ranges you set. Deterministic generators handle keys, numbers, dates and enums; an LLM writes only the free-text columns you mark." },
        { note: "Sign in at [mockdata.com](/app) and follow the [Quick start](/docs/quick-start) to generate your first dataset in a couple of minutes, with nothing to install.", title: "New to mockdata?" },
      ] },
      { id: "key-features", title: "Key features", blocks: [
        { list: [
          "**Related tables** — tables are generated parents first, so every foreign key value exists in its parent table. Skewed (`zipf`), one-to-one and capped relationships are supported.",
          "**Rules enforced by code** — enums, ranges, patterns, uniqueness and date rules such as \"shipped on or after ordered\" are built in and re-checked after generation. A violation is an error, never a silently wrong row.",
          "**Reproducible** — the same seed gives the same data, so tests and demos stay stable.",
          "**Start from what you have** — infer a schema from Postgres, MySQL or SQLite, from OpenAPI or JSON Schema, or from sample CSV and JSON files.",
          "**LLM-written text, only where you want it** — reviews, notes and bios can be written by a model that sees the row and the rows it belongs to.",
          "**Three ways in** — the web workspace, the `mockdata` command line, and an MCP server for AI agents.",
        ] },
      ] },
      { id: "explore", title: "Explore the documentation", blocks: [
        { cards: [
          { title: "Quick start", href: "/docs/quick-start", body: "Your first schema and dataset" },
          { title: "Schema format", href: "/docs/schema", body: "Tables, columns and types" },
          { title: "Relationships", href: "/docs/relationships", body: "Foreign keys, skew, one-to-one, cycles" },
          { title: "Values and rules", href: "/docs/rules", body: "Ranges, patterns, faker, date rules" },
          { title: "Web workspace", href: "/docs/workspace", body: "Edit, diagram, preview and export" },
          { title: "Command line", href: "/docs/cli", body: "generate, validate and infer" },
          { title: "Infer a schema", href: "/docs/infer", body: "From a database, OpenAPI or samples" },
          { title: "LLM-written text", href: "/docs/llm", body: "Model-written columns with context" },
          { title: "MCP on the web", href: "/docs/mcp", body: "Connect an agent to mockdata.com" },
          { title: "MCP locally", href: "/docs/mcp-local", body: "Run the server on your machine" },
          { title: "Self-hosting", href: "/docs/self-hosting", body: "Run the servers yourself" },
        ] },
      ] },
      { id: "how-it-works", title: "How mockdata works", blocks: [
        { list: [
          "**Describe your tables** — write a schema, or infer one from an existing source.",
          "**mockdata plans the order** — tables are sorted so parents come before children; a cycle is refused unless a nullable foreign key can be filled afterwards.",
          "**Rows are generated** — deterministic columns from the seed, then any model-written columns, parents before children.",
          "**Everything is validated** — keys, ranges, enums, uniqueness and date rules are checked again before you get the data.",
          "**Use the result** — preview it, export JSON, NDJSON or CSV, or hand it to an agent.",
        ], ordered: true },
      ] },
      { id: "open-source", title: "Open source", blocks: [
        { p: `mockdata is open source under the GNU Affero General Public License, version 3 or later, at [github.com/leapbase/mockdata](${SOURCE_URL}). The hosted copy at mockdata.com is free to use. Data you generate is yours and is not covered by the license.` },
      ] },
    ],
  },
  {
    slug: "quick-start", title: "Quick start", group: "Getting started", icon: "rocket",
    summary: "Generate your first related dataset in the browser, or install the command line.",
    sections: [
      { id: "in-the-browser", title: "In the browser", blocks: [
        { list: [
          "Open the [workspace](/app) and sign in, or create an account.",
          "Choose **New** in the Schemas sidebar and paste the schema below, or start from **Import**.",
          "Check the **Diagram** tab: two tables, with an arrow from `orders.customer_id` to `customers.id`.",
          "Open **Generate data** on the right and choose Generate. You get the first 50 rows of each table; foreign key values link to their parent row.",
          "Use **Export** to download every row as JSON, NDJSON or CSV in a zip.",
        ], ordered: true },
        { code: SHOP, title: "shop.yaml" },
      ] },
      { id: "on-your-machine", title: "On your machine", blocks: [
        { p: "Needs Node 22.13 or newer. The packages are not on npm yet, so install from the repository:" },
        { code: `git clone ${SOURCE_URL}.git
cd mockdata
npm install
npm run build
npx mockdata --help` },
        { p: "Then generate from one of the bundled examples:" },
        { code: `npx mockdata generate examples/shop.yaml                  # JSON to stdout
npx mockdata generate examples/shop.yaml -o out -f csv    # one CSV per table
npx mockdata generate examples/shop.yaml -s 123           # same seed = same data
npx mockdata validate examples/shop.yaml                  # check without generating` },
      ] },
      { id: "what-you-get", title: "What you get", blocks: [
        { p: "Every `orders.customer_id` is the id of a real customer, a few customers place most of the orders (`zipf`), no order is placed before its customer signed up, and no order ships before it is placed. Run it again with the same seed and you get exactly the same rows." },
        { note: "Read [Schema format](/docs/schema) for every column option, or [Infer a schema](/docs/infer) to start from a database or sample files instead.", title: "Next" },
      ] },
    ],
  },
  {
    slug: "schema", title: "Schema format", group: "Schemas", icon: "table",
    summary: "A schema is YAML or JSON: an optional seed, an optional llm block, and your tables.",
    sections: [
      { id: "top-level", title: "Top level", blocks: [
        { table: { head: ["Key", "Meaning"], rows: [
          ["`seed`", "Optional integer. The same seed gives the same deterministic columns"],
          ["`llm`", "Optional model settings for model-written columns, see [LLM-written text](/docs/llm)"],
          ["`tables`", "Map of table name to table. Names use letters, digits, `_` and `-`"],
          ["`tables.<name>.rows`", "How many rows to generate"],
          ["`tables.<name>.columns`", "Map of column name to column"],
        ] } },
        { code: `seed: 42
tables:
  customers:
    rows: 20
    columns:
      id: { type: integer, primaryKey: true }
      email: { type: email, unique: true }` },
      ] },
      { id: "column-types", title: "Column types", blocks: [
        { table: { head: ["Type", "Generates"], rows: [
          ["`integer`", "Whole numbers; with `primaryKey: true`, 1..rows in order"],
          ["`float`", "Decimal numbers"],
          ["`string`", "Text, shaped by `enum`, `pattern`, `faker` or `llm`"],
          ["`boolean`", "true or false"],
          ["`date`", "ISO dates such as 2024-03-01"],
          ["`datetime`", "ISO timestamps"],
          ["`uuid`", "Random UUIDs"],
          ["`email`", "Email addresses"],
        ] } },
      ] },
      { id: "column-options", title: "Column options", blocks: [
        { table: { head: ["Option", "Meaning"], rows: [
          ["`primaryKey: true`", "Integer keys are numbered 1..rows"],
          ["`unique: true`", "Values never repeat. On a foreign key it means one-to-one"],
          ["`nullable: true`, `nullRate: 0.2`", "Some values are null (default rate 0.1)"],
          ["`enum: [a, b]`", "One of these values"],
          ["`min`, `max`", "Numbers, or ISO dates for `date` and `datetime`"],
          ["`pattern: \"[A-Z]{3}-[0-9]{4}\"`", "A string matching this regular expression"],
          ["`faker: person.fullName`", "A string from a faker `module.method`, with no arguments"],
          ["`ref: table.column`", "Foreign key, see [Relationships](/docs/relationships)"],
          ["`distribution: zipf`", "A few parents get most of the children (default uniform)"],
          ["`maxPerParent: 3`", "At most 3 children per parent"],
          ["`after: other_col`", "Date on or after another column, see [date rules](/docs/rules#date-rules)"],
          ["`within: 14`", "With `after`: at most 14 days later"],
          ["`llm: true` or `llm: {prompt: \"...\"}`", "Text written by a model (string columns)"],
        ] } },
      ] },
      { id: "validation", title: "Validation", blocks: [
        { p: "A schema is checked before anything is generated: types, references (the target must exist, be a primary key or unique, and have the same type), `after` targets, and table order. The generated data is then checked again against every rule. In the workspace, errors appear inline in the editor as you type; on the command line, `mockdata validate` reports them without generating." },
      ] },
    ],
  },
  {
    slug: "relationships", title: "Relationships", group: "Schemas", icon: "link",
    summary: "Foreign keys, skew, one-to-one links, per-parent caps, self references and cycles.",
    sections: [
      { id: "foreign-keys", title: "Foreign keys", blocks: [
        { p: "Add `ref: table.column` to a column. The target must be a primary key or a unique column of the same type. Parent tables are always generated first, so every value exists in the parent." },
        { code: `customer_id: { type: integer, ref: customers.id }` },
      ] },
      { id: "skew", title: "Skewed relationships", blocks: [
        { p: "By default children pick parents uniformly. `distribution: zipf` makes a few parents get most of the children, which is what real order, visit and log tables usually look like." },
        { code: `customer_id: { type: integer, ref: customers.id, distribution: zipf }` },
      ] },
      { id: "one-to-one-and-caps", title: "One-to-one and caps", blocks: [
        { p: "`unique: true` on a foreign key makes the link one-to-one: each parent is used at most once. `maxPerParent: n` caps how many children a parent gets. Both hold under `zipf` skew. If the parent table is too small to give every child a parent within the cap, generation stops with an error instead of breaking the rule." },
        { code: `user_id:  { type: integer, ref: users.id, unique: true }       # in profiles: one profile per user
order_id: { type: integer, ref: orders.id, maxPerParent: 5 }    # in order_lines: at most 5 lines per order` },
      ] },
      { id: "self-references", title: "Self references", blocks: [
        { p: "A column may reference its own table, such as an employee's manager. It only points at earlier rows, so the first rows have nobody to point at: make it `nullable`." },
        { code: `employees:
  rows: 50
  columns:
    id: { type: integer, primaryKey: true }
    manager_id: { type: integer, ref: employees.id, nullable: true }` },
      ] },
      { id: "cycles", title: "Cycles", blocks: [
        { p: "Tables that reference each other are allowed only when a **nullable** foreign key on the cycle can be filled after all tables exist. That column is left empty on the first pass and filled at the end. Without one you get a clear error naming the cycle, never a guessed order. `examples/hr.yaml` shows a working cycle." },
        { note: "An `after` rule cannot read through a foreign key that is filled afterwards; mockdata reports that combination as an error.", tone: "warn" },
      ] },
    ],
  },
  {
    slug: "rules", title: "Values and rules", group: "Schemas", icon: "rule",
    summary: "Ranges, enums, patterns, faker values, nulls, and date rules across columns and tables.",
    sections: [
      { id: "ranges-and-enums", title: "Ranges and enums", blocks: [
        { p: "`min` and `max` bound numbers, and ISO dates for `date` and `datetime`. `enum` picks from a fixed list." },
        { code: `total: { type: float, min: 5, max: 500 }
signup_date: { type: date, min: "2023-01-01", max: "2024-06-30" }
status: { type: string, enum: [new, paid, shipped] }` },
      ] },
      { id: "patterns", title: "Patterns", blocks: [
        { p: "`pattern` generates strings that match a regular expression, and the result is checked against it, anchored at both ends." },
        { code: `sku: { type: string, pattern: "[A-Z]{3}-[0-9]{4}" }` },
      ] },
      { id: "faker", title: "Faker values", blocks: [
        { p: "`faker` names a [Faker](https://fakerjs.dev/api/) `module.method` with no arguments, such as `person.fullName`, `location.city` or `company.name`. Faker is seeded, so these values are reproducible too." },
        { code: `name: { type: string, faker: person.fullName }
city: { type: string, faker: location.city }` },
      ] },
      { id: "nulls", title: "Nulls", blocks: [
        { p: "`nullable: true` makes about 10% of values null; `nullRate` sets the share." },
        { code: `shipped_at: { type: date, nullable: true, nullRate: 0.3 }` },
      ] },
      { id: "date-rules", title: "Date rules", blocks: [
        { p: "`after` keeps a date on or after another date. Point it at a column in the same row, or read through a foreign key to the parent row with `fk_col.parent_col`. Add `within: n` to cap the gap at n days, for things like a hospital stay or a follow-up visit." },
        { code: `placed_at:  { type: date, after: customer_id.signup_date }   # parent row, through the FK
shipped_at: { type: date, after: placed_at, within: 14 }     # same row, at most 14 days later` },
        { p: "An explicit `max` still applies alongside `within`." },
      ] },
    ],
  },
  {
    slug: "examples", title: "Example schemas", group: "Schemas", icon: "folder",
    summary: "Ready-made schemas in the repository's examples folder; a test runs every one of them.",
    sections: [
      { id: "schemas", title: "Schemas", blocks: [
        { table: { head: ["File", "What it shows"], rows: [
          ["`shop.yaml`", "Two related tables, a skewed foreign key, and date rules that reach across tables"],
          ["`hr.yaml`", "Regex patterns, a one-to-one link, a per-parent cap, a self reference, a table cycle, an `after` rule"],
          ["`shop-llm.yaml`", "The same shop with review text written by an LLM"],
          ["`clinical-ehr.yaml`", "A synthetic health record: date rules from an encounter back to the patient, a one-to-one link, per-parent caps"],
          ["`clinical-trial.yaml`", "A multi-site trial: consent to visit and onset to resolution date chains, enrolment skewed to a few sites"],
          ["`clinical-claims.yaml`", "Insurance claims: service, submission and payment dates, a cap on lines per claim"],
          ["`clinical-rwd-omop.yaml`", "Real-world data shaped like the OMOP Common Data Model, with event dates kept within days of their visit"],
          ["`clinical-sdtm.yaml`", "Trial data laid out like CDISC SDTM plus an ADaM-style ADSL, dated from each subject's first dose"],
          ["`pharmacovigilance.yaml`", "Post-marketing drug safety reports with date chains and reports concentrated on a few products"],
          ["`manufacturing-quality.yaml`", "GMP batches, material lots, QC results, stability studies, deviations with CAPAs, calibration"],
          ["`supply-chain.yaml`", "Serialized track and trace from manufacturer to dispensing, plus suspect-product investigations"],
        ] } },
        { note: "The clinical schemas are synthetic: names, identifiers and codes are illustrative, never real patients." },
      ] },
      { id: "inputs", title: "Inputs to infer from", blocks: [
        { table: { head: ["File", "Use"], rows: [
          ["`samples/customers.csv`, `samples/orders.csv`", "Sample rows (fake data) to infer a schema from"],
          ["`petstore-openapi.yaml`", "An OpenAPI document to infer a schema from"],
          ["`make-sample-db.mjs`", "Builds a small SQLite database to infer from"],
        ] } },
        { p: `Browse them on [GitHub](${SOURCE_URL}/tree/develop/examples).` },
      ] },
    ],
  },
  {
    slug: "workspace", title: "Web workspace", group: "Using mockdata", icon: "window",
    summary: "Write schemas, see their relationships, preview data and export it, all in the browser.",
    sections: [
      { id: "schemas-sidebar", title: "Schemas", blocks: [
        { p: "The left sidebar lists your schemas. Select one to open it, choose **New** to start a draft, and name or rename it in the header field next to **Save**. The top bar holds the theme switch (System, Light, Dark) and your account menu." },
      ] },
      { id: "editor", title: "Editor", blocks: [
        { p: "Edit YAML or JSON with live validation. Errors appear inline and in the status strip, which also shows the order tables will be generated in. Switching to the diagram and back keeps your edits." },
      ] },
      { id: "diagram", title: "Diagram", blocks: [
        { p: "The **Diagram** tab draws each table with its columns, keys and types, and an arrow for every foreign key, from the referencing column to the column it points at. Pan, zoom and fit with the controls." },
        { table: { head: ["Layout", "Direction", "Good for"], rows: [
          ["Layered", "yes", "Most schemas; places tables by the columns each reference uses"],
          ["Layered (basic)", "yes", "An instant layout"],
          ["Tree", "yes", "Hierarchies such as a supply chain"],
          ["Force", "no", "Seeing which tables cluster together"],
          ["Stress", "no", "Like force, with more even spacing"],
          ["Grid", "no", "The most compact view; ignores references"],
        ] } },
        { p: "Pick the engine from the **Layout** menu and, for the directional ones, **Left to right** or **Top to bottom**. Both choices are remembered in this browser. Right-click a table (or press Shift+F10) to show its generated rows, copy its name, or get `CREATE TABLE` DDL for Postgres, MySQL or SQLite." },
      ] },
      { id: "generate", title: "Generate and preview", blocks: [
        { p: "Open **Generate data** on the right for seed, row count and generation controls. Generate shows the first 50 rows of every table; foreign key values link to the parent row. Cancel stops a run and keeps the previous preview." },
        { p: "Turn on **Fill LLM columns** to have model-written columns filled, with progress and a Cancel button. It is available when a model provider is configured." },
      ] },
      { id: "import", title: "Import", blocks: [
        { p: "The **Import** tab builds a schema from a file in your folder, from pasted sample rows, or from a pasted JSON Schema or OpenAPI document; a self-hosted workspace can also read a database whose URL is kept in `.env`. The result opens as an unsaved draft with any warnings listed. See [Infer a schema](/docs/infer) for what is inferred." },
      ] },
      { id: "export", title: "Export", blocks: [
        { p: "From the generation panel, download every row as JSON, NDJSON or CSV in a zip, or write the files to a folder. Existing files are kept unless you tick Overwrite." },
      ] },
    ],
  },
  {
    slug: "cli", title: "Command line", group: "Using mockdata", icon: "terminal",
    summary: "The mockdata command: generate, validate and infer. Also usable as a library.",
    sections: [
      { id: "generate", title: "generate", blocks: [
        { code: `mockdata generate <schema.(yaml|yml|json)> [options]

  -o, --out <dir>       write one file per table into <dir> (default: print JSON to stdout)
  -f, --format <fmt>    json | ndjson | csv (default: json)
  -s, --seed <n>        override the schema seed` },
        { p: "`csv` and `ndjson` need `--out`. CSV cells that start with `=`, `+`, `-` or `@` get a leading quote so spreadsheets do not run them as formulas. Runs with model-written columns print how many calls and tokens they used." },
      ] },
      { id: "validate", title: "validate", blocks: [
        { code: `mockdata validate <schema.(yaml|yml|json)>` },
        { p: "Checks a schema without generating anything." },
      ] },
      { id: "infer", title: "infer", blocks: [
        { code: `mockdata infer <source> [-o schema.yaml] [--rows n] [--force] [--no-enums] [--from kind] [--pg-schema name]` },
        { p: "Builds a schema from a database, an OpenAPI or JSON Schema document, or sample files. The schema goes to stdout (or `-o`), warnings go to stderr. See [Infer a schema](/docs/infer)." },
      ] },
      { id: "library", title: "Use it as a library", blocks: [
        { p: "Inside the repository (npm workspaces):" },
        { code: `import { generate } from "@mockdata/core";            // deterministic, synchronous
import { generateWithLlm } from "@mockdata/llm";      // also fills llm columns
import { inferFromSource } from "@mockdata/inputs";   // schema from a db / file / folder

const data = generate(schema, { seed: 1 });   // { customers: [...], orders: [...] }` },
      ] },
    ],
  },
  {
    slug: "infer", title: "Infer a schema", group: "Using mockdata", icon: "import",
    summary: "Start from a database, an OpenAPI or JSON Schema document, or sample rows instead of a blank page.",
    sections: [
      { id: "sources", title: "Sources", blocks: [
        { table: { head: ["Source", "Notes"], rows: [
          ["`postgres://…`, `mysql://…`, `mariadb://…`", "A live database. Reads structure only, in read-only mode, never table rows"],
          ["`sqlite:file`, `*.db`, `*.sqlite`, `*.sqlite3`", "A SQLite file"],
          ["`env:VARIABLE`", "A database URL from an environment variable or `.env`, so the password never appears on the command line"],
          ["`api.yaml`, `api.json`", "JSON Schema or OpenAPI 3.x / Swagger 2; each object schema becomes a table"],
          ["`data.csv`, `.json`, `.ndjson`", "Sample rows"],
          ["a folder", "Several sample files, one table each; foreign keys are found across them"],
        ] } },
        { code: `npx mockdata infer examples/samples                     # CSVs -> schema
npx mockdata infer examples/petstore-openapi.yaml       # OpenAPI -> schema
npx mockdata infer env:DATABASE_URL -o schema.yaml      # a database, password kept in .env` },
      ] },
      { id: "from-a-database", title: "From a database", blocks: [
        { p: "Types, primary keys, unique columns, nullability, enums and foreign keys. Composite keys, views and unusual types are reported as warnings and skipped or mapped to strings. Postgres reads the `public` schema unless you pass `--pg-schema`." },
      ] },
      { id: "from-openapi", title: "From OpenAPI or JSON Schema", blocks: [
        { p: "Types, formats, enums, ranges, patterns, and optional fields (which become nullable). A property named `<thing>_id` links to the table `<thing>` when it has a same-typed `id`. Add `x-mockdata-ref: \"Table.id\"` to a property to be explicit, and `x-rows` on a schema to set its row count. For Pydantic, use `Model.model_json_schema()`." },
      ] },
      { id: "from-samples", title: "From sample rows", blocks: [
        { p: "Types, ranges, null rates, small enums, foreign keys, skew, one-to-one links, faker hints from column names, and `after` date rules that hold in every one of at least 20 rows. Only the shape is copied, never the rows, but low-cardinality columns become `enum` lists of the observed values; `--no-enums` turns that off." },
      ] },
      { id: "warnings", title: "Warnings", blocks: [
        { note: "Always read the warnings: they list everything that was skipped, guessed or approximated, so you know what to fix in the schema.", tone: "warn" },
        { p: "SQLAlchemy models: create the tables in a SQLite file with `Base.metadata.create_all(engine)` and infer from that." },
      ] },
    ],
  },
  {
    slug: "llm", title: "LLM-written text", group: "Using mockdata", icon: "spark",
    summary: "Let a model write reviews, notes and bios that fit the rest of the row.",
    sections: [
      { id: "mark-a-column", title: "Mark a column", blocks: [
        { code: `body: { type: string, llm: { prompt: "A one or two sentence review whose tone matches the rating" } }` },
        { p: "Only columns marked `llm` go to a model; everything else stays deterministic. An `llm` column cannot also be a key or use `ref`, `enum`, `pattern`, `faker` or `after`." },
      ] },
      { id: "context", title: "What the model sees", blocks: [
        { p: "Each row's prompt includes the row's other values and, through foreign keys, the parent rows it belongs to, so a review can be about the actual product. Parent tables are filled first, so children also see text written for their parents. `llm.contextDepth` (0 to 2, default 1) sets how many foreign-key hops are shown." },
      ] },
      { id: "providers", title: "Providers", blocks: [
        { p: "On mockdata.com the model is set by the site. When you run mockdata yourself, settings come from `.env` in the folder you run from; real environment variables override it, and a schema's top-level `llm:` block overrides both." },
        { table: { head: ["Variable", "Meaning"], rows: [
          ["`AI_PROVIDER`", "`anthropic`, `openai`, `ollama` or `openai-compatible`"],
          ["`ANTHROPIC_MODEL`, `OPENAI_MODEL`, `OLLAMA_MODEL`", "Model name for that provider (no default)"],
          ["`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`", "API keys"],
          ["`OLLAMA_BASE_URL`", "Ollama host, such as `http://localhost:11434`"],
        ] } },
        { code: `llm:
  provider: ollama
  model: llama3.1
  batchSize: 20       # rows per request
  maxRetries: 3
  contextDepth: 1` },
      ] },
      { id: "costs-and-limits", title: "Costs and limits", blocks: [
        { p: "Rows are sent in batches and bad or cut-off replies are retried. A run reports the calls and tokens it used. Model output is not reproducible from the seed (the other columns are), and it costs tokens, so try a small `rows` first." },
        { note: "A schema can come from someone else, so its `llm:` block cannot redirect your keys: `baseUrl` is accepted only for `ollama` and `openai-compatible`, private network addresses are refused, and keys are sent only over https or to localhost.", tone: "warn" },
      ] },
    ],
  },
  {
    slug: "mcp", title: "MCP on the web", group: "AI agents", icon: "agent",
    summary: "Connect an AI agent such as Claude to mockdata.com over the Model Context Protocol, with nothing to install.",
    sections: [
      { id: "connect", title: "Connect", blocks: [
        { list: [
          "Sign in to the [workspace](/app).",
          "Open the account menu, choose **API keys**, and create a key. Copy it now: it is shown only once.",
          "Add the server to your client:",
        ], ordered: true },
        { code: `claude mcp add --transport http mockdata ${MCP_URL} --header "Authorization: Bearer <your API key>"` },
        { p: "Other clients take the same two things: the URL `" + MCP_URL + "` (Streamable HTTP) and the header `Authorization: Bearer <your API key>`." },
      ] },
      { id: "api-keys", title: "API keys", blocks: [
        { list: [
          "Each key is shown once; only a hash of it is stored. The list shows each key's name, its first characters and when it was last used.",
          "You may hold 10 keys and revoke any of them at any time from the same dialog.",
          "The key goes in the `Authorization` header only. Your browser's sign-in is never accepted at `/mcp`, so a web page cannot use it to call the tools.",
          "Resetting your password with \"Forgot password?\" revokes all your keys. Changing the password while signed in, or \"Sign out everywhere\", does not: revoke keys in the list if you need to.",
        ] },
      ] },
      { id: "your-folder", title: "Your folder and limits", blocks: [
        { p: "The tools work in your private folder, the same one the web workspace uses: an agent can read the schemas you saved there by name, or pass a schema inline, and generated files it writes land in that folder. The site's own model settings and limits apply: rows and cells per run, storage, files, and model-written rows per day." },
        { p: "Not available on the web: inferring from a database (`infer_schema` with `connectionEnv`), and choosing a model, provider, address or key in a schema's `llm:` block." },
        { table: { head: ["Limit", "Value"], rows: [
          ["Open sessions", "5 per user; idle sessions close after 30 minutes"],
          ["Requests", "240 a minute per user"],
          ["Wrong keys", "An address that sends 30 wrong keys in 15 minutes is refused for a while"],
        ] } },
      ] },
      { id: "tools", title: "Tools", blocks: [
        { table: { head: ["Tool", "Does"], rows: [
          ["`describe_schema_format`", "Returns the schema reference so an agent can write valid schemas"],
          ["`validate_schema`", "Checks a schema"],
          ["`infer_schema`", "Builds a schema from a file or folder in your folder, or from inline content such as sample rows or an OpenAPI document"],
          ["`generate_data`", "Returns row counts and a small preview; can write every row to files in your folder"],
          ["`get_run_report`", "Seed, row counts, files written, model calls and tokens for the last run"],
        ] } },
        { note: "Running your own [accounts-mode site](/docs/accounts)? It serves the same endpoint at `<MOCKDATA_PUBLIC_URL>/mcp`, with the same keys and limits.", title: "Self-hosted sites" },
      ] },
    ],
  },
  {
    slug: "mcp-local", title: "MCP locally", group: "AI agents", icon: "terminal",
    summary: "Run the MCP server on your own machine against a folder of your own, over stdio or local HTTP.",
    sections: [
      { id: "stdio", title: "Over stdio", blocks: [
        { p: "Build the repository first (`npm run build`, see [Quick start](/docs/quick-start#on-your-machine)). The client starts the server itself; give it absolute paths and a working folder:" },
        { code: `claude mcp add mockdata -e MOCKDATA_ROOT=/path/to/folder -- node /path/to/mockdata/packages/mcp/dist/bin.js` },
        { p: "Or register it in `.mcp.json`:" },
        { code: `{
  "mcpServers": {
    "mockdata": {
      "command": "node",
      "args": ["/path/to/mockdata/packages/mcp/dist/bin.js"],
      "env": { "MOCKDATA_ROOT": "/path/to/a/working/folder" }
    }
  }
}`, title: ".mcp.json" },
      ] },
      { id: "http", title: "Over HTTP", blocks: [
        { p: "For clients that connect to a URL instead of starting a process:" },
        { code: `MOCKDATA_ROOT=/path/to/folder node packages/mcp/dist/bin.js --http [--port 4748]
claude mcp add --transport http mockdata http://127.0.0.1:4748/mcp` },
        { p: "It listens on 127.0.0.1 only and refuses requests whose `Host` or `Origin` is not localhost. Each client session gets its own server, so `get_run_report` is per client; up to 20 sessions, and idle ones close after 30 minutes." },
        { note: "There is no login: the tools read and write files and can spend your model credits. Do not put it behind a public address or tunnel. To share it on a trusted network, use [private network access](/docs/network), which adds a token.", tone: "warn" },
      ] },
      { id: "your-folder", title: "Your folder", blocks: [
        { list: [
          "The agent reads schemas and writes output only inside `MOCKDATA_ROOT`; symlinks that lead outside it are refused.",
          "It never reads `.env` files and never overwrites an existing file unless asked (`overwrite: true`).",
          "Model settings come from `.env` in that folder or the environment, as for the [command line](/docs/llm#providers).",
          "`generate_data` refuses schemas that add up to more than 1,000,000 rows, since it builds everything in memory; the command line has no such limit.",
        ] },
      ] },
      { id: "databases", title: "Inferring from a database", blocks: [
        { p: "An agent can never pass a connection string. Put the URL in `.env` and let `infer_schema` name the variable with `connectionEnv`. The name must be upper case and mention DATABASE, DB, POSTGRES, MYSQL, MARIADB or SQLITE, so it cannot be pointed at an API key, and the value is never echoed back." },
        { code: `DATABASE_URL=postgres://user:password@localhost:5432/shop`, title: ".env" },
      ] },
      { id: "tools", title: "Tools", blocks: [
        { table: { head: ["Tool", "Does"], rows: [
          ["`describe_schema_format`", "Returns the schema reference so an agent can write valid schemas"],
          ["`validate_schema`", "Checks a schema"],
          ["`infer_schema`", "Builds a schema from a file or folder under the root, inline content, or a database URL held in an environment variable"],
          ["`generate_data`", "Returns row counts and a small preview; can write every row to files"],
          ["`get_run_report`", "Seed, row counts, files written, model calls and tokens for the last run"],
        ] } },
      ] },
    ],
  },
  {
    slug: "self-hosting", title: "Self-hosting", group: "Self-hosting", icon: "server",
    summary: "Run the web workspace and the MCP server on your own machine.",
    sections: [
      { id: "servers", title: "Servers", blocks: [
        { p: "Run `npm run build` first (and again after code changes). Both servers listen on 127.0.0.1 only unless you allow a [private network](/docs/network) or turn on [accounts](/docs/accounts)." },
        { table: { head: ["What", "Command", "Address"], rows: [
          ["Web UI", "`npm run ui -- <folder>`", "http://127.0.0.1:4747 (workspace at `/app`)"],
          ["MCP over HTTP", "`MOCKDATA_ROOT=<folder> node packages/mcp/dist/bin.js --http`, see [MCP locally](/docs/mcp-local#http)", "http://127.0.0.1:4748/mcp"],
          ["MCP over stdio", "started by the client, see [MCP locally](/docs/mcp-local#stdio)", "(none)"],
        ] } },
        { p: "`<folder>` holds your schema files and `.env`; nothing outside it is read or written. Connection strings are never typed into the browser: keep them in `.env` and pick the variable name." },
        { p: "`GET /healthz` answers `{\"ok\":true}` for uptime monitors and reverse proxies, after the same host and token checks as every other request." },
      ] },
      { id: "workers", title: "Worker threads", blocks: [
        { p: "The web server generates data in worker threads, so a big run does not hold up other requests. The same seed gives byte-identical output with or without them." },
        { table: { head: ["Variable", "Meaning"], rows: [
          ["`MOCKDATA_WORKERS`", "Threads (default up to 4, leaving a core for the server); `0` generates on the main thread"],
          ["`MOCKDATA_WORKER_QUEUE`", "Jobs that may wait for a thread (16); more are refused with 503"],
          ["`MOCKDATA_JOB_TIMEOUT_SECS`", "A longer job is stopped and answered with 504 (120)"],
          ["`MOCKDATA_WORKER_HEAP_MB`", "Each thread's memory limit (2048)"],
        ] } },
      ] },
      { id: "limits", title: "Limits", blocks: [
        { p: "The MCP `generate_data` tool and the web export refuse schemas that add up to more than 1,000,000 rows, since they build everything in memory. The command line has no such limit." },
      ] },
    ],
  },
  {
    slug: "network", title: "Private network access", group: "Self-hosting", icon: "network",
    summary: "Let other machines on a trusted network use your servers, with a shared token.",
    sections: [
      { id: "allow", title: "Allow ranges", blocks: [
        { code: `npm run ui -- <folder> --allow 100.100.1.x
MOCKDATA_ROOT=<folder> node packages/mcp/dist/bin.js --http --allow 100.100.1.x` },
        { p: "`--allow` takes a comma-separated list of `a.b.c.x` (a /24), CIDRs such as `192.168.0.0/16`, or single IPs. Only private ranges are accepted (10/8, 172.16/12, 192.168/16 and 100.64/10, which covers Tailscale), each at most a /16. Requests must be addressed to an IP, never a host name, which DNS could re-point. Localhost keeps working." },
      ] },
      { id: "token", title: "Token", blocks: [
        { p: "Everyone outside this machine also needs a shared token. Set `MOCKDATA_TOKEN` (16 or more characters from `A-Z a-z 0-9 . _ ~ -`, in the environment or `.env`), or let the server generate one and print it at start. There is no `--token` flag, since command lines show up in process lists." },
        { list: [
          "**Browser:** open `http://<address>:4747/app?token=<token>` once. It becomes an `HttpOnly` cookie and the address bar is cleaned.",
          "**Scripts and MCP clients:** send `Authorization: Bearer <token>`.",
          "**Localhost** needs no token.",
        ] },
        { note: "Traffic is plain http, so anyone who can see the network path can read the token. Use a network you trust, such as a Tailscale tailnet, and treat the token like a password.", tone: "warn" },
      ] },
    ],
  },
  {
    slug: "accounts", title: "Accounts mode", group: "Self-hosting", icon: "users",
    summary: "Run a public site that people sign in to, like mockdata.com.",
    sections: [
      { id: "modes", title: "Modes", blocks: [
        { table: { head: ["Mode", "Turned on by", "Who gets in"], rows: [
          ["Local (default)", "nothing", "anyone on this machine"],
          ["Private network", "`--allow ranges`", "the listed private ranges, with a shared token"],
          ["**Accounts**", "`MOCKDATA_PUBLIC_URL`", "everyone signs in, including localhost"],
        ] } },
        { p: "Localhost is not trusted in accounts mode because a reverse proxy that terminates https connects from localhost on behalf of everyone." },
      ] },
      { id: "setup", title: "Set it up", blocks: [
        { p: "Set the variables below (environment or `.env`), put a reverse proxy that provides https in front, and start the UI as usual. It refuses to start unless people can sign up by email and/or Google." },
        { code: `mockdata.example.com {
  reverse_proxy 127.0.0.1:4747
}`, title: "Caddyfile" },
        { code: `MOCKDATA_PUBLIC_URL=https://mockdata.example.com MOCKDATA_TRUST_PROXY=1 npm run ui -- /path/holding/.env` },
        { table: { head: ["Variable", "Meaning"], rows: [
          ["`MOCKDATA_PUBLIC_URL`", "`https://your-domain` (plain http only for localhost)"],
          ["`MOCKDATA_DATA_DIR`", "Accounts database and every user's private folder (default `./mockdata-data`); back it up"],
          ["`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`", "Email for verification and password reset"],
          ["`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`", "Optional Google sign-in; redirect URI `<MOCKDATA_PUBLIC_URL>/api/auth/google/callback`"],
          ["`MOCKDATA_TRUST_PROXY`", "Read the visitor's address from `X-Forwarded-For` (default on for https)"],
        ] } },
        { p: "Back up with `mockdata-ui --backup <file>`, which copies the account database safely while the server runs; copying `accounts.db` alone can miss recent writes. Back up `<data-dir>/users/` with any file tool, and test a restore." },
      ] },
      { id: "limits", title: "Per-user limits", blocks: [
        { table: { head: ["Variable", "Default"], rows: [
          ["`MOCKDATA_LLM_DAILY_ROWS`", "2,000 model-written rows per user per day"],
          ["`MOCKDATA_LLM_GLOBAL_DAILY_ROWS`", "20,000 per day across all users: your spending ceiling"],
          ["`MOCKDATA_MAX_ROWS`, `MOCKDATA_MAX_CELLS`", "200,000 rows and 500,000 cells per run"],
          ["`MOCKDATA_USER_QUOTA_MB`, `MOCKDATA_USER_MAX_FILES`", "50 MB and 500 files per user"],
          ["`MOCKDATA_MAX_RUNS`", "4 runs at once across all users"],
        ] } },
        { p: "Users cannot infer from a database variable or choose a model, provider, address or key in a schema: the operator's settings are used. The same site serves [MCP](/docs/mcp) at `/mcp` with per-user API keys." },
      ] },
    ],
  },
  {
    slug: "environment", title: "Environment variables", group: "Self-hosting", icon: "key",
    summary: "Every setting read from the environment or .env, in one place.",
    sections: [
      { id: "models", title: "Models", blocks: [
        { table: { head: ["Variable", "Meaning"], rows: [
          ["`AI_PROVIDER`", "`anthropic`, `openai`, `ollama` or `openai-compatible`"],
          ["`ANTHROPIC_MODEL`, `OPENAI_MODEL`, `OLLAMA_MODEL`", "Model for that provider"],
          ["`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`", "API keys"],
          ["`OLLAMA_BASE_URL`", "Ollama host"],
          ["`DATABASE_URL`", "Optional; used as `mockdata infer env:DATABASE_URL`"],
        ] } },
      ] },
      { id: "servers", title: "Servers", blocks: [
        { table: { head: ["Variable", "Meaning"], rows: [
          ["`MOCKDATA_ROOT`", "The MCP server's working folder"],
          ["`MOCKDATA_TOKEN`", "Shared token for [private network access](/docs/network)"],
          ["`MOCKDATA_WORKERS`, `MOCKDATA_WORKER_QUEUE`, `MOCKDATA_JOB_TIMEOUT_SECS`, `MOCKDATA_WORKER_HEAP_MB`", "[Worker threads](/docs/self-hosting#workers)"],
        ] } },
      ] },
      { id: "accounts", title: "Accounts", blocks: [
        { p: "`MOCKDATA_PUBLIC_URL`, `MOCKDATA_DATA_DIR`, `MOCKDATA_TRUST_PROXY`, the `SMTP_*` and `GOOGLE_*` settings, and the per-user limits are described in [Accounts mode](/docs/accounts)." },
        { note: "Never commit `.env`: it holds API keys and passwords. The servers never serve it, and neither browsers nor agents can read it.", tone: "warn" },
      ] },
    ],
  },
];

export const pageHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");
