import { createMailer, getMailerConfigFromEnv, type Mailer } from "@mockdata/auth-kit";

export const APP_NAME = "mockdata";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** SMTP mailer from SMTP_HOST/PORT/SECURE/USER/PASS/FROM (Resend: smtp.resend.com, user "resend", the API key as the password). */
export function mailerFromEnv(env: Record<string, string | undefined>): Mailer {
  return createMailer(getMailerConfigFromEnv(env));
}

function layout(heading: string, intro: string, buttonText: string, link: string, expiry: string): { html: string; text: string } {
  const safe = escapeHtml(link);
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;color:#1f2933">
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
<p>${escapeHtml(intro)}</p>
<p><a href="${safe}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">${escapeHtml(buttonText)}</a></p>
<p style="font-size:13px;color:#52606d">Or paste this link into your browser:<br>${safe}</p>
<p style="font-size:13px;color:#52606d">${escapeHtml(expiry)} If you did not ask for this, you can ignore this email.</p>
</div>`;
  const text = `${heading}\n\n${intro}\n\n${link}\n\n${expiry} If you did not ask for this, you can ignore this email.\n`;
  return { html, text };
}

export async function sendVerificationEmail(mailer: Mailer, to: string, link: string): Promise<void> {
  const { html, text } = layout(`Verify your email for ${APP_NAME}`, `Confirm this address to finish creating your ${APP_NAME} account.`, "Verify email", link, "This link expires in 24 hours.");
  await mailer.send({ to, subject: `Verify your email for ${APP_NAME}`, html, text });
}

export async function sendPasswordResetEmail(mailer: Mailer, to: string, link: string): Promise<void> {
  const { html, text } = layout(`Reset your ${APP_NAME} password`, "Use the button below to choose a new password.", "Reset password", link, "This link expires in 1 hour.");
  await mailer.send({ to, subject: `Reset your ${APP_NAME} password`, html, text });
}
