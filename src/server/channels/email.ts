import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { systemClock, type Clock } from '../engine/clock.js';
import { PROVIDER_PRESETS, bouncedRecipient, isBounce, mapSmtpError, stripQuoted } from './email-parse.js';
import { ConnectError, type ChannelAdapter, type InboundEvent, type OutboundMessage, type SendResult } from './types.js';

/** The part of an IMAP client the adapter uses. `ImapFlow` satisfies it. */
export interface ImapMessage {
  uid: number;
  internalDate?: Date | string;
  source?: Buffer;
  headers?: Buffer;
  envelope?: {
    messageId?: string;
    to?: Array<{ address?: string }>;
    cc?: Array<{ address?: string }>;
  };
}
export interface ImapLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<Array<{ path: string; specialUse?: string }>>;
  getMailboxLock(path: string, opts?: { readOnly?: boolean }): Promise<{ release(): void }>;
  search(query: { since?: Date; all?: boolean }, opts?: { uid?: boolean }): Promise<number[] | false>;
  fetch(range: string, query: Record<string, unknown>, opts?: { uid?: boolean }): AsyncIterable<ImapMessage>;
}
export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  /** Upgrade a plain connection with STARTTLS. False only for local test servers. */
  doSTARTTLS: boolean;
  auth: { user: string; pass: string };
}
export interface EmailDeps {
  createTransport?: typeof nodemailer.createTransport;
  createImap?: (cfg: ImapConfig) => ImapLike;
  clock?: Clock;
}

interface MailConfig {
  provider: 'google' | 'microsoft' | 'custom';
  address: string;
  name: string;
  password: string;
  username: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
}

const SENT_NAMES = ['Sent', 'Sent Items', 'Sent Messages', '[Gmail]/Sent Mail'];
const LOOKBACK_MS = 3 * 86_400_000;
const DAY_MS = 86_400_000;
const KNOWN_LIMIT = 2000;
const BATCH = 50;
const SENT_MARKER_HEADER = 'X-Callum';
const NETWORK_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ECONNECTION', 'ETIMEDOUT', 'ETIMEOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND', 'EHOSTUNREACH', 'NoConnection'];

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function parsePort(value: string | undefined, address: string): number {
  const port = Number(value);
  if (!value || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectError(`Add the mail server and port for ${address}.`);
  }
  return port;
}

function parseConfig(input: Record<string, string>): MailConfig {
  const address = (input.address ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new ConnectError('Add the email address to send from.');
  const password = input.password ?? '';
  if (!password) throw new ConnectError(`Add the app password for ${address}.`);
  const provider = input.provider;
  if (provider !== 'google' && provider !== 'microsoft' && provider !== 'custom') {
    throw new ConnectError('Pick Google, Microsoft or another mail provider.');
  }
  const base = provider === 'custom' ? null : PROVIDER_PRESETS[provider];
  const smtpHost = (input.smtpHost || base?.smtpHost || '').trim();
  const imapHost = (input.imapHost || base?.imapHost || '').trim();
  if (!smtpHost || !imapHost) throw new ConnectError(`Add the mail server and port for ${address}.`);
  const smtpPort = base && !input.smtpPort ? base.smtpPort : parsePort(input.smtpPort, address);
  const imapPort = base && !input.imapPort ? base.imapPort : parsePort(input.imapPort, address);
  const flag = (value: string | undefined, fallback: boolean) => (value === 'true' ? true : value === 'false' ? false : fallback);
  return {
    provider,
    address,
    name: (input.name ?? '').trim() || address,
    password,
    username: (input.username ?? '').trim() || address,
    smtpHost,
    smtpPort,
    smtpSecure: flag(input.smtpSecure, base && !input.smtpPort ? base.smtpSecure : smtpPort === 465),
    imapHost,
    imapPort,
    imapSecure: flag(input.imapSecure, imapPort === 993),
  };
}

function toSecret(cfg: MailConfig): Record<string, string> {
  return {
    provider: cfg.provider,
    address: cfg.address,
    name: cfg.name,
    password: cfg.password,
    username: cfg.username,
    smtpHost: cfg.smtpHost,
    smtpPort: String(cfg.smtpPort),
    smtpSecure: String(cfg.smtpSecure),
    imapHost: cfg.imapHost,
    imapPort: String(cfg.imapPort),
    imapSecure: String(cfg.imapSecure),
  };
}

function smtpOptions(cfg: MailConfig): Parameters<typeof nodemailer.createTransport>[0] {
  const tls = cfg.smtpSecure ? {} : isLocal(cfg.smtpHost) ? { ignoreTLS: true } : { requireTLS: true };
  return {
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...tls,
  };
}

function imapConfig(cfg: MailConfig): ImapConfig {
  return {
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapSecure,
    doSTARTTLS: !cfg.imapSecure && !isLocal(cfg.imapHost),
    auth: { user: cfg.username, pass: cfg.password },
  };
}

function defaultCreateImap(cfg: ImapConfig): ImapLike {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    doSTARTTLS: cfg.secure ? undefined : cfg.doSTARTTLS,
    auth: cfg.auth,
    logger: false,
    socketTimeout: 60_000,
  });
  // ImapFlow raises 'error' events for dropped sockets; without a listener Node would exit.
  client.on('error', () => {});
  return client as unknown as ImapLike;
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '';
}

function isImapAuthFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { authenticationFailed?: unknown }).authenticationFailed === true;
}

function quoteName(name: string): string {
  return `"${name.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ')}"`;
}

function bracket(id: string): string {
  return id.startsWith('<') ? id : `<${id}>`;
}

function toDate(value: Date | string | undefined, fallback: Date): Date {
  const date = value instanceof Date ? value : value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function recipients(msg: ImapMessage): string[] {
  const all = [...(msg.envelope?.to ?? []), ...(msg.envelope?.cc ?? [])];
  return [...new Set(all.flatMap((a) => (a.address ? [a.address.trim().toLowerCase()] : [])))];
}

async function findSentMailbox(imap: ImapLike): Promise<string | null> {
  const boxes = await imap.list();
  const special = boxes.find((b) => b.specialUse === '\\Sent');
  if (special) return special.path;
  for (const name of SENT_NAMES) {
    const match = boxes.find((b) => b.path.toLowerCase() === name.toLowerCase());
    if (match) return match.path;
  }
  return null;
}

/** Fetches the messages with the given uids in small batches, in uid order. */
async function* fetchByUid(imap: ImapLike, uids: number[], query: Record<string, unknown>): AsyncGenerator<ImapMessage> {
  const sorted = [...uids].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += BATCH) {
    yield* imap.fetch(sorted.slice(i, i + BATCH).join(','), query, { uid: true });
  }
}

export function createEmailAdapter(secret: Record<string, string> | null, deps: EmailDeps = {}): ChannelAdapter {
  const createTransport = deps.createTransport ?? nodemailer.createTransport;
  const createImap = deps.createImap ?? defaultCreateImap;
  const clock = deps.clock ?? systemClock;

  let config: MailConfig | null = null;
  let configError: ConnectError | null = null;
  if (secret) {
    try {
      config = parseConfig(secret);
    } catch (err) {
      configError = err instanceof ConnectError ? err : new ConnectError('auth');
    }
  }
  let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
  // Inbound messages already reported by this adapter instance (polls overlap by design).
  const seen = new Set<string>();

  function requireConfig(): MailConfig {
    if (config) return config;
    throw configError ?? new ConnectError('auth');
  }

  function getTransporter(cfg: MailConfig) {
    transporter ??= createTransport(smtpOptions(cfg));
    return transporter;
  }

  async function withImap<T>(cfg: MailConfig, fn: (imap: ImapLike) => Promise<T>): Promise<T> {
    const imap = createImap(imapConfig(cfg));
    try {
      await imap.connect();
    } catch (err) {
      throw isImapAuthFailure(err) ? new ConnectError('auth') : err;
    }
    try {
      return await fn(imap);
    } finally {
      try {
        await imap.logout();
      } catch {
        // The server may already have closed the connection; there is nothing left to release.
      }
    }
  }

  async function inInbox(imap: ImapLike, cfg: MailConfig, from: Date, sinceMs: number, now: Date, events: InboundEvent[]): Promise<void> {
    const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
    try {
      // IMAP SINCE compares dates only, so ask a day early and filter exactly below.
      const uids = (await imap.search({ since: new Date(from.getTime() - DAY_MS) }, { uid: true })) || [];
      for await (const msg of fetchByUid(imap, uids, { uid: true, internalDate: true, envelope: true, source: true })) {
        const at = toDate(msg.internalDate, now);
        if (at.getTime() < sinceMs || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const key = parsed.messageId ?? msg.envelope?.messageId ?? `inbox:${msg.uid}`;
        if (seen.has(key)) continue;
        const sender = parsed.from?.value[0];
        const email = sender?.address?.trim().toLowerCase();
        if (!email || email === cfg.address.toLowerCase()) continue;
        seen.add(key);

        const contentType = parsed.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
        const reportType = contentType?.params?.['report-type'];
        const contentTypeText = contentType?.value ? `${contentType.value}${reportType ? `; report-type=${reportType}` : ''}` : null;
        if (isBounce(email, contentTypeText, parsed.subject ?? null)) {
          const text = [parsed.text ?? '', ...parsed.attachments.filter((a) => /^(text\/|message\/delivery-status)/i.test(a.contentType)).map((a) => a.content.toString('utf8'))].join('\n');
          const bounced = bouncedRecipient(text, cfg.address) ?? bouncedRecipient(msg.source.toString('utf8'), cfg.address);
          if (bounced) events.push({ type: 'bounce', email: bounced, at: at.toISOString() });
          continue;
        }
        events.push({
          type: 'reply',
          from: { email, ...(sender?.name ? { name: sender.name } : {}) },
          text: stripQuoted(parsed.text ?? ''),
          at: at.toISOString(),
          externalId: parsed.messageId ?? msg.envelope?.messageId ?? null,
        });
      }
    } finally {
      lock.release();
    }
  }

  async function inSent(imap: ImapLike, cfg: MailConfig, from: Date, sinceMs: number, now: Date, events: InboundEvent[]): Promise<void> {
    const path = await findSentMailbox(imap);
    if (!path) return;
    const own = cfg.address.toLowerCase();
    const lock = await imap.getMailboxLock(path, { readOnly: true });
    try {
      const uids = (await imap.search({ since: new Date(from.getTime() - DAY_MS) }, { uid: true })) || [];
      for await (const msg of fetchByUid(imap, uids, { uid: true, internalDate: true, envelope: true, headers: [SENT_MARKER_HEADER.toLowerCase()] })) {
        const at = toDate(msg.internalDate, now);
        if (at.getTime() < sinceMs) continue;
        // Mail that Callum sent itself carries a marker; only the user's own mail counts as seen.
        if (msg.headers && new RegExp(`^${SENT_MARKER_HEADER}:`, 'im').test(msg.headers.toString('utf8'))) continue;
        for (const email of recipients(msg)) {
          if (email === own) continue;
          const key = `sent:${msg.envelope?.messageId ?? msg.uid}:${email}`;
          if (seen.has(key)) continue;
          seen.add(key);
          events.push({ type: 'outbound_seen', email, at: at.toISOString() });
        }
      }
    } finally {
      lock.release();
    }
  }

  return {
    channel: 'email',

    async connect(input) {
      const cfg = parseConfig(input);
      const signIn = new ConnectError(`Couldn't sign in to ${cfg.address}. Check the app password.`);
      const probe = createTransport(smtpOptions(cfg));
      try {
        await probe.verify();
      } catch (err) {
        probe.close();
        throw NETWORK_CODES.includes(errorCode(err)) ? new ConnectError(`Couldn't reach ${cfg.smtpHost}. Check the server and port.`) : signIn;
      }
      try {
        await withImap(cfg, async () => undefined);
      } catch (err) {
        probe.close();
        if (NETWORK_CODES.includes(errorCode(err))) throw new ConnectError(`Couldn't reach ${cfg.imapHost}. Check the server and port.`);
        throw signIn;
      }
      transporter?.close();
      transporter = probe;
      config = cfg;
      configError = null;
      return { identity: cfg.address, secret: toSecret(cfg) };
    },

    async send(msg: OutboundMessage): Promise<SendResult> {
      let cfg: MailConfig;
      try {
        cfg = requireConfig();
      } catch (err) {
        return { ok: false, error: { code: 'auth', message: err instanceof Error ? err.message : 'auth' } };
      }
      const to = msg.to.email?.trim();
      if (!to) return { ok: false, error: { code: 'invalid_recipient', message: `${msg.to.name} has no email address.` } };
      try {
        const info = await getTransporter(cfg).sendMail({
          from: `${quoteName(cfg.name)} <${cfg.address}>`,
          to: `${quoteName(msg.to.name)} <${to}>`,
          subject: msg.subject ?? '',
          text: msg.body,
          headers: {
            'List-Unsubscribe': `<mailto:${cfg.address}?subject=stop>`,
            [SENT_MARKER_HEADER]: 'sent',
          },
          ...(msg.inReplyTo ? { inReplyTo: bracket(msg.inReplyTo), references: bracket(msg.inReplyTo) } : {}),
        });
        const rejected = (info.rejected ?? []).map(String);
        if (rejected.length > 0) {
          return { ok: false, error: { code: 'invalid_recipient', message: `${to} was rejected by the mail server.` } };
        }
        return { ok: true, externalId: info.messageId ?? null };
      } catch (err) {
        return { ok: false, error: mapSmtpError(err) };
      }
    },

    async poll(since) {
      const cfg = requireConfig();
      const now = clock.now();
      const from = since ?? new Date(now.getTime() - LOOKBACK_MS);
      return withImap(cfg, async (imap) => {
        const events: InboundEvent[] = [];
        await inInbox(imap, cfg, from, from.getTime(), now, events);
        await inSent(imap, cfg, from, from.getTime(), now, events);
        return events;
      });
    },

    async knownAddresses() {
      const cfg = requireConfig();
      return withImap(cfg, async (imap) => {
        const path = await findSentMailbox(imap);
        if (!path) return [];
        const own = cfg.address.toLowerCase();
        const lock = await imap.getMailboxLock(path, { readOnly: true });
        try {
          const uids = (await imap.search({ all: true }, { uid: true })) || [];
          const latest = [...uids].sort((a, b) => a - b).slice(-KNOWN_LIMIT);
          const known = new Set<string>();
          for await (const msg of fetchByUid(imap, latest, { uid: true, envelope: true })) {
            for (const email of recipients(msg)) if (email !== own) known.add(email);
          }
          return [...known];
        } finally {
          lock.release();
        }
      });
    },

    async close() {
      transporter?.close();
      transporter = null;
    },
  };
}
