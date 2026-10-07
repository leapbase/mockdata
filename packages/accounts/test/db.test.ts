import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountsDb, SqlAuthAdapter } from "../src/index.js";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("AccountsDb on disk", () => {
  it("keeps the database, its journal files and the folder private even when the folder already existed", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mockdata-db-")), "data");
    mkdirSync(dir);
    chmodSync(dir, 0o755); // an operator-made folder with loose permissions
    const db = await AccountsDb.open(join(dir, "accounts.db"));
    await new SqlAuthAdapter(db).createUserWithPasswordIdentity({ normalizedEmail: "a@example.com", passwordHash: "hash", displayName: "a" });
    db.secure(); // after the first write the -wal/-shm files exist too
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "accounts.db"))).toBe(0o600);
    for (const extra of ["accounts.db-wal", "accounts.db-shm"]) expect(mode(join(dir, extra)), extra).toBe(0o600);
    db.close();
  });
});

describe("AccountsDb.backupFile", () => {
  async function liveDb() {
    const dir = mkdtempSync(join(tmpdir(), "mockdata-backup-"));
    const file = join(dir, "accounts.db");
    const db = await AccountsDb.open(file);
    const adapter = new SqlAuthAdapter(db);
    for (let i = 0; i < 3; i++) await adapter.createUserWithPasswordIdentity({ normalizedEmail: `u${i}@example.com`, passwordHash: "hash", displayName: `u${i}` });
    return { dir, file, db, adapter };
  }

  it("copies a live database, uncommitted WAL pages included, into a private file that opens as the same schema", async () => {
    const { dir, file, db, adapter } = await liveDb();
    expect(existsSync(`${file}-wal`)).toBe(true); // the server still has it open in WAL mode
    const target = join(dir, "copy.db");
    await AccountsDb.backupFile(file, target);
    await adapter.createUserWithPasswordIdentity({ normalizedEmail: "after@example.com", passwordHash: "hash", displayName: "after" });
    expect(mode(target)).toBe(0o600);
    const copy = await AccountsDb.open(target);
    expect((copy.sqlite!.prepare("select count(*) as n from users").get() as { n: number }).n).toBe(3);
    expect((copy.sqlite!.prepare("pragma user_version").get() as { user_version: number }).user_version).toBe((db.sqlite!.prepare("pragma user_version").get() as { user_version: number }).user_version);
    copy.close();
    db.close();
  });

  it("never overwrites a file and needs a source database", async () => {
    const { dir, file, db } = await liveDb();
    const taken = join(dir, "taken.db");
    writeFileSync(taken, "keep me");
    await expect(AccountsDb.backupFile(file, taken)).rejects.toThrow(/already exists/);
    await expect(AccountsDb.backupFile(join(dir, "missing.db"), join(dir, "x.db"))).rejects.toThrow(/No account database/);
    db.close();
  });
});
