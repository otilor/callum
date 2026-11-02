import type { ChannelError } from './types.js';

export interface ProviderPreset {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
}

export const PROVIDER_PRESETS: Record<'google' | 'microsoft', ProviderPreset> = {
  google: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.gmail.com', imapPort: 993 },
  microsoft: { smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false, imapHost: 'outlook.office365.com', imapPort: 993 },
};

const ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;
const GMAIL_HEADER = /^On\s.*\bwrote:\s*$/;
const GMAIL_HEADER_START = /^On\s.*(\d|@)/;
const OUTLOOK_FROM = /^From:\s/i;
const OUTLOOK_SENT = /^(Sent|Date):\s/i;
const SEPARATOR = /^\s*_{3,}\s*$/;

/**
 * Drops the quoted history from a reply. Everything from the first "On ... wrote:",
 * "-----Original Message-----" or Outlook From/Sent header block is removed, and so is
 * every line that starts with ">".
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const next = (lines[i + 1] ?? '').trim();
    const startsQuote =
      ORIGINAL_MESSAGE.test(line) ||
      GMAIL_HEADER.test(line.trim()) ||
      (GMAIL_HEADER_START.test(line.trim()) && /^(\S.*\s)?wrote:$/.test(next)) ||
      (OUTLOOK_FROM.test(line) && [1, 2, 3].some((n) => OUTLOOK_SENT.test(lines[i + n] ?? '')));
    if (startsQuote) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  while (kept.length > 0 && (SEPARATOR.test(kept[kept.length - 1] ?? '') || (kept[kept.length - 1] ?? '').trim() === '')) kept.pop();
  return kept.join('\n').trim();
}

const DAEMON = /(mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT = /^\s*(undeliverable|undelivered mail returned to sender|mail delivery failed|delivery status notification|returned mail|failure notice)/i;

export function isBounce(from: string, contentType: string | null, subject: string | null): boolean {
  if (DAEMON.test(from) || /mail delivery subsystem/i.test(from)) return true;
  if (contentType && /multipart\/report/i.test(contentType) && !/report-type\s*=\s*"?disposition-notification/i.test(contentType)) return true;
  if (subject && BOUNCE_SUBJECT.test(subject)) return true;
  return false;
}

const ADDRESS = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

function recipientHeader(text: string, name: 'Final' | 'Original'): string | null {
  const re = new RegExp(`^${name}-Recipient:[^;\\n]*;\\s*<?([^\\s<>;]+@[^\\s<>;]+?)>?\\s*$`, 'im');
  return re.exec(text)?.[1]?.toLowerCase() ?? null;
}

/** The address a bounce is about. `sender` is excluded from the free-text fallback. */
export function bouncedRecipient(text: string, sender?: string): string | null {
  const fromHeaders = recipientHeader(text, 'Final') ?? recipientHeader(text, 'Original');
  if (fromHeaders) return fromHeaders;
  const skip = sender?.toLowerCase();
  for (const match of text.matchAll(ADDRESS)) {
    const address = match[0].toLowerCase();
    if (DAEMON.test(address) || address === skip) continue;
    return address;
  }
  return null;
}

/** Maps an nodemailer error to a ChannelError. */
export function mapSmtpError(err: unknown): ChannelError {
  const obj = typeof err === 'object' && err !== null ? (err as { code?: unknown; responseCode?: unknown; response?: unknown; message?: unknown }) : {};
  const message = typeof err === 'string' ? err : typeof obj.message === 'string' && obj.message ? obj.message : 'Unknown mail error';
  const code = typeof obj.code === 'string' ? obj.code : '';
  let status = typeof obj.responseCode === 'number' ? obj.responseCode : 0;
  if (!status && typeof obj.response === 'string') status = Number(/^\d{3}/.exec(obj.response)?.[0] ?? 0);

  if (code === 'EAUTH' || status === 530 || status === 534 || status === 535) return { code: 'auth', message };
  if (status === 550 || status === 551 || status === 553) return { code: 'invalid_recipient', message };
  if (
    [421, 450, 451, 452].includes(status) ||
    ['ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(code)
  ) {
    return { code: 'temporary', message };
  }
  return { code: 'unknown', message };
}
