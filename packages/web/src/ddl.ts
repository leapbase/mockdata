import type { DiagramColumn, SchemaDiagram } from "./api";

export type Dialect = "postgres" | "mysql" | "sqlite";
export const DIALECTS: { id: Dialect; label: string }[] = [
  { id: "postgres", label: "PostgreSQL" },
  { id: "mysql", label: "MySQL" },
  { id: "sqlite", label: "SQLite" },
];

type Table = SchemaDiagram["tables"][number];

const TYPES: Record<Dialect, Record<string, string>> = {
  postgres: { integer: "INTEGER", float: "DOUBLE PRECISION", string: "TEXT", email: "TEXT", boolean: "BOOLEAN", date: "DATE", datetime: "TIMESTAMP", uuid: "UUID" },
  mysql: { integer: "INT", float: "DOUBLE", string: "VARCHAR(255)", email: "VARCHAR(255)", boolean: "BOOLEAN", date: "DATE", datetime: "DATETIME", uuid: "CHAR(36)" },
  sqlite: { integer: "INTEGER", float: "REAL", string: "TEXT", email: "TEXT", boolean: "INTEGER", date: "TEXT", datetime: "TEXT", uuid: "TEXT" },
};

/** Quote an identifier; a quote character inside the name is doubled. */
export function quoteIdent(name: string, dialect: Dialect): string {
  return dialect === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

const sqlType = (c: DiagramColumn, d: Dialect) => TYPES[d][c.type] ?? (d === "mysql" ? "VARCHAR(255)" : "TEXT");

/**
 * CREATE TABLE for one table, from the diagram data alone. Foreign keys to tables not
 * in the diagram are skipped; a note lists the tables that must exist first.
 */
export function tableDdl(table: Table, dialect: Dialect, all: Table[] = []): string {
  const q = (n: string) => quoteIdent(n, dialect);
  const lines = table.columns.map((c) => {
    const parts = [q(c.name), sqlType(c, dialect)];
    if (!c.nullable || c.primaryKey) parts.push("NOT NULL");
    return "  " + parts.join(" ");
  });
  const pk = table.columns.filter((c) => c.primaryKey).map((c) => q(c.name));
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  for (const c of table.columns) if (c.unique && !c.primaryKey) lines.push(`  UNIQUE (${q(c.name)})`);
  const needs = new Set<string>();
  for (const c of table.columns) {
    if (!c.ref) continue;
    const [target, col] = c.ref.split(".");
    if (!target || !col || !all.some((t) => t.name === target && t.columns.some((x) => x.name === col))) continue;
    lines.push(`  FOREIGN KEY (${q(c.name)}) REFERENCES ${q(target)} (${q(col)})`);
    if (target !== table.name) needs.add(target);
  }
  const note = needs.size ? `-- Create ${[...needs].map(q).join(", ")} first (foreign key dependency).\n` : "";
  return `${note}CREATE TABLE ${q(table.name)} (\n${lines.join(",\n")}\n);\n`;
}
