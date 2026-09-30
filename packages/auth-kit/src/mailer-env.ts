import type { MailerConfig } from './mailer.js';

export function getMailerConfigFromEnv(env: Record<string, string | undefined> = process.env): MailerConfig {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
  };
}
