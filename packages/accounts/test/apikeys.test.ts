import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AccountsDb, ApiKeyLimitError, ApiKeyStore, MAX_API_KEYS_PER_USER, SqlAuthAdapter } from "../src/index.js";
import { eachEngine, openDb } from "./engines.js";

async function setup(now?: () => number) {
  const db = await openDb();
  const adapter = new SqlAuthAdapter(db);
  const ann = await adapter.createUserWithPasswordIdentity({ normalizedEmail: "ann@example.com", passwordHash: "h", displayName: "ann" });
  const bob = await adapter.createUserWithPasswordIdentity({ normalizedEmail: "bob@example.com", passwordHash: "h", displayName: "bob" });
  return { db, keys: new ApiKeyStore(db, { now }), ann, bob };
}

eachEngine(() => describe("ApiKeyStore", () => {
  it("returns the key once and stores only its hash", async () => {
    const { db, keys, ann } = await setup();
    const { key, info } = await keys.create(ann.id, "  laptop  ");
    expect(key).toMatch(/^md_[A-Za-z0-9_-]{43}$/);
    expect(info).toMatchObject({ name: "laptop", prefix: key.slice(0, 10), lastUsedAt: null });
    const stored = JSON.stringify(await db.all("select * from api_keys"));
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(key.slice(10));
    expect((await keys.lookup(key))?.id).toBe(ann.id);
  });

  it("refuses unknown, malformed and revoked keys", async () => {
    const { keys, ann, bob } = await setup();
    const { key, info } = await keys.create(ann.id, "ci");
    expect(await keys.lookup(undefined)).toBeNull();
    expect(await keys.lookup("md_short")).toBeNull();
    expect(await keys.lookup(key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await keys.revoke(bob.id, info.id)).toBe(false); // not bob's to revoke
    expect((await keys.lookup(key))?.id).toBe(ann.id);
    expect(await keys.revoke(ann.id, info.id)).toBe(true);
    expect(await keys.lookup(key)).toBeNull();
  });

  it("lists only the owner's keys, without the secret, and records when a key was last used", async () => {
    let t = 1_000;
    const { keys, ann, bob } = await setup(() => t);
    const { key } = await keys.create(ann.id, "");
    await keys.create(bob.id, "bob's");
    t = 2_000;
    await keys.lookup(key);
    const list = await keys.list(ann.id);
    expect(list).toEqual([{ id: expect.any(Number), name: "API key", prefix: key.slice(0, 10), createdAt: 1_000, lastUsedAt: 2_000 }]);
    expect(JSON.stringify(list)).not.toContain(key);
  });

  it("caps keys per user and revokes them all at once", async () => {
    const { keys, ann } = await setup();
    for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) await keys.create(ann.id, `k${i}`);
    await expect(keys.create(ann.id, "one more")).rejects.toBeInstanceOf(ApiKeyLimitError);
    expect(await keys.revokeAll(ann.id)).toBe(MAX_API_KEYS_PER_USER);
    expect(await keys.list(ann.id)).toEqual([]);
  });
}));

describe("AccountsDb migrations", () => {
  it("upgrades a version 1 database in place, keeping its users", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mockdata-migrate-")), "accounts.db");
    const first = await AccountsDb.open(file);
    const user = await new SqlAuthAdapter(first).createUserWithPasswordIdentity({ normalizedEmail: "old@example.com", passwordHash: "h", displayName: "old" });
    first.sqlite!.exec("drop table api_keys; pragma user_version = 1"); // what a build from before API keys left behind
    first.close();

    const db = await AccountsDb.open(file);
    expect((db.sqlite!.prepare("pragma user_version").get() as { user_version: number }).user_version).toBe(2);
    const { key } = await new ApiKeyStore(db).create(user.id, "after upgrade");
    expect((await new ApiKeyStore(db).lookup(key))?.email).toBe("old@example.com");
    db.close();
  });

  it("refuses a database from a newer build", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mockdata-migrate-")), "accounts.db");
    const raw = new DatabaseSync(file);
    raw.exec("pragma user_version = 99");
    raw.close();
    await expect(AccountsDb.open(file)).rejects.toThrow(/newer mockdata/);
  });
});
