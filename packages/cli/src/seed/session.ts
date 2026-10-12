import type { Row } from "@mockdata/core";
import { detectDatabase, type DbKind, type RawTable } from "@mockdata/inputs";

export type SeedMode = "preview" | "apply";

export interface SeedSession {
  kind: DbKind;
  catalog(): Promise<RawTable[]>;
  hasRows(table: string): Promise<boolean>;
  begin(): Promise<void>;
  insert(table: string, columns: string[], row: Row): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  ensureTransactional?(tables: string[]): Promise<void>;
}

export const quoteSqlite = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const quotePostgres = quoteSqlite;
export const quoteMysql = (name: string) => `\`${name.replace(/`/g, "``")}\``;

export function safeSeedError(error: unknown, target: string): Error {
  let message = error instanceof Error ? error.message : String(error);
  message = message.split(target).join("[REDACTED_CONNECTION]");
  try {
    const password = new URL(target).password;
    for (const secret of [password, decodeURIComponent(password)]) if (secret) message = message.split(secret).join("[REDACTED_SECRET]");
  } catch { /* SQLite path */ }
  return new Error(message);
}

export async function openSeedSession(target: string, mode: SeedMode, pgSchema = "public"): Promise<SeedSession> {
  const detected = detectDatabase(target);
  if (!detected) throw new Error("Unrecognised database target");
  try {
    if (detected.kind === "sqlite") return (await import("./sqlite.js")).openSqliteSeedSession(detected.path!, mode);
    if (detected.kind === "postgres") return (await import("./postgres.js")).openPostgresSeedSession(target, mode, pgSchema);
    return (await import("./mysql.js")).openMysqlSeedSession(target, mode);
  } catch (error) { throw safeSeedError(error, target); }
}
