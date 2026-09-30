import { describe, expect, it } from "vitest";
import type { Mailer, MailerMessage } from "@mockdata/auth-kit";
import { escapeHtml, sendPasswordResetEmail, sendVerificationEmail } from "../src/index.js";

function capture() {
  const sent: MailerMessage[] = [];
  const mailer: Mailer = { isConfigured: () => true, verifyConnection: async () => undefined, send: async (m) => void sent.push(m), isAuthError: () => false, formatError: String };
  return { sent, mailer };
}

describe("account emails", () => {
  it("sends a verification link with a button, a plain-text alternative and the expiry", async () => {
    const { sent, mailer } = capture();
    await sendVerificationEmail(mailer, "ann@example.com", "https://mockdata.example.com/api/auth/verify-email?token=abc");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ann@example.com" });
    expect(sent[0]!.subject).toMatch(/verify/i);
    expect(sent[0]!.html).toContain('href="https://mockdata.example.com/api/auth/verify-email?token=abc"');
    expect(sent[0]!.text).toContain("https://mockdata.example.com/api/auth/verify-email?token=abc");
    expect(sent[0]!.text).toMatch(/24 hours/);
  });

  it("sends a reset link that states its one-hour expiry", async () => {
    const { sent, mailer } = capture();
    await sendPasswordResetEmail(mailer, "ann@example.com", "https://mockdata.example.com/?reset_token=xyz");
    expect(sent[0]!.subject).toMatch(/reset/i);
    expect(sent[0]!.text).toMatch(/1 hour/);
    expect(sent[0]!.html).toContain("reset_token=xyz");
  });

  it("escapes HTML in the link so it cannot break out of the attribute", async () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    const { sent, mailer } = capture();
    await sendVerificationEmail(mailer, "a@example.com", 'https://x/"><script>alert(1)</script>');
    expect(sent[0]!.html).not.toContain("<script>");
  });
});
