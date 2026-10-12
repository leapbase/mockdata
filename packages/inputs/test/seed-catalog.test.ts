import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { introspectMysql, introspectPostgres, introspectSqlite } from "../src/index.js";

describe("catalog safety metadata for seeding", () => {
  it("marks SQLite partial unique indexes as unsupported", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("create table items (id integer primary key, a integer, b integer); create unique index items_partial on items(a,b) where a > 0");
      expect(introspectSqlite(db)[0]!.unsupportedForSeed).toEqual([expect.stringContaining("items_partial")]);
    } finally { db.close(); }
  });

  const pg = new PGlite();
  afterAll(() => pg.close());
  it("marks PostgreSQL cross-schema foreign keys and standalone unique indexes", async () => {
    await pg.exec("create schema other; create table other.customers(id integer primary key); create table public.customers(id integer primary key); create table public.orders(id integer primary key, customer_id integer references other.customers(id)); create unique index orders_pair on public.orders(id, customer_id)");
    const query = async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows as Record<string, unknown>[];
    const orders = (await introspectPostgres(query, "public")).find((table) => table.name === "orders")!;
    expect(orders.foreignKeys[0]!.external).toBe(true);
    expect(orders.unsupportedForSeed).toEqual([expect.stringContaining("orders_pair")]);
  }, 30_000);

  it("marks a MySQL FK into a different database with the same table name", async () => {
    const query = async (sql: string) => {
      if (sql.includes("information_schema.columns")) return [
        { table_name: "orders", column_name: "id", column_type: "int", is_nullable: "NO" },
        { table_name: "orders", column_name: "customer_id", column_type: "int", is_nullable: "NO" },
      ];
      if (sql.includes("information_schema.statistics")) return [{ table_name: "orders", index_name: "PRIMARY", non_unique: 0, column_name: "id", seq: 1 }];
      return [{ table_name: "orders", constraint_name: "fk_customer", column_name: "customer_id", ref_table: "customers", ref_schema: "other", ref_column: "id", pos: 1 }];
    };
    const orders = (await introspectMysql(query, "app"))[0]!;
    expect(orders.foreignKeys[0]!.external).toBe(true);
  });
});
