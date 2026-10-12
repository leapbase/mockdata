import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { introspectSqlite } from "@mockdata/inputs";
import type { SeedMode, SeedSession } from "./session.js";
import { quoteSqlite } from "./session.js";

export async function openSqliteSeedSession(path: string, mode: SeedMode): Promise<SeedSession> {
  if (!existsSync(path)) throw new Error("SQLite target file does not exist");
  const db = new DatabaseSync(path, { readOnly: mode === "preview" });
  db.exec("pragma foreign_keys=ON");
  let active = false;
  return {
    kind: "sqlite",
    async catalog() { return introspectSqlite(db); },
    async hasRows(table) { return !!db.prepare(`select 1 from ${quoteSqlite(table)} limit 1`).get(); },
    async begin() {
      if (mode !== "apply") throw new Error("Preview session is read-only");
      db.exec("begin immediate");
      active = true;
    },
    async insert(table, columns, row) {
      if (mode !== "apply" || !active) throw new Error("Seed inserts require an active apply transaction");
      const sql = `insert into ${quoteSqlite(table)} (${columns.map(quoteSqlite).join(", ")}) values (${columns.map(() => "?").join(", ")})`;
      const values = columns.map((column) => {
        const value = row[column];
        if (value === undefined || value === null) return null;
        if (typeof value === "boolean") return Number(value);
        if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
        throw new Error(`Unsupported SQLite value for ${table}.${column}`);
      });
      db.prepare(sql).run(...values);
    },
    async commit() { if (!active) throw new Error("No active seed transaction"); db.exec("commit"); active = false; },
    async rollback() { if (active) { db.exec("rollback"); active = false; } },
    async close() { if (active) db.exec("rollback"); db.close(); },
  };
}
