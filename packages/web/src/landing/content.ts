// Landing page copy. Every claim here describes something the project really does (see README.md);
// the sample rows are real output of `mockdata generate examples/shop.yaml` (seed 42).

export const SCHEMA_SNIPPET = `seed: 42
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
      placed_at: { type: date, after: customer_id.signup_date }
      shipped_at: { type: date, after: placed_at, nullable: true }
      status: { type: string, enum: [new, paid, shipped] }
      total: { type: float, min: 5, max: 500 }`;

export const SAMPLE_COLUMNS = ["id", "customer_id", "placed_at", "shipped_at", "status", "total"] as const;
export const SAMPLE_ROWS: (string | number | null)[][] = [
  [1, 6, "2023-07-16", "2024-06-14", "paid", 428.97],
  [2, 7, "2024-01-01", null, "paid", 18.12],
  [3, 5, "2024-11-28", "2025-04-18", "paid", 231.83],
  [4, 5, "2024-11-29", "2025-11-14", "shipped", 101.91],
  [5, 1, "2023-11-27", null, "new", 343.09],
];

export const CLI_SNIPPET = `npx mockdata generate examples/shop.yaml                 # JSON to stdout
npx mockdata generate examples/shop.yaml -o out -f csv   # one CSV per table
npx mockdata generate examples/shop.yaml -s 123          # same seed = same data
npx mockdata infer examples/samples -o my-schema.yaml    # CSVs -> schema
npx mockdata infer env:DATABASE_URL                      # Postgres / MySQL catalog -> schema`;

/** Public source repository. AGPL-3.0 section 13 asks a hosted copy to offer users its source; this link does that. */
export const SOURCE_URL = "https://github.com/leapbase/mockdata";

/** The hosted MCP endpoint (Streamable HTTP; API key from the account menu). */
export const MCP_URL = "https://mockdata.com/mcp";

export const MCP_SNIPPET = `# 1. Sign in, then create a key under API keys in the account menu
# 2. Add the hosted MCP server to Claude Code
claude mcp add --transport http mockdata ${MCP_URL} \\
  --header "Authorization: Bearer <your API key>"

# Any MCP client that speaks Streamable HTTP can use the same URL and header.
# Tools the agent gets
describe_schema_format  validate_schema  infer_schema
generate_data           get_run_report`;

export const STEPS = [
  {
    title: "Define or infer a schema",
    body: "Write a short YAML schema, or infer one from a SQLite, Postgres or MySQL catalog, an OpenAPI or JSON Schema file, or sample CSV/JSON rows.",
  },
  {
    title: "Generate",
    body: "Parents are generated before children, so every foreign key resolves. Constraints hold by construction and are re-checked before anything is returned.",
  },
  {
    title: "Export",
    body: "Download JSON, NDJSON or CSV (one file per table, or a zip), or copy CREATE TABLE statements for PostgreSQL, MySQL or SQLite.",
  },
];

export const FEATURES = [
  {
    icon: "link",
    title: "Referential integrity",
    body: "Foreign keys always point at real rows. Skew children with a zipf distribution, cap them with maxPerParent, or make a key one-to-one.",
  },
  {
    icon: "rule",
    title: "Cross-column rules",
    body: "A ship date is never before the order date. `after` reads the same row or a parent row through a foreign key, and `within` caps the gap.",
  },
  {
    icon: "spark",
    title: "LLM text, only where it helps",
    body: "Mark a column `llm` and a model writes it (Anthropic, OpenAI, Ollama or any OpenAI-compatible server), seeing the row and its parent rows.",
  },
  {
    icon: "db",
    title: "Infer from what you have",
    body: "Read a database catalog, an API spec or sample files. Only metadata is read from databases; anything guessed is reported as a warning.",
  },
  {
    icon: "seed",
    title: "Reproducible by seed",
    body: "Keys, numbers, dates and enums come from seeded generators. Same schema and seed, same data, in CI and on every laptop.",
  },
  {
    icon: "agent",
    title: "Hosted MCP for AI agents",
    body: "Point Claude, Cursor or any MCP client at `https://mockdata.com/mcp` with an API key, and agents can validate, infer and generate data in your workspace.",
  },
] as const;

export const USE_CASES = [
  { title: "Frontend before the backend", body: "Build screens against related, realistic records on day one, before an API exists." },
  { title: "QA and CI fixtures", body: "Seeded datasets give tests the same rows on every run, with edge cases such as nulls and skew you choose." },
  { title: "Demo environments", body: "Fill a demo with believable customers, orders and reviews without copying anyone's real data." },
  { title: "AI agent sandboxes", body: "Let a coding agent create and regenerate test data through the hosted MCP endpoint, inside your own workspace." },
  { title: "Stand-ins for production", body: "Infer the shape of a production schema and generate look-alike data: shape is copied, rows never are." },
];

export const FAQ = [
  {
    q: "Is it free and open source?",
    a: `Yes. mockdata.com is free to use, with the same per-account limits on rows and model-written text that keep it fair for everyone. The code is open source under the AGPL-3.0-or-later at ${SOURCE_URL}, so you can also run it yourself.`,
  },
  {
    q: "Is the output deterministic?",
    a: "Yes for everything except model-written text: keys, numbers, dates, enums and faker values come from a seeded generator, so the same schema and seed give the same data. Text written by an LLM is not reproducible by seed.",
  },
  {
    q: "Do I need an LLM?",
    a: "No. A model is only used for columns marked llm. Configure Anthropic, OpenAI, Ollama or an OpenAI-compatible server in .env when you want it.",
  },
  {
    q: "Does infer read my database rows?",
    a: "No. Database inference reads catalog metadata only (tables, columns, keys), in a read-only session. Sample files are read to learn shape, but rows are never copied; low-cardinality columns can copy their observed values as enums, which you can turn off.",
  },
  {
    q: "How do I connect an AI agent?",
    a: "Sign in, create a key under API keys in the account menu, and add https://mockdata.com/mcp to your MCP client with the header Authorization: Bearer <key>. Agents work in your own workspace, with the same limits as the web app; revoke a key at any time.",
  },
  {
    q: "Can it run entirely locally?",
    a: "Yes. The CLI, web UI and MCP server (stdio or local HTTP) also run on your machine, and with Ollama even the text generation stays local.",
  },
  {
    q: "Which formats can I export?",
    a: "JSON, NDJSON and CSV, written into your folder or downloaded as a zip, plus CREATE TABLE statements for PostgreSQL, MySQL and SQLite from the diagram.",
  },
  {
    q: "Is it safe to open on a network?",
    a: "The servers listen on localhost by default. You can open them to private address ranges with a shared token, or run accounts mode behind an https reverse proxy. Traffic from the server itself is plain http.",
  },
];
