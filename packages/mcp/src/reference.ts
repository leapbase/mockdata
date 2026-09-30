/** Returned by the describe_schema_format tool so agents can write valid schemas. */
export const SCHEMA_REFERENCE = `mockdata schema format (YAML or JSON)

Top level
  seed: integer            optional; same seed => same deterministic columns
  llm: {...}               optional; see "LLM columns"
  tables:                  map of table name -> table
    <name>:                letters, digits, _ and - only
      rows: integer        how many rows to generate
      columns: map of column name -> column

Column
  type (required): integer | float | string | boolean | date | datetime | uuid | email
  primaryKey: true         integer keys are sequential 1..rows
  unique: true             values never repeat (on a foreign key: one-to-one)
  nullable: true           some values are null; nullRate: 0..1 (default 0.1)
  enum: [a, b, c]          value is one of these
  min / max                numbers, or ISO dates for date/datetime
  pattern: "[A-Z]{3}-[0-9]{4}"   string matches this regex
  faker: person.fullName   string from a faker "module.method" (no arguments)

Relationships
  ref: parent_table.column      foreign key; target must be primaryKey or unique, same type.
                                Parents are always generated first; every value exists in the parent.
  distribution: uniform | zipf  how children pick parents (zipf = a few parents get most children)
  maxPerParent: n               cap on children per parent (unique: true means 1)
  Self references (ref to own table) only point at earlier rows; make them nullable.
  Table cycles are only allowed when a nullable foreign key on the cycle can be filled afterwards.

Cross-column rules
  after: other_column           date/datetime is >= that column in the same row
  after: fkColumn.parentColumn  date/datetime is >= a column on the parent row reached via fkColumn

LLM columns (semantic free text)
  type: string
  llm: true                     or  llm: { prompt: "what to write" }
  The model sees the row's other values. Not combinable with ref/enum/pattern/faker/after/primaryKey.
  Provider settings come from the server's environment/.env (AI_PROVIDER, <PROVIDER>_MODEL, OLLAMA_BASE_URL, API keys),
  or from a top-level  llm: { provider: anthropic|openai|ollama|openai-compatible, model: ..., baseUrl: ... }.

Example
  seed: 42
  tables:
    customers:
      rows: 20
      columns:
        id: { type: integer, primaryKey: true }
        email: { type: email, unique: true }
        signup_date: { type: date, min: "2023-01-01", max: "2024-06-30" }
    orders:
      rows: 100
      columns:
        id: { type: integer, primaryKey: true }
        customer_id: { type: integer, ref: customers.id, distribution: zipf }
        placed_at: { type: date, after: customer_id.signup_date }
        status: { type: string, enum: [new, paid, shipped] }
`;
