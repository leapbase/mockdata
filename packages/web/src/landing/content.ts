// Landing page code, sample rows and links (the same in every language; the text is in copy.ts).
// The sample rows are real output of `mockdata generate examples/shop.yaml` (seed 42).

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

export { SOURCE_URL } from "../source";

/** The AI tab's schema: the tables of examples/shop-llm.yaml, verbatim (a test checks), so the prompt shown is a real one. */
export const LLM_SNIPPET = `tables:
  products:
    rows: 5
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: string, faker: commerce.productName }
  reviews:
    rows: 12
    columns:
      id: { type: integer, primaryKey: true }
      product_id: { type: integer, ref: products.id }
      rating: { type: integer, min: 1, max: 5 }
      body:
        type: string
        llm: { prompt: "A one or two sentence customer review whose tone matches the rating (1 = angry, 5 = delighted)" }`;

/** The tools an agent gets, as registered in packages/mcp/src/server.ts. */
export const MCP_TOOLS = ["describe_schema_format", "validate_schema", "infer_schema", "generate_data", "get_run_report"] as const;

/** Icons for the feature cards, in the order of `features.items` in copy.ts. */
export const FEATURE_ICONS = ["link", "rule", "spark", "db", "seed", "agent"] as const;
