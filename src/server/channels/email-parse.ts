import type { ChannelError } from './types.js';

export interface ProviderPreset {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
}

/** App-password presets. Microsoft is absent on purpose: Exchange Online refuses app passwords, so it signs in with OAuth. */
export const PROVIDER_PRESETS: Record<'google', ProviderPreset> = {
  google: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.gmail.com', imapPort: 993 },
};

/** Microsoft's servers, used with OAuth2 (XOAUTH2) rather than a password. */
export const MICROSOFT_HOSTS: ProviderPreset = { smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false, imapHost: 'outlook.office365.com', imapPort: 993 };

const ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;
// Quote headers: "On <date> <name> wrote:" and its French, Spanish and Portuguese forms, where the verb is the
// last thing before the colon, and German "Am <date> schrieb <name>:", where the name follows the verb.
// A sentence such as "On Friday I wrote up three options:" has more words after the verb, so it never matches.
const VERB_LAST = '(?:wrote|a écrit|à écrit|escribió|escreveu)\\s?:';
const HEADER_OPENER = '(?:On|Le|Am|El|Em)\\s';
const QUOTE_HEADER = new RegExp(`^${HEADER_OPENER}[^\\n]{0,250}?(?<!\\b(?:I|we|We))\\s${VERB_LAST}\\s*$`);
// German: a date or address, then "schrieb", then the sender (an address, or a short capitalised name).
const QUOTE_HEADER_DE = /^Am\s(?=[^\n]*(?:\d|@))[^\n]{0,200}?\sschrieb\s+(?:[^\n]{0,120}<[^\n<>]+>|[A-ZÄÖÜ][^\s:]*(?:\s+[A-ZÄÖÜ][^\s:]*){0,3})\s*:\s*$/;
const QUOTE_HEADER_START = /^(?:On|Le|Am|El|Em)\s.*(\d|@)/;
// The second line of a wrapped header: the verb alone, or an address and then the verb, or German "schrieb <name>:".
const QUOTE_HEADER_END = new RegExp(`^(?:${VERB_LAST}|(?:[^\\n]*[<@][^\\n]*\\s)?${VERB_LAST})$|^schrieb\\s+[^\\n]{1,120}:$`);
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
      QUOTE_HEADER.test(line.trim()) ||
      QUOTE_HEADER_DE.test(line.trim()) ||
      (QUOTE_HEADER_START.test(line.trim()) && QUOTE_HEADER_END.test(next)) ||
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

/**
 * The recipients a delivery-status report says failed. A block counts when its Action is
 * "failed", or its Status is 5.x.x and the Action is not delayed, delivered, relayed or expanded.
 */
export function failedRecipients(deliveryStatus: string): string[] {
  const failed: string[] = [];
  for (const block of deliveryStatus.split(/\r?\n[ \t]*\r?\n/)) {
    const recipient = recipientHeader(block, 'Final') ?? recipientHeader(block, 'Original');
    if (!recipient) continue;
    const action = /^Action:\s*(\S+)/im.exec(block)?.[1]?.toLowerCase() ?? '';
    const status = /^Status:\s*(\d)\.\d+\.\d+/im.exec(block)?.[1];
    if (['delayed', 'delivered', 'relayed', 'expanded'].includes(action)) continue;
    if ((action === 'failed' || status === '5') && !failed.includes(recipient)) failed.push(recipient);
  }
  return failed;
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

const CONNECTION_CODES = [
  'ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET', 'EDNS', 'ENOTFOUND', 'EHOSTUNREACH', 'EPROTOCOL', 'ETLS',
  'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ETIMEOUT', 'NoConnection', 'ClosedAfterConnectTLS', 'ClosedAfterConnectText',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
];

/** True for errors about reaching the server or negotiating TLS, as opposed to being refused. */
export function isConnectionError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '';
  return CONNECTION_CODES.includes(code) || code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS');
}

// Failures that can only happen before the message was handed over (DATA): the server was never reached, or the secure
// connection was never set up. Anything that breaks later, or cannot say when, may have left the message half sent.
const NEVER_REACHED = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'];
const SETUP_ONLY = ['EDNS', 'ETLS', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];

/** True when the failure certainly came before the message body was sent, so trying again cannot double it. */
export function failedBeforeData(err: unknown): boolean {
  const o = typeof err === 'object' && err !== null ? (err as { code?: unknown; originalCode?: unknown; timeoutType?: unknown }) : {};
  const code = typeof o.code === 'string' ? o.code : '';
  const original = typeof o.originalCode === 'string' ? o.originalCode : '';
  const timeout = typeof o.timeoutType === 'string' ? o.timeoutType : '';
  if (SETUP_ONLY.includes(code) || SETUP_ONLY.includes(timeout) || code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS')) return true;
  return NEVER_REACHED.includes(code) || NEVER_REACHED.includes(original);
}

/** Maps a nodemailer error to a ChannelError, using the SMTP reply code and its enhanced status (RFC 3463). */
export function mapSmtpError(err: unknown): ChannelError {
  const obj = typeof err === 'object' && err !== null ? (err as { code?: unknown; responseCode?: unknown; response?: unknown; message?: unknown }) : {};
  const message = typeof err === 'string' ? err : typeof obj.message === 'string' && obj.message ? obj.message : 'Unknown mail error';
  const code = typeof obj.code === 'string' ? obj.code : '';
  const response = typeof obj.response === 'string' ? obj.response : '';
  let status = typeof obj.responseCode === 'number' ? obj.responseCode : 0;
  if (!status) status = Number(/^\d{3}/.exec(response)?.[0] ?? 0);
  const enhanced = /\b\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/.exec(response)?.[1] ?? /\b\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/.exec(message)?.[1] ?? '';
  const detail = `${response} ${message}`;

  if (code === 'EAUTH' || status === 530 || status === 534 || status === 535) return { code: 'auth', message };
  // The sending account is blocked or refused (policy, sender reputation, basic auth switched off).
  if (/^5\.7\./.test(enhanced) || enhanced === '5.1.8') return { code: 'auth', message };
  if (enhanced === '5.4.5' || enhanced === '4.5.3' || /daily user sending (?:limit|quota)/i.test(detail) || (/^5\.5\./.test(enhanced) && /quota|limit|exceed/i.test(detail))) {
    return { code: 'rate_limit', message };
  }
  if (/^5\.1\./.test(enhanced) || [550, 551, 553].includes(status)) return { code: 'invalid_recipient', message };
  // The server answered no: the message was not accepted, so trying again is safe.
  if ([421, 450, 451, 452].includes(status) || failedBeforeData(err)) return { code: 'temporary', message };
  // A dropped connection or a timeout with no answer: the message may have been accepted, so it is not sent again on its own.
  return { code: 'unknown', message };
}
