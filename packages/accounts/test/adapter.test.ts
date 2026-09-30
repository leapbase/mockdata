import { describe, expect, it } from "vitest";
import { AuthService, EmailTakenError, generateOpaqueToken, hashOpaqueToken } from "@mockdata/auth-kit";
import { AccountsDb, SqliteAuthAdapter, type AccountUser } from "../src/index.js";

async function setup() {
  const accounts = await AccountsDb.open(":memory:");
  const adapter = new SqliteAuthAdapter(accounts);
  const service = new AuthService<AccountUser>({ adapter, enumerationTimingFloorMs: 0 });
  return { accounts, adapter, service };
}
const PASSWORD = "Sup3r$ecretPassw0rd";

describe("SqliteAuthAdapter with AuthService", () => {
  it("registers a user with a random directory id, and refuses a duplicate email in any case", async () => {
    const { service } = await setup();
    const user = await service.register({ email: "Ann@Example.com", password: PASSWORD });
    expect(user.email).toBe("ann@example.com");
    expect(user.dirId).toMatch(/^[0-9a-f]{32}$/);
    expect(user.displayName).toBe("ann");
    await expect(service.register({ email: "ann@example.com", password: PASSWORD })).rejects.toBeInstanceOf(EmailTakenError);
    await expect(service.register({ email: "ANN@EXAMPLE.COM", password: PASSWORD })).rejects.toBeInstanceOf(EmailTakenError);
    const other = await service.register({ email: "bo@example.com", password: PASSWORD });
    expect(other.dirId).not.toBe(user.dirId);
    expect(other.id).not.toBe(user.id);
  });

  it("logs in with the right password only, and reports whether the email is verified", async () => {
    const { service } = await setup();
    const user = await service.register({ email: "ann@example.com", password: PASSWORD });
    expect(await service.login("ann@example.com", "wrong-Passw0rd!x")).toBeNull();
    expect(await service.login("nobody@example.com", PASSWORD)).toBeNull();
    const before = await service.login("ann@example.com", PASSWORD);
    expect(before).toMatchObject({ emailVerified: false, user: { id: user.id } });
    await service.markEmailVerified(user.id);
    expect((await service.login("ann@example.com", PASSWORD))?.emailVerified).toBe(true);
  });

  it("verifies email through a single-use, expiring token", async () => {
    const { service, adapter } = await setup();
    const user = await service.register({ email: "ann@example.com", password: PASSWORD });
    const raw = await service.createEmailVerificationToken(user.id);
    expect(await service.consumeEmailVerificationToken(raw)).toBe(user.id);
    expect(await service.consumeEmailVerificationToken(raw)).toBeNull(); // single use

    const expired = generateOpaqueToken();
    await adapter.createEmailVerificationToken(user.id, hashOpaqueToken(expired), Math.floor(Date.now() / 1000) - 10);
    expect(await service.consumeEmailVerificationToken(expired)).toBeNull();
    expect(await service.consumeEmailVerificationToken("not-a-token")).toBeNull();
  });

  it("resets a password with a single-use token and the new password then works", async () => {
    const { service } = await setup();
    const user = await service.register({ email: "ann@example.com", password: PASSWORD });
    const raw = await service.createPasswordResetToken(user.id);
    const id = await service.consumePasswordResetToken(raw);
    expect(id).toBe(user.id);
    expect(await service.consumePasswordResetToken(raw)).toBeNull();
    await service.setPassword(user.id, "N3w$ecretPassw0rd!");
    expect(await service.login("ann@example.com", PASSWORD)).toBeNull();
    expect(await service.login("ann@example.com", "N3w$ecretPassw0rd!")).not.toBeNull();
  });

  it("creates and updates OAuth users by provider identity, with no email linking", async () => {
    const { service } = await setup();
    const first = await service.upsertOAuthUser({ provider: "google", providerUserId: "g-1", email: "g@example.com", displayName: "G One", avatarUrl: null });
    const again = await service.upsertOAuthUser({ provider: "google", providerUserId: "g-1", email: "", displayName: "G Renamed", avatarUrl: "https://x/y.png" });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ displayName: "G Renamed", avatarUrl: "https://x/y.png", email: "g@example.com" }); // '' keeps the email
    const emailUser = await service.register({ email: "g@example.com", password: PASSWORD });
    expect(emailUser.id).not.toBe(first.id);
    expect(await service.hasPasswordIdentity(first.id)).toBe(false);
    expect((await service.listIdentities(first.id)).map((i) => i.provider)).toEqual(["google"]);
  });

  it("rolls a transaction back completely on error", async () => {
    const { adapter, service } = await setup();
    await expect(
      adapter.runInTransaction(async (tx) => {
        await tx.createUserWithPasswordIdentity({ normalizedEmail: "x@example.com", passwordHash: "h", displayName: "x" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await adapter.userExistsWithEmail("x@example.com")).toBe(false);
    await service.register({ email: "x@example.com", password: PASSWORD }); // and the email is free again
  });

  it("keeps concurrent operations from landing inside another transaction", async () => {
    const { adapter } = await setup();
    const slow = adapter.runInTransaction(async (tx) => {
      await tx.createUserWithPasswordIdentity({ normalizedEmail: "a@example.com", passwordHash: "h", displayName: "a" });
      await new Promise((r) => setTimeout(r, 30)); // a real await inside the transaction
      throw new Error("abort");
    });
    slow.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    // issued while the transaction is open: must wait for it, then see the rolled-back state
    const exists = await adapter.userExistsWithEmail("a@example.com");
    expect(exists).toBe(false);
    const created = await adapter.createUserWithPasswordIdentity({ normalizedEmail: "b@example.com", passwordHash: "h", displayName: "b" });
    await expect(slow).rejects.toThrow("abort");
    expect(await adapter.findUserById(created.id)).not.toBeNull(); // b was not rolled back with a
  });

  it("revokes sessions except the one to keep", async () => {
    const { accounts, adapter, service } = await setup();
    const { SessionStore } = await import("../src/index.js");
    const user = await service.register({ email: "ann@example.com", password: PASSWORD });
    const sessions = new SessionStore(accounts);
    const a = await sessions.create(user.id);
    const b = await sessions.create(user.id);
    await adapter.revokeUserSessions(user.id, a.id);
    expect(await sessions.lookup(a.id)).not.toBeNull();
    expect(await sessions.lookup(b.id)).toBeNull();
    await adapter.revokeUserSessions(user.id);
    expect(await sessions.lookup(a.id)).toBeNull();
  });
});
