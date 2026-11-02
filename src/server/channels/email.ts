import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { systemClock, type Clock } from '../engine/clock.js';
import { MICROSOFT_HOSTS, PROVIDER_PRESETS, bouncedRecipient, failedRecipients, isBounce, isConnectionError, mapSmtpError, stripQuoted } from './email-parse.js';
import { OAuthError, refreshAccessToken as defaultRefresh, type TokenSet } from './microsoft-oauth.js';
import { ConnectError, type ChannelAdapter, type ChannelError, type InboundEvent, type OutboundMessage, type SendResult } from './types.js';

/** The part of an IMAP client the adapter uses. `ImapFlow` satisfies it. */
export interface ImapMessage {
  uid: number;
  internalDate?: Date | string;
  source?: Buffer;
  envelope?: {
    messageId?: string;
    from?: Array<{ address?: string }>;
    to?: Array<{ address?: string }>;
    cc?: Array<{ address?: string }>;
  };
}
export interface ImapLike {
  /** The open mailbox; imapflow sets it while a mailbox lock is held. */
  readonly mailbox?: boolean | { uidValidity?: bigint | number };
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
  auth: { user: string; pass: string } | { user: string; accessToken: string };
}
export interface EmailDeps {
  createTransport?: typeof nodemailer.createTransport;
  createImap?: (cfg: ImapConfig) => ImapLike;
  clock?: Clock;
  /** Trades a Microsoft refresh token for a new access token. Defaults to the real endpoint. */
  refreshAccessToken?: (clientId: string, refreshToken: string) => Promise<TokenSet>;
  /** Called with the full secret when Microsoft rotates the tokens, so the owner can store it. */
  onSecretChange?: (secret: Record<string, string>) => void;
}

interface OAuthState {
  clientId: string;
  refreshToken: string;
  accessToken: string | null;
  /** Epoch milliseconds; 0 when there is no access token. */
  expiresAtMs: number;
}
interface MailConfig {
  provider: 'google' | 'microsoft' | 'custom';
  address: string;
  name: string;
  /** Empty for Microsoft, which signs in with OAuth2. */
  password: string;
  username: string;
  oauth: OAuthState | null;
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
// A message can reach the mailbox after the previous poll started; look back this far and rely on de-duplication.
const SINCE_MARGIN_MS = 15 * 60_000;
const TOKEN_MARGIN_MS = 60_000;
const KNOWN_LIMIT = 2000;
const BATCH = 50;
// Enough for the text of a reply or a delivery-status report; attachments past this are cut off.
const SOURCE_CAP = 256 * 1024;
const MICROSOFT_LOGIN_HOST = 'login.microsoftonline.com';

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
  const provider = input.provider;
  if (provider !== 'google' && provider !== 'microsoft' && provider !== 'custom') {
    throw new ConnectError('Pick Google, Microsoft or another mail provider.');
  }
  const name = (input.name ?? '').trim() || address;

  if (provider === 'microsoft') {
    const clientId = (input.clientId ?? '').trim();
    const refreshToken = input.refreshToken ?? '';
    if (!clientId || !refreshToken) throw new ConnectError(`Sign in to ${address} with Microsoft first.`);
    const expiresAtMs = Date.parse(input.accessTokenExpiresAt ?? '');
    return {
      provider, address, name, password: '', username: address,
      oauth: { clientId, refreshToken, accessToken: input.accessToken || null, expiresAtMs: Number.isNaN(expiresAtMs) ? 0 : expiresAtMs },
      ...MICROSOFT_HOSTS,
      imapSecure: MICROSOFT_HOSTS.imapPort === 993,
    };
  }

  const password = input.password ?? '';
  if (!password) throw new ConnectError(`Add the app password for ${address}.`);
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
    name,
    password,
    username: (input.username ?? '').trim() || address,
    oauth: null,
    smtpHost,
    smtpPort,
    smtpSecure: flag(input.smtpSecure, base && !input.smtpPort ? base.smtpSecure : smtpPort === 465),
    imapHost,
    imapPort,
    imapSecure: flag(input.imapSecure, imapPort === 993),
  };
}

function toSecret(cfg: MailConfig): Record<string, string> {
  if (cfg.oauth) {
    const { clientId, refreshToken, accessToken, expiresAtMs } = cfg.oauth;
    return {
      provider: cfg.provider,
      address: cfg.address,
      name: cfg.name,
      clientId,
      refreshToken,
      ...(accessToken ? { accessToken, accessTokenExpiresAt: new Date(expiresAtMs).toISOString() } : {}),
    };
  }
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

function smtpOptions(cfg: MailConfig, accessToken: string | null): Parameters<typeof nodemailer.createTransport>[0] {
  const tls = cfg.smtpSecure ? {} : isLocal(cfg.smtpHost) ? { ignoreTLS: true } : { requireTLS: true };
  return {
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: accessToken ? { type: 'OAuth2', user: cfg.username, accessToken } : { user: cfg.username, pass: cfg.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...tls,
  };
}

function imapConfig(cfg: MailConfig, accessToken: string | null): ImapConfig {
  return {
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapSecure,
    doSTARTTLS: !cfg.imapSecure && !isLocal(cfg.imapHost),
    auth: accessToken ? { user: cfg.username, accessToken } : { user: cfg.username, pass: cfg.password },
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
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  // ImapFlow raises 'error' events for dropped sockets; without a listener Node would exit.
  client.on('error', () => {});
  return client as unknown as ImapLike;
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

function uidValidity(imap: ImapLike): string {
  const box = imap.mailbox;
  return String(box && typeof box === 'object' ? (box.uidValidity ?? 0) : 0);
}

const DELAY_NOTICE = /\bdelay(?:ed)?\b|will (?:keep|continue) (?:trying|retrying)|still trying/i;

export function createEmailAdapter(secret: Record<string, string> | null, deps: EmailDeps = {}): ChannelAdapter {
  const createTransport = deps.createTransport ?? nodemailer.createTransport;
  const createImap = deps.createImap ?? defaultCreateImap;
  const clock = deps.clock ?? systemClock;
  const refreshTokens = deps.refreshAccessToken ?? ((clientId: string, refreshToken: string) => defaultRefresh(clientId, refreshToken, { clock }));

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
  let transporterToken: string | null = null;
  let refreshing: Promise<void> | null = null;
  // Messages already reported by this adapter instance (polls overlap by design).
  const seen = new Set<string>();
  // Message-IDs of mail this instance sent, so they are not mistaken for mail the user wrote by hand.
  const sentIds = new Set<string>();

  function requireConfig(): MailConfig {
    if (config) return config;
    throw configError ?? new ConnectError('auth');
  }

  /** The OAuth access token, refreshed first when it is missing, about to expire or `force` is set. Null for password logins. */
  async function accessToken(cfg: MailConfig, opts: { force?: boolean; notify?: boolean } = {}): Promise<string | null> {
    const oauth = cfg.oauth;
    if (!oauth) return null;
    const good = oauth.accessToken !== null && oauth.expiresAtMs - clock.now().getTime() > TOKEN_MARGIN_MS;
    if (good && !opts.force) return oauth.accessToken;
    refreshing ??= (async () => {
      try {
        const next = await refreshTokens(oauth.clientId, oauth.refreshToken);
        oauth.accessToken = next.accessToken;
        oauth.refreshToken = next.refreshToken;
        oauth.expiresAtMs = Date.parse(next.expiresAt);
        // Microsoft rotates refresh tokens; whoever stores the secret must keep the new one.
        if (opts.notify !== false) deps.onSecretChange?.(toSecret(cfg));
      } finally {
        refreshing = null;
      }
    })();
    await refreshing;
    return oauth.accessToken;
  }

  async function smtp(cfg: MailConfig, force = false) {
    const token = await accessToken(cfg, { force });
    if (!transporter || transporterToken !== token) {
      transporter?.close();
      transporter = createTransport(smtpOptions(cfg, token));
      transporterToken = token;
    }
    return transporter;
  }

  async function withImap<T>(cfg: MailConfig, fn: (imap: ImapLike) => Promise<T>, notify = true): Promise<T> {
    let force = false;
    for (;;) {
      let token: string | null;
      try {
        token = await accessToken(cfg, { force, notify });
      } catch (err) {
        throw err instanceof OAuthError ? new ConnectError('auth') : err;
      }
      const imap = createImap(imapConfig(cfg, token));
      try {
        await imap.connect();
      } catch (err) {
        if (!isImapAuthFailure(err)) throw err;
        // An OAuth token can be revoked early; try one fresh one before calling it a sign-out.
        if (cfg.oauth && !force) {
          force = true;
          continue;
        }
        throw new ConnectError('auth');
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
  }

  async function inInbox(imap: ImapLike, cfg: MailConfig, cutoff: Date, now: Date, events: InboundEvent[]): Promise<void> {
    const own = cfg.address.toLowerCase();
    const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
    try {
      const validity = uidValidity(imap);
      // IMAP SINCE compares dates only, so ask a day early and filter exactly below.
      const uids = (await imap.search({ since: new Date(cutoff.getTime() - DAY_MS) }, { uid: true })) || [];

      // Pass 1 reads envelopes only, which is cheap. Bodies are downloaded just for what is new.
      const fresh = new Map<number, { key: string; at: Date; messageId: string | null }>();
      for await (const msg of fetchByUid(imap, uids, { uid: true, internalDate: true, envelope: true })) {
        const at = toDate(msg.internalDate, now);
        if (at.getTime() < cutoff.getTime()) continue;
        const messageId = msg.envelope?.messageId ?? null;
        const key = messageId ?? `inbox:${validity}:${msg.uid}`;
        if (seen.has(key)) continue;
        if (msg.envelope?.from?.[0]?.address?.trim().toLowerCase() === own) {
          seen.add(key);
          continue;
        }
        fresh.set(msg.uid, { key, at, messageId });
      }

      for await (const msg of fetchByUid(imap, [...fresh.keys()], { uid: true, source: { maxLength: SOURCE_CAP } })) {
        const meta = fresh.get(msg.uid);
        if (!meta || !msg.source) continue;
        seen.add(meta.key);
        const parsed = await simpleParser(msg.source);
        const sender = parsed.from?.value[0];
        const email = sender?.address?.trim().toLowerCase();
        if (!email || email === own) continue;
        const externalId = parsed.messageId ?? meta.messageId;
        const at = meta.at.toISOString();

        const contentType = parsed.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
        const reportType = contentType?.params?.['report-type'];
        const contentTypeText = contentType?.value ? `${contentType.value}${reportType ? `; report-type=${reportType}` : ''}` : null;
        if (isBounce(email, contentTypeText, parsed.subject ?? null)) {
          for (const bounced of bouncedAddresses(parsed, msg.source, own)) events.push({ type: 'bounce', email: bounced, at, externalId });
          continue;
        }
        events.push({
          type: 'reply',
          from: { email, ...(sender?.name ? { name: sender.name } : {}) },
          text: stripQuoted(parsed.text ?? ''),
          at,
          externalId,
        });
      }
    } finally {
      lock.release();
    }
  }

  async function inSent(imap: ImapLike, cfg: MailConfig, cutoff: Date, now: Date, events: InboundEvent[]): Promise<void> {
    const path = await findSentMailbox(imap);
    if (!path) return;
    const own = cfg.address.toLowerCase();
    const lock = await imap.getMailboxLock(path, { readOnly: true });
    try {
      const uids = (await imap.search({ since: new Date(cutoff.getTime() - DAY_MS) }, { uid: true })) || [];
      for await (const msg of fetchByUid(imap, uids, { uid: true, internalDate: true, envelope: true })) {
        const at = toDate(msg.internalDate, now);
        if (at.getTime() < cutoff.getTime()) continue;
        const messageId = msg.envelope?.messageId ?? null;
        // Mail Callum sent shows up in Sent too; only mail the user wrote themselves counts.
        if (messageId && sentIds.has(messageId)) continue;
        for (const email of recipients(msg)) {
          if (email === own) continue;
          const key = `sent:${messageId ?? msg.uid}:${email}`;
          if (seen.has(key)) continue;
          seen.add(key);
          events.push({ type: 'outbound_seen', email, at: at.toISOString(), externalId: messageId });
        }
      }
    } finally {
      lock.release();
    }
  }

  function reach(host: string): ConnectError {
    return new ConnectError(`Couldn't reach ${host}. Check the server name and port.`);
  }

  function refreshFailure(err: unknown): ChannelError {
    if (err instanceof OAuthError) return { code: 'auth', message: err.message };
    return { code: 'temporary', message: err instanceof Error ? err.message : 'Could not reach Microsoft sign-in.' };
  }

  return {
    channel: 'email',

    async connect(input) {
      const cfg = parseConfig(input);
      // Microsoft signs in with a device code, not a password, so its message tells the person to sign in again.
      const signIn = new ConnectError(
        cfg.oauth
          ? `Couldn't sign in to ${cfg.address}. Sign in with Microsoft again.`
          : cfg.provider === 'google'
            ? "Google didn't accept that password. App passwords are 16 letters, with no spaces."
            : "Your mail server didn't accept that password. Check the password and both server names.",
      );
      let token: string | null;
      try {
        token = await accessToken(cfg, { notify: false });
      } catch (err) {
        throw err instanceof OAuthError ? signIn : reach(MICROSOFT_LOGIN_HOST);
      }
      const probe = createTransport(smtpOptions(cfg, token));
      try {
        await probe.verify();
      } catch (err) {
        probe.close();
        throw isConnectionError(err) ? reach(cfg.smtpHost) : signIn;
      }
      try {
        await withImap(cfg, async () => undefined, false);
      } catch (err) {
        probe.close();
        if (isConnectionError(err)) throw reach(cfg.imapHost);
        throw signIn;
      }
      transporter?.close();
      transporter = probe;
      transporterToken = token;
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
      const mail = {
        from: `${quoteName(cfg.name)} <${cfg.address}>`,
        to: `${quoteName(msg.to.name)} <${to}>`,
        subject: msg.subject ?? '',
        text: msg.body,
        headers: { 'List-Unsubscribe': `<mailto:${cfg.address}?subject=stop>` },
        ...(msg.inReplyTo ? { inReplyTo: bracket(msg.inReplyTo), references: bracket(msg.inReplyTo) } : {}),
      };
      for (let attempt = 0; ; attempt++) {
        let transport: Awaited<ReturnType<typeof smtp>>;
        try {
          transport = await smtp(cfg, attempt > 0);
        } catch (err) {
          return { ok: false, error: refreshFailure(err) };
        }
        try {
          const info = await transport.sendMail(mail);
          if ((info.rejected ?? []).length > 0) {
            return { ok: false, error: { code: 'invalid_recipient', message: `${to} was rejected by the mail server.` } };
          }
          if (info.messageId) sentIds.add(info.messageId);
          return { ok: true, externalId: info.messageId ?? null };
        } catch (err) {
          const error = mapSmtpError(err);
          // An OAuth token can be revoked early; try one fresh one before reporting a sign-out.
          if (error.code === 'auth' && cfg.oauth && attempt === 0) continue;
          return { ok: false, error };
        }
      }
    },

    async poll(since) {
      const cfg = requireConfig();
      const now = clock.now();
      const cutoff = new Date((since ?? new Date(now.getTime() - LOOKBACK_MS)).getTime() - SINCE_MARGIN_MS);
      return withImap(cfg, async (imap) => {
        const events: InboundEvent[] = [];
        await inInbox(imap, cfg, cutoff, now, events);
        await inSent(imap, cfg, cutoff, now, events);
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
      transporterToken = null;
    },
  };
}

/** Recipients a bounce message reports as undeliverable. A delay notice reports none. */
function bouncedAddresses(parsed: ParsedMail, source: Buffer, own: string): string[] {
  const attached = parsed.attachments.filter((a) => /^message\/delivery-status/i.test(a.contentType)).map((a) => a.content.toString('utf8')).join('\n\n');
  const raw = source.toString('utf8');
  const report = attached || (/message\/delivery-status/i.test(raw) ? raw : '');
  if (/(?:Final|Original)-Recipient:/i.test(report)) return failedRecipients(report);
  // A plain-text notice has no status report: skip delay warnings, otherwise take the address it names.
  const text = parsed.text ?? '';
  if (DELAY_NOTICE.test(`${parsed.subject ?? ''}\n${text}`)) return [];
  const bounced = bouncedRecipient(text, own);
  return bounced ? [bounced] : [];
}
