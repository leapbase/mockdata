import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe } from "vitest";
import { AccountsDb, pgliteDriver, type Dialect, type PgDriver } from "../src/index.js";

/** Every store test runs on both engines. Postgres is PGlite: a real Postgres, in process, no server needed. */
export const ENGINES: Dialect[] = ["sqlite", "postgres"];

let current: Dialect = "sqlite";
let shared: { pglite: PGlite; driver: PgDriver } | undefined;

const TABLES = "users, identities, email_verification_tokens, password_reset_tokens, sessions, oauth_states, usage, api_keys, rate_events, run_slots";

/**
 * A fresh, empty account database on the current engine. Starting PGlite takes a second or two, so one instance is
 * shared per engine block and emptied before each test instead (closing the returned database leaves it running).
 */
export async function openDb(): Promise<AccountsDb> {
  if (current === "sqlite") return AccountsDb.open(":memory:");
  if (!shared) {
    const pglite = new PGlite({ parsers: { 20: Number } });
    shared = { pglite, driver: pgliteDriver(pglite) };
  }
  const driver: PgDriver = { ...shared.driver, close: async () => undefined };
  const db = await AccountsDb.openPostgres(driver);
  await shared.pglite.exec(`truncate ${TABLES} restart identity cascade`);
  return db;
}

/** Run `body`'s tests once per engine, as describe blocks named after it. */
export function eachEngine(body: (engine: Dialect) => void): void {
  for (const engine of ENGINES) {
    describe(engine, () => {
      beforeAll(() => {
        current = engine;
      });
      afterAll(async () => {
        if (engine === "postgres" && shared) {
          await shared.pglite.close();
          shared = undefined;
        }
      });
      body(engine);
    });
  }
}

/**
 * Live Postgres tests (MOCKDATA_TEST_POSTGRES_URL) run in parallel files against one database, so each gets its own
 * schema, emptied on every call: the returned URL points the connection's search_path at it.
 */
export async function liveSchema(name: string): Promise<string> {
  const base = process.env.MOCKDATA_TEST_POSTGRES_URL!;
  const { pgPoolDriver } = await import("../src/index.js");
  const admin = await pgPoolDriver(base, { max: 1 });
  await admin.exec(`drop schema if exists ${name} cascade; create schema ${name}`);
  await admin.close();
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${name}`);
  return url.toString();
}
