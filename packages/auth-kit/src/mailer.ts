import nodemailer, { type Transporter } from 'nodemailer';

export interface MailerConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
}

export interface MailerMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface Mailer {
  isConfigured(): boolean;
  verifyConnection(): Promise<void>;
  send(message: MailerMessage): Promise<void>;
  isAuthError(err: unknown): boolean;
  formatError(err: unknown): string;
}

interface SmtpError {
  code?: unknown;
  response?: unknown;
  responseCode?: unknown;
  command?: unknown;
  message?: unknown;
}

function isAuthError(err: unknown): boolean {
  const smtpErr = err as SmtpError;
  return smtpErr?.code === 'EAUTH' || smtpErr?.responseCode === 535;
}

function formatError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);

  const smtpErr = err as SmtpError;
  const code = typeof smtpErr.code === 'string' ? smtpErr.code : undefined;
  const responseCode = typeof smtpErr.responseCode === 'number' ? smtpErr.responseCode : undefined;
  const response = typeof smtpErr.response === 'string' ? smtpErr.response : undefined;
  const command = typeof smtpErr.command === 'string' ? smtpErr.command : undefined;
  const message = typeof smtpErr.message === 'string' ? smtpErr.message : undefined;

  if (isAuthError(err)) {
    return `SMTP authentication failed${responseCode ? ` (${responseCode})` : ''}${response ? `: ${response}` : ''}`;
  }

  const parts = [
    code,
    responseCode ? String(responseCode) : undefined,
    command,
    response ?? message,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' ') : String(err);
}

/**
 * A generic SMTP-backed mailer with no hardcoded copy/branding — callers
 * build the subject/html/text themselves and pass it to `send()`. Driven
 * entirely by the config object, not `process.env` (see `mailer-env.ts` for
 * an optional env-var adapter).
 */
export function createMailer(config: MailerConfig): Mailer {
  let cachedTransport: Transporter | null = null;

  function transport(): Transporter {
    if (cachedTransport) return cachedTransport;
    cachedTransport = nodemailer.createTransport({
      host: config.host,
      port: config.port ?? 587,
      // secure=true for implicit TLS (port 465); otherwise STARTTLS (587).
      secure: config.secure ?? false,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    });
    return cachedTransport;
  }

  return {
    isConfigured(): boolean {
      return Boolean(config.host && config.from);
    },

    async verifyConnection(): Promise<void> {
      const missing: string[] = [];
      if (!config.host) missing.push('host');
      if (!config.from) missing.push('from');
      if (config.user && !config.pass) missing.push('pass');

      const port = config.port ?? 587;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('SMTP port must be a valid TCP port');
      }

      if (missing.length > 0) {
        throw new Error(`SMTP is not configured: missing ${missing.join(', ')}`);
      }

      await transport().verify();
    },

    async send(message: MailerMessage): Promise<void> {
      await transport().sendMail({ from: config.from, ...message });
    },

    isAuthError,
    formatError,
  };
}
