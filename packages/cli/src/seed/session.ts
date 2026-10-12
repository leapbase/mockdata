import type { Row } from "@mockdata/core";
import type { DbKind, RawTable } from "@mockdata/inputs";

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
}

export const quoteSqlite = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const quotePostgres = quoteSqlite;
export const quoteMysql = (name: string) => `\`${name.replace(/`/g, "``")}\``;
