import { describe, expect, it } from "vitest";
import { quoteIdent, tableDdl } from "../src/ddl";
import type { DiagramColumn } from "../src/api";

const col = (name: string, type = "integer", extra: Partial<DiagramColumn> = {}): DiagramColumn => ({ name, type, primaryKey: false, unique: false, nullable: false, ...extra });
const people = { name: "people", rows: 2, columns: [col("id", "integer", { primaryKey: true }), col("email", "email", { unique: true }), col("nick", "string", { nullable: true })] };
const orders = { name: "orders", rows: 5, columns: [col("id", "integer", { primaryKey: true }), col("person_id", "integer", { ref: "people.id" }), col("total", "float"), col("placed", "datetime"), col("paid", "boolean")] };
const all = [people, orders];

describe("tableDdl", () => {
  it("emits PostgreSQL with keys, nullability and quoting", () => {
    expect(tableDdl(people, "postgres", all)).toBe(
      `CREATE TABLE "people" (\n  "id" INTEGER NOT NULL,\n  "email" TEXT NOT NULL,\n  "nick" TEXT,\n  PRIMARY KEY ("id"),\n  UNIQUE ("email")\n);\n`);
  });
  it("maps types per dialect and quotes MySQL with backticks", () => {
    const my = tableDdl(orders, "mysql", all);
    expect(my).toContain("`total` DOUBLE NOT NULL");
    expect(my).toContain("`placed` DATETIME NOT NULL");
    const lite = tableDdl(orders, "sqlite", all);
    expect(lite).toContain('"total" REAL NOT NULL');
    expect(lite).toContain('"paid" INTEGER NOT NULL');
    expect(tableDdl(orders, "postgres", all)).toContain('"placed" TIMESTAMP NOT NULL');
  });
  it("adds foreign keys and a note naming tables to create first", () => {
    const sql = tableDdl(orders, "postgres", all);
    expect(sql).toContain('FOREIGN KEY ("person_id") REFERENCES "people" ("id")');
    expect(sql.startsWith('-- Create "people" first')).toBe(true);
  });
  it("handles self references without a dependency note and skips unknown targets", () => {
    const tree = { name: "node", rows: 3, columns: [col("id", "integer", { primaryKey: true }), col("parent", "integer", { nullable: true, ref: "node.id" }), col("ghost", "integer", { ref: "missing.id" })] };
    const sql = tableDdl(tree, "sqlite", [tree]);
    expect(sql).toContain('FOREIGN KEY ("parent") REFERENCES "node" ("id")');
    expect(sql).not.toContain("missing");
    expect(sql).not.toContain("-- Create");
  });
  it("escapes quote characters in identifiers", () => {
    expect(quoteIdent('a"b', "postgres")).toBe('"a""b"');
    expect(quoteIdent("a`b", "mysql")).toBe("`a``b`");
  });
});
