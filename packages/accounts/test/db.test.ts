import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountsDb, SqliteAuthAdapter } from "../src/index.js";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("AccountsDb on disk", () => {
  it("keeps the database, its journal files and the folder private even when the folder already existed", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mockdata-db-")), "data");
    mkdirSync(dir);
    chmodSync(dir, 0o755); // an operator-made folder with loose permissions
    const db = await AccountsDb.open(join(dir, "accounts.db"));
    await new SqliteAuthAdapter(db).createUserWithPasswordIdentity({ normalizedEmail: "a@example.com", passwordHash: "hash", displayName: "a" });
    db.secure(); // after the first write the -wal/-shm files exist too
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "accounts.db"))).toBe(0o600);
    for (const extra of ["accounts.db-wal", "accounts.db-shm"]) expect(mode(join(dir, extra)), extra).toBe(0o600);
    db.close();
  });
});
