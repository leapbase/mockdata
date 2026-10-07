import type { DatabaseSync } from "node:sqlite";

/**
 * The account stores talk to the database through this, so the same code runs on SQLite (one server) and on Postgres
 * (one or several servers). SQL is written once with `?` placeholders; the Postgres engine numbers them.
 */
export type Params = readonly unknown[];
export type Dialect = "sqlite" | "postgres";

export interface Queries {
  all<T>(sql: string, params?: Params): Promise<T[]>;
  one<T>(sql: string, params?: Params): Promise<T | undefined>;
  /** Run a statement; resolves to the number of rows it changed. */
  run(sql: string, params?: Params): Promise<number>;
}

export interface Tx extends Queries {
  /**
   * Hold `name` until this transaction ends, so check-then-write steps that take the same name run one at a time
   * across every server. A no-op on SQLite, where a transaction already has the database to itself.
   */
  lock(name: string): Promise<void>;
  /** Several statements that succeed or fail together inside this transaction (a savepoint). */
  atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface Engine extends Queries {
  readonly dialect: Dialect;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A unique-constraint violation, on either engine. */
export const isUniqueViolation = (e: unknown): boolean =>
  (e as { errcode?: number })?.errcode === 2067 || (e as { code?: string })?.code === "23505" || /UNIQUE constraint failed/.test(String((e as Error)?.message));

// ---------------------------------------------------------------------------------------------------------------- SQLite

/**
 * node:sqlite is synchronous but callers are async, so a statement from another request could otherwise run between
 * two `await`s inside a transaction and land inside it. Every top-level call therefore goes through one gate, and a
 * transaction holds the gate until it commits or rolls back.
 */
export class SqliteEngine implements Engine {
  readonly dialect = "sqlite" as const;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly raw: DatabaseSync) {}

  async gated<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  all<T>(sql: string, params: Params = []): Promise<T[]> {
    return this.gated(() => this.raw.prepare(sql).all(...(params as never[])) as T[]);
  }
  one<T>(sql: string, params: Params = []): Promise<T | undefined> {
    return this.gated(() => this.raw.prepare(sql).get(...(params as never[])) as T | undefined);
  }
  run(sql: string, params: Params = []): Promise<number> {
    return this.gated(() => Number(this.raw.prepare(sql).run(...(params as never[])).changes));
  }
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.gated(async () => {
      this.raw.exec("begin immediate");
      try {
        const result = await fn(new SqliteTx(this.raw));
        this.raw.exec("commit");
        return result;
      } catch (e) {
        this.raw.exec("rollback");
        throw e;
      }
    });
  }
  async close(): Promise<void> {
    this.raw.close();
  }
}

class SqliteTx implements Tx {
  private depth = 0;
  constructor(private readonly raw: DatabaseSync) {}
  async all<T>(sql: string, params: Params = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }
  async one<T>(sql: string, params: Params = []): Promise<T | undefined> {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  async run(sql: string, params: Params = []): Promise<number> {
    return Number(this.raw.prepare(sql).run(...(params as never[])).changes);
  }
  async lock(): Promise<void> {}
  async atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const name = `sp${++this.depth}`;
    this.raw.exec(`savepoint ${name}`);
    try {
      const result = await fn(this);
      this.raw.exec(`release ${name}`);
      return result;
    } catch (e) {
      this.raw.exec(`rollback to ${name}; release ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
}

// -------------------------------------------------------------------------------------------------------------- Postgres

export interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}
export interface PgQuerier {
  query(sql: string, params?: Params): Promise<PgResult>;
  /** Several statements in one string (DDL). */
  exec(sql: string): Promise<void>;
}
/** What the Postgres engine needs from a driver: `pg`'s Pool in production (`pgPoolDriver`), PGlite in tests. */
export interface PgDriver extends PgQuerier {
  transaction<T>(fn: (q: PgQuerier) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `?` placeholders become `$1, $2, …`; question marks inside quoted strings are left alone. */
export function numberPlaceholders(sql: string): string {
  let n = 0;
  let quoted = false;
  let out = "";
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === "?" && !quoted ? `$${++n}` : ch;
  }
  return out;
}

export class PostgresEngine implements Engine {
  readonly dialect = "postgres" as const;
  constructor(readonly driver: PgDriver) {}
  async all<T>(sql: string, params: Params = []): Promise<T[]> {
    return (await this.driver.query(numberPlaceholders(sql), params)).rows as T[];
  }
  async one<T>(sql: string, params: Params = []): Promise<T | undefined> {
    return (await this.driver.query(numberPlaceholders(sql), params)).rows[0] as T | undefined;
  }
  async run(sql: string, params: Params = []): Promise<number> {
    return (await this.driver.query(numberPlaceholders(sql), params)).rowCount;
  }
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.driver.transaction((q) => fn(new PostgresTx(q)));
  }
  close(): Promise<void> {
    return this.driver.close();
  }
}

export class PostgresTx implements Tx {
  private depth = 0;
  constructor(readonly q: PgQuerier) {}
  async all<T>(sql: string, params: Params = []): Promise<T[]> {
    return (await this.q.query(numberPlaceholders(sql), params)).rows as T[];
  }
  async one<T>(sql: string, params: Params = []): Promise<T | undefined> {
    return (await this.q.query(numberPlaceholders(sql), params)).rows[0] as T | undefined;
  }
  async run(sql: string, params: Params = []): Promise<number> {
    return (await this.q.query(numberPlaceholders(sql), params)).rowCount;
  }
  async lock(name: string): Promise<void> {
    await this.q.query("select pg_advisory_xact_lock(hashtext($1))", [`mockdata:${name}`]);
  }
  async atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const name = `sp${++this.depth}`;
    await this.q.exec(`savepoint ${name}`);
    try {
      const result = await fn(this);
      await this.q.exec(`release savepoint ${name}`);
      return result;
    } catch (e) {
      await this.q.exec(`rollback to savepoint ${name}; release savepoint ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
}

/** Bigint columns (ids, epoch seconds, counts, sums) come back as JS numbers; all of ours fit. */
const INT8 = 20;

/** Production driver: a `pg` connection pool, loaded only when Postgres is used. */
export async function pgPoolDriver(connectionString: string, opts: { max?: number } = {}): Promise<PgDriver> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    types: { getTypeParser: ((oid: number, format?: string) => (oid === INT8 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as never))) as never },
  });
  // An idle client that loses its connection must not crash the server; the next query reconnects.
  pool.on("error", (e) => process.stderr.write(`accounts database: idle connection error (${e.message})\n`));
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }): PgQuerier => ({
    async query(sql, params = []) {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await c.query(sql);
    },
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(wrap(client));
        await client.query("commit");
        return result;
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** The parts of PGlite the tests use (kept structural, so this package does not depend on PGlite). */
export interface PGliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query: PGliteLike["query"]; exec: PGliteLike["exec"] }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A driver over an in-process PGlite (real Postgres, for tests). Create PGlite with `parsers: { 20: Number }`. */
export function pgliteDriver(db: PGliteLike): PgDriver {
  const wrap = (c: { query: PGliteLike["query"]; exec: PGliteLike["exec"] }): PgQuerier => ({
    async query(sql, params = []) {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) {
      await c.exec(sql);
    },
  });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx))), close: () => db.close() };
}
