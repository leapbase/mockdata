import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteSeedSession } from "../src/seed/sqlite.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mockdata-seed-"));
  roots.push(root);
  const path = join(root, "test.db");
  const db = new DatabaseSync(path);
  db.exec('create table "customer" ("id" integer primary key, "full name" text not null); create table "order" ("id" integer primary key, "customer_id" integer not null references "customer"("id")); create table "people" ("id" integer primary key, "mentor_id" integer references "people"("id"))');
  db.close();
  return path;
}

describe("SQLite seed session", () => {
  it("opens preview read-only and reports catalog/emptiness", async () => {
    const session = await openSqliteSeedSession(fixture(), "preview");
    try {
      expect((await session.catalog()).map((table) => table.name)).toEqual(["customer", "order", "people"]);
      expect(await session.hasRows("customer")).toBe(false);
      await expect(session.insert("customer", ["id", "full name"], { id: 1, "full name": "Ada" })).rejects.toThrow();
    } finally { await session.close(); }
  });

  it("enforces foreign keys and commits quoted identifiers plus self references", async () => {
    const path = fixture();
    const session = await openSqliteSeedSession(path, "apply");
    try {
      await session.begin();
      await expect(session.insert("order", ["id", "customer_id"], { id: 1, customer_id: 99 })).rejects.toThrow();
      await session.insert("customer", ["id", "full name"], { id: 1, "full name": "Ada" });
      await session.insert("order", ["id", "customer_id"], { id: 1, customer_id: 1 });
      await session.insert("people", ["id", "mentor_id"], { id: 1, mentor_id: null });
      await session.insert("people", ["id", "mentor_id"], { id: 2, mentor_id: 1 });
      await session.commit();
      expect(await session.hasRows("customer")).toBe(true);
    } finally { await session.close(); }
    const db = new DatabaseSync(path);
    expect(db.prepare('select "full name" as name from "customer"').get()).toEqual({ name: "Ada" });
    expect(db.prepare('select mentor_id from people where id = 2').get()).toEqual({ mentor_id: 1 });
    db.close();
  });

  it("rolls back every inserted row after a later failure", async () => {
    const path = fixture();
    const session = await openSqliteSeedSession(path, "apply");
    try {
      await session.begin();
      await session.insert("customer", ["id", "full name"], { id: 1, "full name": "Ada" });
      await expect(session.insert("customer", ["id", "full name"], { id: 1, "full name": "Duplicate" })).rejects.toThrow();
      await session.rollback();
      expect(await session.hasRows("customer")).toBe(false);
    } finally { await session.close(); }
  });
});
