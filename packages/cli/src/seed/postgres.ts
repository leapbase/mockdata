import { introspectPostgres } from "@mockdata/inputs";
import type { SeedMode, SeedSession } from "./session.js";
import { quotePostgres } from "./session.js";

export async function openPostgresSeedSession(url: string, mode: SeedMode, pgSchema = "public"): Promise<SeedSession> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await client.connect();
  let active = false;
  try {
    if (mode === "preview") { await client.query("begin read only"); active = true; }
  } catch (error) { await client.end(); throw error; }
  const qualified = (table: string) => `${quotePostgres(pgSchema)}.${quotePostgres(table)}`;
  return {
    kind: "postgres",
    async catalog() { return introspectPostgres(async (sql, params) => (await client.query(sql, params)).rows, pgSchema); },
    async hasRows(table) { return (await client.query(`select 1 from ${qualified(table)} limit 1`)).rows.length > 0; },
    async begin() {
      if (mode !== "apply") throw new Error("Preview session is read-only");
      await client.query("begin"); active = true;
    },
    async insert(table, columns, row) {
      if (mode !== "apply" || !active) throw new Error("Seed inserts require an active apply transaction");
      const params = columns.map((column) => row[column] ?? null);
      const markers = columns.map((_, index) => `$${index + 1}`);
      await client.query(`insert into ${qualified(table)} (${columns.map(quotePostgres).join(", ")}) values (${markers.join(", ")})`, params);
    },
    async commit() { if (!active) throw new Error("No active seed transaction"); await client.query("commit"); active = false; },
    async rollback() { if (active) { await client.query("rollback"); active = false; } },
    async close() { if (active) await client.query("rollback").catch(() => undefined); await client.end(); },
  };
}
