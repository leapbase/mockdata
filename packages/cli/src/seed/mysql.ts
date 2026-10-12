import { introspectMysql } from "@mockdata/inputs";
import type { SeedMode, SeedSession } from "./session.js";
import { quoteMysql } from "./session.js";

export async function openMysqlSeedSession(url: string, mode: SeedMode): Promise<SeedSession> {
  const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!database) throw new Error("MySQL connection URL needs a database name");
  const { createConnection } = await import("mysql2/promise");
  const conn = await createConnection({ uri: url, connectTimeout: 10_000 });
  let active = false;
  try {
    if (mode === "preview") { await conn.query("start transaction read only"); active = true; }
  } catch (error) { await conn.end(); throw error; }
  return {
    kind: "mysql",
    async catalog() {
      return introspectMysql(async (sql, params) => {
        const [rows] = await conn.query(sql, params);
        return rows as Record<string, unknown>[];
      }, database);
    },
    async hasRows(table) {
      const [rows] = await conn.query(`select 1 from ${quoteMysql(table)} limit 1`);
      return (rows as unknown[]).length > 0;
    },
    async ensureTransactional(tables) {
      for (const table of tables) {
        const [rows] = await conn.query("select table_name as table_name, engine as engine from information_schema.tables where table_schema = ? and table_name = ?", [database, table]);
        const found = (rows as { table_name: string; engine: string }[])[0];
        if (!found || String(found.engine).toLowerCase() !== "innodb") throw new Error(`Table "${table}" must use InnoDB for atomic seed writes`);
      }
    },
    async begin() {
      if (mode !== "apply") throw new Error("Preview session is read-only");
      await conn.query("start transaction"); active = true;
    },
    async insert(table, columns, row) {
      if (mode !== "apply" || !active) throw new Error("Seed inserts require an active apply transaction");
      const params = columns.map((column) => row[column] ?? null);
      await conn.query(`insert into ${quoteMysql(table)} (${columns.map(quoteMysql).join(", ")}) values (${columns.map(() => "?").join(", ")})`, params);
    },
    async commit() { if (!active) throw new Error("No active seed transaction"); await conn.query("commit"); active = false; },
    async rollback() { if (active) { await conn.query("rollback"); active = false; } },
    async close() { if (active) await conn.query("rollback").catch(() => undefined); await conn.end(); },
  };
}
