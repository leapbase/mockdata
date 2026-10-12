import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPostgresSeedSession } from "../src/seed/postgres.js";
import { openMysqlSeedSession } from "../src/seed/mysql.js";

const state = vi.hoisted(() => ({ pg: [] as { sql: string; params?: unknown[] }[], mysql: [] as { sql: string; params?: unknown[] }[], engine: "InnoDB" }));
vi.mock("pg", () => ({ default: { Client: class {
  async connect() {}
  async end() {}
  async query(sql: string, params?: unknown[]) { state.pg.push({ sql, params }); return { rows: [] }; }
} } }));
vi.mock("mysql2/promise", () => ({ createConnection: async () => ({
  async query(sql: string, params?: unknown[]) {
    state.mysql.push({ sql, params });
    if (sql.includes("information_schema.tables") && sql.includes("engine")) return [[{ table_name: "items", engine: state.engine }]];
    return [[]];
  },
  async end() {},
}) }));

beforeEach(() => { state.pg.length = 0; state.mysql.length = 0; state.engine = "InnoDB"; });

describe("network seed adapters", () => {
  it("qualifies PostgreSQL identifiers and binds values in a transaction", async () => {
    const session = await openPostgresSeedSession("postgres://user:secret@localhost/test", "apply", 'custom"schema');
    try {
      await session.begin();
      await session.insert('item"s', ["id", "label"], { id: 1, label: "test" });
      await session.commit();
      expect(state.pg).toContainEqual({ sql: 'insert into "custom""schema"."item""s" ("id", "label") values ($1, $2)', params: [1, "test"] });
      expect(state.pg.map((call) => call.sql)).toContain("begin");
      expect(state.pg.map((call) => call.sql)).toContain("commit");
    } finally { await session.close(); }
  });

  it("opens PostgreSQL preview read-only", async () => {
    const session = await openPostgresSeedSession("postgres://localhost/test", "preview", "public");
    try {
      expect(state.pg.map((call) => call.sql)).toContain("begin read only");
      await expect(session.insert("items", ["id"], { id: 1 })).rejects.toThrow(/read-only|apply/i);
    } finally { await session.close(); }
  });

  it("quotes MySQL identifiers, binds values, and rolls back", async () => {
    const session = await openMysqlSeedSession("mysql://user:secret@localhost/test", "apply");
    try {
      await session.ensureTransactional?.(["items"]);
      await session.begin();
      await session.insert("it`ems", ["id", "label"], { id: 1, label: "test" });
      await session.rollback();
      expect(state.mysql).toContainEqual({ sql: "insert into `it``ems` (`id`, `label`) values (?, ?)", params: [1, "test"] });
      expect(state.mysql.map((call) => call.sql)).toContain("rollback");
    } finally { await session.close(); }
  });

  it("rejects nontransactional MySQL tables before apply", async () => {
    state.engine = "MyISAM";
    const session = await openMysqlSeedSession("mysql://localhost/test", "apply");
    try { await expect(session.ensureTransactional?.(["items"])).rejects.toThrow(/InnoDB/); }
    finally { await session.close(); }
  });
});
