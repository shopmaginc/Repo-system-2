import nodemailer from 'nodemailer';

/**
 * SMTP email delivery via environment config.
 *
 * Required env vars:
 *   SMTP_HOST — e.g. live.smtp.mailtrap.io
 *   SMTP_PORT — e.g. 587
 *   SMTP_USER — e.g. api
 *   SMTP_PASS — API token / password
 *
 * Optional:
 *   SMTP_FROM — default sender address (e.g. noreply@tfsrecovery.com)
 *   SMTP_SECURE — "true" to force TLS (port 465); otherwise STARTTLS
 */

export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

export function getEmailConfig(): EmailConfig | null {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port,
    user,
    pass,
    from: process.env.SMTP_FROM || 'noreply@tfsrecovery.com',
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
  };
}

export function isSmtpConfigured(): boolean {
  return getEmailConfig() !== null;
}

export interface SendEmailOptions {
  to: string;
  cc?: string | null;
  subject: string;
  body: string; // plain text; HTML derived by escaping
  from?: string;
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<div style="font-family: sans-serif; white-space: pre-wrap;">${escaped}</div>`;
}

/**
 * Send an email via the configured SMTP transport.
 * Returns the transport message ID on success.
 * Throws on failure — callers should catch and record the failure.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<string> {
  const cfg = getEmailConfig();
  if (!cfg) {
    throw new Error('SMTP is not configured (SMTP_HOST/PORT/USER/PASS)');
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  const info = await transporter.sendMail({
    from: opts.from || cfg.from,
    to: opts.to,
    cc: opts.cc || undefined,
    subject: opts.subject,
    text: opts.body,
    html: textToHtml(opts.body),
  });
  return info.messageId || 'sent';
}
