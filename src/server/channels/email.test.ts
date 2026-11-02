import type nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { createEmailAdapter, type ImapConfig, type ImapLike, type ImapMessage } from './email.js';
import { OAuthError, type TokenSet } from './microsoft-oauth.js';
import { ConnectError, type OutboundMessage } from './types.js';

const INPUT = { provider: 'google', address: 'you@x.com', name: 'Gabriel Femi', password: 'app-password' };
const HELLO: OutboundMessage = {
  to: { name: 'Kemi Okoye', email: 'kemi@okopay.test', linkedinUrl: null, xHandle: null },
  kind: 'hello',
  subject: 'Hello from Gabriel',
  body: 'Hi Kemi',
  inReplyTo: null,
};

type CreateTransport = typeof nodemailer.createTransport;

function fakeTransport(opts: { verify?: () => Promise<unknown>; sendMail?: (m: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}) {
  const sendMail = vi.fn(opts.sendMail ?? (async () => ({ messageId: '<abc@x.com>', rejected: [] })));
  const verify = vi.fn(opts.verify ?? (async () => true));
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ verify, sendMail, close })) as unknown as CreateTransport & ReturnType<typeof vi.fn>;
  return { createTransport, sendMail, verify, close };
}

interface FakeMessage {
  uid: number;
  internalDate: string;
  source?: string;
  messageId?: string;
  from?: string;
  to?: string[];
  cc?: string[];
}
interface FakeBox { path: string; specialUse?: string; messages: FakeMessage[] }

function fakeImap(boxes: FakeBox[], opts: { connectErrors?: unknown[] } = {}) {
  const calls = {
    configs: [] as ImapConfig[],
    opened: [] as string[],
    released: 0,
    logouts: 0,
    searches: [] as unknown[],
    // Every message whose source was downloaded, with the options it was asked for.
    sources: [] as Array<{ uid: number; option: unknown }>,
  };
  const connectErrors = [...(opts.connectErrors ?? [])];
  const createImap = (cfg: ImapConfig): ImapLike => {
    calls.configs.push(cfg);
    let current: FakeBox | undefined;
    return {
      mailbox: { uidValidity: 7n },
      async connect() {
        const failure = connectErrors.shift();
        if (failure) throw failure;
      },
      async logout() {
        calls.logouts++;
      },
      async list() {
        return boxes.map((b) => ({ path: b.path, ...(b.specialUse ? { specialUse: b.specialUse } : {}) }));
      },
      async getMailboxLock(path) {
        current = boxes.find((b) => b.path === path);
        if (!current) throw new Error(`no such mailbox ${path}`);
        calls.opened.push(path);
        return { release: () => void calls.released++ };
      },
      async search(query) {
        calls.searches.push(query);
        const since = query.since instanceof Date ? query.since.getTime() : null;
        return (current?.messages ?? []).filter((m) => since === null || new Date(m.internalDate).getTime() >= since).map((m) => m.uid);
      },
      async *fetch(range, query) {
        const wanted = new Set(range.split(',').map(Number));
        for (const m of current?.messages ?? []) {
          if (!wanted.has(m.uid)) continue;
          const out: ImapMessage = { uid: m.uid, internalDate: new Date(m.internalDate) };
          if (query.source && m.source) {
            out.source = Buffer.from(m.source);
            calls.sources.push({ uid: m.uid, option: query.source });
          }
          out.envelope = {
            ...(m.messageId ? { messageId: m.messageId } : {}),
            ...(m.from ? { from: [{ address: m.from }] } : {}),
            to: (m.to ?? []).map((address) => ({ address })),
            cc: (m.cc ?? []).map((address) => ({ address })),
          };
          yield out;
        }
      },
    };
  };
  return { createImap, calls };
}

function mail(parts: { from: string; to?: string; subject?: string; id: string; body: string; contentType?: string }): string {
  return [
    `From: ${parts.from}`,
    `To: ${parts.to ?? 'you@x.com'}`,
    `Subject: ${parts.subject ?? 'Re: Hello'}`,
    `Message-ID: ${parts.id}`,
    'Date: Mon, 02 Nov 2026 10:00:00 +0000',
    `Content-Type: ${parts.contentType ?? 'text/plain; charset=utf-8'}`,
    '',
    parts.body,
  ].join('\r\n');
}

const KEMI_REPLY = mail({
  from: 'Kemi Okoye <kemi@okopay.test>',
  id: '<reply-1@okopay.test>',
  body: ['Yes, Thursday at 9:00 works.', '', 'On Mon, Nov 2, 2026 at 9:03 AM Gabriel <you@x.com> wrote:', '> Hi Kemi', '> Are you free this week?'].join('\r\n'),
});

const BOUNCE = mail({
  from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  id: '<bounce-1@googlemail.com>',
  subject: 'Delivery Status Notification (Failure)',
  contentType: 'multipart/report; report-type=delivery-status; boundary="b1"',
  body: [
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your message to ghost@okopay.test could not be delivered.',
    '',
    '--b1',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    '',
    'Final-Recipient: rfc822; ghost@okopay.test',
    'Action: failed',
    'Status: 5.1.1',
    '',
    '--b1--',
  ].join('\r\n'),
});

function makeAdapter(boxes: FakeBox[], extra: { transport?: ReturnType<typeof fakeTransport>; imapOpts?: { connectErrors?: unknown[] }; now?: string } = {}) {
  const transport = extra.transport ?? fakeTransport();
  const imap = fakeImap(boxes, extra.imapOpts);
  const clock = fixedClock(extra.now ?? '2026-11-02T12:00:00Z');
  const adapter = createEmailAdapter(INPUT_SECRET, { createTransport: transport.createTransport, createImap: imap.createImap, clock });
  return { adapter, transport, imap, clock };
}
const INPUT_SECRET = {
  provider: 'google', address: 'you@x.com', name: 'Gabriel Femi', password: 'app-password',
  smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpSecure: 'true', imapHost: 'imap.gmail.com', imapPort: '993', imapSecure: 'true',
};

describe('connect', () => {
  it('verifies SMTP and IMAP and returns the full secret', async () => {
    const transport = fakeTransport();
    const imap = fakeImap([{ path: 'INBOX', messages: [] }]);
    const adapter = createEmailAdapter(null, { createTransport: transport.createTransport, createImap: imap.createImap });
    const result = await adapter.connect(INPUT);
    expect(result.identity).toBe('you@x.com');
    expect(result.secret).toEqual({
      provider: 'google', address: 'you@x.com', name: 'Gabriel Femi', password: 'app-password', username: 'you@x.com',
      smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpSecure: 'true', imapHost: 'imap.gmail.com', imapPort: '993', imapSecure: 'true',
    });
    expect(transport.verify).toHaveBeenCalledOnce();
    expect(transport.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'you@x.com', pass: 'app-password' } }));
    expect(imap.calls.configs[0]).toMatchObject({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: 'you@x.com', pass: 'app-password' } });
    expect(imap.calls.logouts).toBe(1);
  });

  it('rejects with a plain sign-in message when SMTP verify fails', async () => {
    const transport = fakeTransport({ verify: async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' }); } });
    const adapter = createEmailAdapter(null, { createTransport: transport.createTransport, createImap: fakeImap([]).createImap });
    const failure = adapter.connect({ ...INPUT, address: 'you@x.com' });
    await expect(failure).rejects.toBeInstanceOf(ConnectError);
    await expect(failure).rejects.toThrow("Google didn't accept that password. App passwords are 16 letters, with no spaces.");
  });

  it('words a refused password for another provider around its servers', async () => {
    const transport = fakeTransport({ verify: async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' }); } });
    const adapter = createEmailAdapter(null, { createTransport: transport.createTransport, createImap: fakeImap([]).createImap });
    await expect(adapter.connect({ provider: 'custom', address: 'you@x.com', password: 'pw', smtpHost: 'smtp.x.com', smtpPort: '587', imapHost: 'imap.x.com', imapPort: '993' })).rejects.toThrow(
      "Your mail server didn't accept that password. Check the password and both server names.",
    );
  });

  it('rejects with the same message when IMAP refuses the login', async () => {
    const adapter = createEmailAdapter(null, {
      createTransport: fakeTransport().createTransport,
      createImap: fakeImap([], { connectErrors: [Object.assign(new Error('Command failed'), { authenticationFailed: true })] }).createImap,
    });
    await expect(adapter.connect(INPUT)).rejects.toThrow("Google didn't accept that password. App passwords are 16 letters, with no spaces.");
  });

  it('says the server could not be reached when the network fails', async () => {
    const transport = fakeTransport({ verify: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
    const adapter = createEmailAdapter(null, { createTransport: transport.createTransport, createImap: fakeImap([]).createImap });
    await expect(adapter.connect(INPUT)).rejects.toThrow("Couldn't reach smtp.gmail.com. Check the server name and port.");
  });

  it.each(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ETLS', 'ERR_SSL_WRONG_VERSION_NUMBER'])('says the server could not be reached for %s on SMTP and on IMAP', async (code) => {
    const smtpDown = fakeTransport({ verify: async () => { throw Object.assign(new Error('boom'), { code }); } });
    const a = createEmailAdapter(null, { createTransport: smtpDown.createTransport, createImap: fakeImap([]).createImap });
    await expect(a.connect(INPUT)).rejects.toThrow("Couldn't reach smtp.gmail.com. Check the server name and port.");
    const b = createEmailAdapter(null, { createTransport: fakeTransport().createTransport, createImap: fakeImap([], { connectErrors: [Object.assign(new Error('boom'), { code })] }).createImap });
    await expect(b.connect(INPUT)).rejects.toThrow("Couldn't reach imap.gmail.com. Check the server name and port.");
  });

  it('needs server settings for a custom provider', async () => {
    const adapter = createEmailAdapter(null, { createTransport: fakeTransport().createTransport, createImap: fakeImap([]).createImap });
    await expect(adapter.connect({ ...INPUT, provider: 'custom' })).rejects.toBeInstanceOf(ConnectError);
    await expect(adapter.connect({ ...INPUT, provider: 'custom' })).rejects.toThrow('Add the mail server and port for you@x.com.');
  });

  it('rejects an unknown provider and a missing password', async () => {
    const adapter = createEmailAdapter(null, { createTransport: fakeTransport().createTransport, createImap: fakeImap([]).createImap });
    await expect(adapter.connect({ ...INPUT, provider: 'aol' })).rejects.toBeInstanceOf(ConnectError);
    await expect(adapter.connect({ ...INPUT, password: '' })).rejects.toBeInstanceOf(ConnectError);
  });

  it('defaults security from the port and allows plain only for local servers', async () => {
    const transport = fakeTransport();
    const imap = fakeImap([]);
    const adapter = createEmailAdapter(null, { createTransport: transport.createTransport, createImap: imap.createImap });
    const local = await adapter.connect({ provider: 'custom', address: 'you@y.test', name: 'You', password: 'p', smtpHost: '127.0.0.1', smtpPort: '3025', imapHost: '127.0.0.1', imapPort: '3143' });
    expect(local.secret).toMatchObject({ smtpSecure: 'false', imapSecure: 'false' });
    expect(transport.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: false, ignoreTLS: true }));
    expect(imap.calls.configs.at(-1)).toMatchObject({ secure: false, doSTARTTLS: false });

    await adapter.connect({ provider: 'custom', address: 'you@y.test', name: 'You', password: 'p', smtpHost: 'mail.y.test', smtpPort: '587', imapHost: 'mail.y.test', imapPort: '143' });
    expect(transport.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
    expect(imap.calls.configs.at(-1)).toMatchObject({ secure: false, doSTARTTLS: true });

    const secure = await adapter.connect({ provider: 'custom', address: 'you@y.test', name: 'You', password: 'p', smtpHost: 'mail.y.test', smtpPort: '465', imapHost: 'mail.y.test', imapPort: '993' });
    expect(secure.secret).toMatchObject({ smtpSecure: 'true', imapSecure: 'true' });
  });
});

describe('send', () => {
  it('sends text with the from name, List-Unsubscribe and reply headers', async () => {
    const { adapter, transport } = makeAdapter([]);
    const result = await adapter.send({ ...HELLO, inReplyTo: '<reply-1@okopay.test>' });
    expect(result).toEqual({ ok: true, externalId: '<abc@x.com>' });
    const sent = transport.sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.from).toBe('"Gabriel Femi" <you@x.com>');
    expect(sent.to).toBe('"Kemi Okoye" <kemi@okopay.test>');
    expect(sent.subject).toBe('Hello from Gabriel');
    expect(sent.text).toBe('Hi Kemi');
    expect(sent.inReplyTo).toBe('<reply-1@okopay.test>');
    expect(sent.references).toBe('<reply-1@okopay.test>');
    expect(sent.headers).toEqual({ 'List-Unsubscribe': '<mailto:you@x.com?subject=stop>' });
  });

  it('omits reply headers when there is nothing to reply to', async () => {
    const { adapter, transport } = makeAdapter([]);
    await adapter.send(HELLO);
    const sent = transport.sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('inReplyTo');
    expect(sent).not.toHaveProperty('references');
  });

  it('escapes quotes in the from name', async () => {
    const transport = fakeTransport();
    const adapter = createEmailAdapter({ ...INPUT_SECRET, name: 'Gabriel "G" Femi' }, { createTransport: transport.createTransport });
    await adapter.send(HELLO);
    expect((transport.sendMail.mock.calls[0]?.[0] as Record<string, unknown>).from).toBe('"Gabriel \\"G\\" Femi" <you@x.com>');
  });

  it('maps a rejected recipient to invalid_recipient', async () => {
    const transport = fakeTransport({ sendMail: async () => { throw Object.assign(new Error('550 5.1.1 user unknown'), { responseCode: 550 }); } });
    const { adapter } = makeAdapter([], { transport });
    expect(await adapter.send(HELLO)).toEqual({ ok: false, error: { code: 'invalid_recipient', message: '550 5.1.1 user unknown' } });
  });

  it('maps a rejected address list to invalid_recipient', async () => {
    const transport = fakeTransport({ sendMail: async () => ({ messageId: '<m@x>', rejected: ['kemi@okopay.test'] }) });
    const { adapter } = makeAdapter([], { transport });
    const result = await adapter.send(HELLO);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });
  });

  it('refuses a recipient without an email address', async () => {
    const { adapter, transport } = makeAdapter([]);
    const result = await adapter.send({ ...HELLO, to: { ...HELLO.to, email: null } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('reports auth when the mailbox was never connected', async () => {
    const adapter = createEmailAdapter(null, { createTransport: fakeTransport().createTransport });
    expect(await adapter.send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
  });

  it('works right after connect without a stored secret', async () => {
    const transport = fakeTransport();
    const adapter = createEmailAdapter(null, { createTransport: transport.createTransport, createImap: fakeImap([]).createImap });
    await adapter.connect(INPUT);
    expect((await adapter.send(HELLO)).ok).toBe(true);
  });
});

function dsn(id: string, subject: string, deliveryStatus: string): string {
  return mail({
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    id,
    subject,
    contentType: 'multipart/report; report-type=delivery-status; boundary="b1"',
    body: ['--b1', 'Content-Type: text/plain; charset=utf-8', '', 'Delivery report.', '', '--b1', 'Content-Type: message/delivery-status', '', deliveryStatus, '', '--b1--'].join('\r\n'),
  });
}

describe('poll', () => {
  const inbox: FakeBox = {
    path: 'INBOX',
    messages: [
      { uid: 1, internalDate: '2026-11-02T10:00:00Z', source: KEMI_REPLY, messageId: '<reply-1@okopay.test>', from: 'kemi@okopay.test' },
      { uid: 2, internalDate: '2026-11-02T10:05:00Z', source: BOUNCE, messageId: '<bounce-1@googlemail.com>', from: 'mailer-daemon@googlemail.com' },
      { uid: 3, internalDate: '2026-11-02T10:06:00Z', source: mail({ from: 'You <YOU@x.com>', id: '<own-1@x.com>', body: 'copy of my own mail' }), messageId: '<own-1@x.com>', from: 'YOU@x.com' },
    ],
  };

  it("emits a reply with quoted text stripped and a bounce, skipping the user's own mail", async () => {
    const { adapter } = makeAdapter([inbox]);
    const events = await adapter.poll(new Date('2026-11-02T09:00:00Z'));
    expect(events).toEqual([
      { type: 'reply', from: { email: 'kemi@okopay.test', name: 'Kemi Okoye' }, text: 'Yes, Thursday at 9:00 works.', at: '2026-11-02T10:00:00.000Z', externalId: '<reply-1@okopay.test>' },
      { type: 'bounce', email: 'ghost@okopay.test', at: '2026-11-02T10:05:00.000Z', externalId: '<bounce-1@googlemail.com>' },
    ]);
  });

  it('reads the subject when a reply has no words of its own (the unsubscribe link sends "stop" and nothing else)', async () => {
    const unsubscribe = mail({ from: 'Chidi Okeke <chidi@lagosledger.test>', id: '<unsub-1@lagosledger.test>', subject: 'stop', body: '' });
    const reply = mail({ from: 'Tunde <tunde@iretilabs.test>', id: '<unsub-2@iretilabs.test>', subject: 'Re: Unsubscribe', body: '' });
    const words = mail({ from: 'Kemi Okoye <kemi@okopay.test>', id: '<unsub-3@okopay.test>', subject: 'Stop', body: 'Thursday works.' });
    const box: FakeBox = {
      path: 'INBOX',
      messages: [
        { uid: 1, internalDate: '2026-11-02T10:00:00Z', source: unsubscribe, messageId: '<unsub-1@lagosledger.test>', from: 'chidi@lagosledger.test' },
        { uid: 2, internalDate: '2026-11-02T10:01:00Z', source: reply, messageId: '<unsub-2@iretilabs.test>', from: 'tunde@iretilabs.test' },
        { uid: 3, internalDate: '2026-11-02T10:02:00Z', source: words, messageId: '<unsub-3@okopay.test>', from: 'kemi@okopay.test' },
      ],
    };
    const { adapter } = makeAdapter([box]);
    const events = await adapter.poll(new Date('2026-11-02T09:00:00Z'));
    expect(events.map((e) => (e.type === 'reply' ? [e.from.email, e.text] : null))).toEqual([
      ['chidi@lagosledger.test', 'stop'],
      ['tunde@iretilabs.test', 'Unsubscribe'],
      // Words in the body win over the subject.
      ['kemi@okopay.test', 'Thursday works.'],
    ]);
  });

  it('does not emit the same message twice', async () => {
    const { adapter } = makeAdapter([inbox]);
    expect(await adapter.poll(null)).toHaveLength(2);
    expect(await adapter.poll(null)).toEqual([]);
  });

  it('downloads message bodies only for messages it has not seen, with a size cap', async () => {
    const { adapter, imap } = makeAdapter([inbox]);
    await adapter.poll(null);
    // The user's own mail is recognised from its envelope and never downloaded.
    expect(imap.calls.sources.map((d) => d.uid)).toEqual([1, 2]);
    expect(imap.calls.sources.every((d) => JSON.stringify(d.option) === JSON.stringify({ maxLength: 262144 }))).toBe(true);
    await adapter.poll(null);
    await adapter.poll(null);
    expect(imap.calls.sources.map((d) => d.uid)).toEqual([1, 2]);
  });

  it('does not download a message again when a later poll finds the same own mail', async () => {
    const { adapter, imap } = makeAdapter([inbox]);
    await adapter.poll(null);
    const before = imap.calls.sources.length;
    await adapter.poll(null);
    expect(imap.calls.sources.length).toBe(before);
  });

  it('identifies messages without a Message-ID by mailbox and UID', async () => {
    const noId: FakeBox = { path: 'INBOX', messages: [{ uid: 9, internalDate: '2026-11-02T10:00:00Z', source: KEMI_REPLY, from: 'kemi@okopay.test' }] };
    const { adapter, imap } = makeAdapter([noId]);
    expect(await adapter.poll(null)).toHaveLength(1);
    expect(await adapter.poll(null)).toEqual([]);
    expect(imap.calls.sources).toHaveLength(1);
  });

  it('keeps a 15 minute margin before since so a late-delivered message is not lost', async () => {
    const box: FakeBox = {
      path: 'INBOX',
      messages: [
        { uid: 1, internalDate: '2026-11-02T09:55:00Z', source: KEMI_REPLY, messageId: '<reply-1@okopay.test>', from: 'kemi@okopay.test' },
        { uid: 2, internalDate: '2026-11-02T09:40:00Z', source: BOUNCE, messageId: '<bounce-1@googlemail.com>', from: 'mailer-daemon@googlemail.com' },
      ],
    };
    const { adapter, imap } = makeAdapter([box]);
    const events = await adapter.poll(new Date('2026-11-02T10:00:00Z'));
    expect(events.map((e) => e.type)).toEqual(['reply']);
    // The server search starts a day earlier still, because IMAP SINCE has day precision.
    expect(imap.calls.searches[0]).toEqual({ since: new Date('2026-11-01T09:45:00Z') });
  });

  it('looks back three days when there is no since', async () => {
    const { adapter, imap } = makeAdapter([inbox], { now: '2026-11-02T12:00:00Z' });
    await adapter.poll(null);
    expect(imap.calls.searches[0]).toEqual({ since: new Date('2026-10-29T11:45:00Z') });
  });

  it('emits outbound_seen with the Message-ID for each Sent recipient', async () => {
    const sent: FakeBox = {
      path: 'Sent',
      specialUse: '\\Sent',
      messages: [
        { uid: 1, internalDate: '2026-11-02T10:30:00Z', messageId: '<s1@x.com>', to: ['Amara@Zed.test'], cc: ['boss@zed.test'] },
        { uid: 3, internalDate: '2026-10-30T01:00:00Z', messageId: '<s3@x.com>', to: ['old@zed.test'] },
      ],
    };
    const { adapter, imap } = makeAdapter([{ path: 'INBOX', messages: [] }, sent]);
    const events = await adapter.poll(new Date('2026-11-02T00:00:00Z'));
    expect(events).toEqual([
      { type: 'outbound_seen', email: 'amara@zed.test', at: '2026-11-02T10:30:00.000Z', externalId: '<s1@x.com>' },
      { type: 'outbound_seen', email: 'boss@zed.test', at: '2026-11-02T10:30:00.000Z', externalId: '<s1@x.com>' },
    ]);
    expect(await adapter.poll(new Date('2026-11-02T00:00:00Z'))).toEqual([]);
    expect(imap.calls.sources).toEqual([]);
  });

  it('does not report mail this adapter sent itself as outbound_seen', async () => {
    const sent: FakeBox = {
      path: 'Sent',
      specialUse: '\\Sent',
      messages: [
        { uid: 1, internalDate: '2026-11-02T11:59:00Z', messageId: '<abc@x.com>', to: ['kemi@okopay.test'] },
        { uid: 2, internalDate: '2026-11-02T11:59:30Z', messageId: '<by-hand@x.com>', to: ['amara@zed.test'] },
      ],
    };
    const { adapter } = makeAdapter([{ path: 'INBOX', messages: [] }, sent]);
    expect((await adapter.send(HELLO)).ok).toBe(true); // the fake transport answers <abc@x.com>
    const events = await adapter.poll(new Date('2026-11-02T00:00:00Z'));
    expect(events).toEqual([{ type: 'outbound_seen', email: 'amara@zed.test', at: '2026-11-02T11:59:30.000Z', externalId: '<by-hand@x.com>' }]);
  });

  it('prefers the special-use Sent mailbox and falls back to common names', async () => {
    const message = { uid: 1, internalDate: '2026-11-02T10:30:00Z', messageId: '<s1@x.com>', to: ['amara@zed.test'] };
    const special = makeAdapter([
      { path: 'INBOX', messages: [] },
      { path: 'Sent', messages: [] },
      { path: 'Elsewhere', specialUse: '\\Sent', messages: [message] },
    ]);
    expect(await special.adapter.poll(null)).toHaveLength(1);

    for (const name of ['Sent Items', 'Sent Messages', '[Gmail]/Sent Mail', 'sent']) {
      const { adapter } = makeAdapter([{ path: 'INBOX', messages: [] }, { path: name, messages: [message] }]);
      expect(await adapter.poll(null)).toHaveLength(1);
    }
  });

  it('skips Sent without failing when no Sent mailbox exists', async () => {
    const { adapter, imap } = makeAdapter([inbox]);
    await expect(adapter.poll(null)).resolves.toHaveLength(2);
    expect(imap.calls.opened).toEqual(['INBOX']);
  });

  it('releases every mailbox lock and logs out', async () => {
    const { adapter, imap } = makeAdapter([inbox, { path: 'Sent', specialUse: '\\Sent', messages: [] }]);
    await adapter.poll(null);
    expect(imap.calls.released).toBe(2);
    expect(imap.calls.logouts).toBe(1);
  });

  it('throws ConnectError "auth" when the IMAP login fails', async () => {
    const { adapter } = makeAdapter([inbox], { imapOpts: { connectErrors: [Object.assign(new Error('nope'), { authenticationFailed: true })] } });
    const failure = adapter.poll(null);
    await expect(failure).rejects.toBeInstanceOf(ConnectError);
    await expect(failure).rejects.toThrow('auth');
  });

  it('passes other connection errors through unchanged', async () => {
    const boom = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { adapter } = makeAdapter([inbox], { imapOpts: { connectErrors: [boom] } });
    await expect(adapter.poll(null)).rejects.toBe(boom);
  });

  it('throws ConnectError "auth" when never connected', async () => {
    const adapter = createEmailAdapter(null, { createImap: fakeImap([]).createImap });
    await expect(adapter.poll(null)).rejects.toThrow('auth');
  });
});

describe('poll bounces', () => {
  const GMAIL_DELAY = [
    'Reporting-MTA: dns; googlemail.com',
    '',
    'Action: delayed',
    'Final-Recipient: rfc822; slow@okopay.test',
    'Status: 4.0.0',
    'Diagnostic-Code: smtp; The recipient server did not accept our requests to connect.',
    'Will-Retry-Until: Fri, 6 Nov 2026 10:00:00 +0000',
  ].join('\r\n');
  const TWO = [
    'Reporting-MTA: dns; googlemail.com',
    '',
    'Final-Recipient: rfc822; fine@okopay.test',
    'Action: delivered',
    'Status: 2.0.0',
    '',
    'Final-Recipient: rfc822; gone@okopay.test',
    'Action: failed',
    'Status: 5.1.1',
  ].join('\r\n');

  function pollWith(source: string, id: string, subject: string) {
    const box: FakeBox = { path: 'INBOX', messages: [{ uid: 1, internalDate: '2026-11-02T10:00:00Z', source: dsn(id, subject, source), messageId: id, from: 'mailer-daemon@googlemail.com' }] };
    return makeAdapter([box]).adapter.poll(null);
  }

  it('gives no bounce for a delay notice', async () => {
    expect(await pollWith(GMAIL_DELAY, '<delay-1@googlemail.com>', 'Delivery Status Notification (Delay)')).toEqual([]);
  });

  it('gives a bounce, with the notice Message-ID, for a failed notice', async () => {
    const failed = ['Reporting-MTA: dns; googlemail.com', '', 'Final-Recipient: rfc822; ghost@okopay.test', 'Action: failed', 'Status: 5.1.1'].join('\r\n');
    expect(await pollWith(failed, '<fail-1@googlemail.com>', 'Delivery Status Notification (Failure)')).toEqual([
      { type: 'bounce', email: 'ghost@okopay.test', at: '2026-11-02T10:00:00.000Z', externalId: '<fail-1@googlemail.com>' },
    ]);
  });

  it('bounces only the recipient that failed', async () => {
    const events = await pollWith(TWO, '<two-1@googlemail.com>', 'Delivery Status Notification (Failure)');
    expect(events.map((e) => (e.type === 'bounce' ? e.email : null))).toEqual(['gone@okopay.test']);
  });

  it('does not bounce a plain-text notice that says delivery is delayed', async () => {
    const source = mail({ from: 'Mail Delivery System <mailer-daemon@mx.example.com>', id: '<d@mx>', subject: 'Warning: message delayed', body: 'Your message to slow@okopay.test is delayed. The server will keep trying.' });
    const box: FakeBox = { path: 'INBOX', messages: [{ uid: 1, internalDate: '2026-11-02T10:00:00Z', source, messageId: '<d@mx>', from: 'mailer-daemon@mx.example.com' }] };
    expect(await makeAdapter([box]).adapter.poll(null)).toEqual([]);
  });

  it('reads the recipient from a plain-text failure notice without a status report', async () => {
    const source = mail({ from: 'Mail Delivery System <mailer-daemon@mx.example.com>', id: '<p@mx>', subject: 'Undeliverable: Hello', body: 'Your message could not be delivered to ghost@okopay.test because the user does not exist.' });
    const box: FakeBox = { path: 'INBOX', messages: [{ uid: 1, internalDate: '2026-11-02T10:00:00Z', source, messageId: '<p@mx>', from: 'mailer-daemon@mx.example.com' }] };
    expect(await makeAdapter([box]).adapter.poll(null)).toMatchObject([{ type: 'bounce', email: 'ghost@okopay.test', externalId: '<p@mx>' }]);
  });
});

describe('knownAddresses', () => {
  it('returns the unique recipients of Sent mail, lower-cased and without the user, without downloading bodies', async () => {
    const sent: FakeBox = {
      path: 'Sent Items',
      messages: [
        { uid: 1, internalDate: '2026-10-01T10:00:00Z', to: ['Amara@Zed.test'], cc: ['you@x.com'] },
        { uid: 2, internalDate: '2026-10-02T10:00:00Z', to: ['amara@zed.test', 'kemi@okopay.test'], source: 'never fetched' },
      ],
    };
    const { adapter, imap } = makeAdapter([{ path: 'INBOX', messages: [] }, sent]);
    expect((await adapter.knownAddresses?.())?.sort()).toEqual(['amara@zed.test', 'kemi@okopay.test']);
    expect(imap.calls.sources).toEqual([]);
  });

  it('reads only the last 2,000 Sent messages', async () => {
    const messages: FakeMessage[] = Array.from({ length: 2005 }, (_, i) => ({ uid: i + 1, internalDate: '2026-10-01T10:00:00Z', to: [`p${i + 1}@zed.test`] }));
    const { adapter } = makeAdapter([{ path: 'Sent', messages }]);
    const known = (await adapter.knownAddresses?.()) ?? [];
    expect(known).toHaveLength(2000);
    expect(known).not.toContain('p5@zed.test');
    expect(known).toContain('p2005@zed.test');
  });

  it('returns an empty list when there is no Sent mailbox', async () => {
    const { adapter } = makeAdapter([{ path: 'INBOX', messages: [] }]);
    expect(await adapter.knownAddresses?.()).toEqual([]);
  });
});

const MS_INPUT = { provider: 'microsoft', address: 'you@contoso.test', name: 'Gabriel Femi', clientId: 'client-1', refreshToken: 'rt-0' };

describe('microsoft (OAuth2)', () => {
  function tokens(n: number, expiresAt = '2026-11-02T13:00:00.000Z'): TokenSet {
    return { accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt };
  }
  function msAdapter(opts: { secret?: Record<string, string> | null; refreshes?: Array<TokenSet | Error>; sendMail?: (m: Record<string, unknown>) => Promise<Record<string, unknown>>; imapErrors?: unknown[]; boxes?: FakeBox[] } = {}) {
    const transport = fakeTransport(opts.sendMail ? { sendMail: opts.sendMail } : {});
    const imap = fakeImap(opts.boxes ?? [{ path: 'INBOX', messages: [] }], { connectErrors: opts.imapErrors ?? [] });
    const queue = [...(opts.refreshes ?? [])];
    const refresh = vi.fn(async (_clientId: string, _refreshToken: string) => {
      const next = queue.shift();
      if (!next) throw new Error('unexpected refresh');
      if (next instanceof Error) throw next;
      return next;
    });
    const saved: Array<Record<string, string>> = [];
    const clock = fixedClock('2026-11-02T12:00:00Z');
    const adapter = createEmailAdapter(opts.secret === undefined ? null : opts.secret, {
      createTransport: transport.createTransport,
      createImap: imap.createImap,
      clock,
      refreshAccessToken: refresh,
      onSecretChange: (secret) => saved.push(secret),
    });
    return { adapter, transport, imap, refresh, saved, clock };
  }
  const SECRET = { provider: 'microsoft', address: 'you@contoso.test', name: 'Gabriel Femi', clientId: 'client-1', refreshToken: 'rt-0', accessToken: 'at-0', accessTokenExpiresAt: '2026-11-02T12:30:00.000Z' };

  it('signs in with XOAUTH2 on SMTP and IMAP and returns the OAuth secret', async () => {
    const { adapter, transport, imap, refresh } = msAdapter({ refreshes: [tokens(1)] });
    const result = await adapter.connect(MS_INPUT);
    expect(refresh).toHaveBeenCalledWith('client-1', 'rt-0');
    expect(result.identity).toBe('you@contoso.test');
    expect(result.secret).toEqual({
      provider: 'microsoft', address: 'you@contoso.test', name: 'Gabriel Femi', clientId: 'client-1',
      refreshToken: 'rt-1', accessToken: 'at-1', accessTokenExpiresAt: '2026-11-02T13:00:00.000Z',
    });
    expect(transport.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true,
      auth: { type: 'OAuth2', user: 'you@contoso.test', accessToken: 'at-1' },
    }));
    expect(imap.calls.configs[0]).toMatchObject({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: 'you@contoso.test', accessToken: 'at-1' } });
    expect(transport.verify).toHaveBeenCalledOnce();
  });

  it('asks the person to sign in with Microsoft again when the refresh token is refused', async () => {
    const { adapter } = msAdapter({ refreshes: [new OAuthError('invalid_grant', 'AADSTS70000')] });
    const failure = adapter.connect(MS_INPUT);
    await expect(failure).rejects.toBeInstanceOf(ConnectError);
    await expect(failure).rejects.toThrow("Couldn't sign in to you@contoso.test. Sign in with Microsoft again.");
  });

  it('needs a client id and a refresh token', async () => {
    const { adapter } = msAdapter();
    await expect(adapter.connect({ ...MS_INPUT, clientId: '' })).rejects.toBeInstanceOf(ConnectError);
    await expect(adapter.connect({ ...MS_INPUT, refreshToken: '' })).rejects.toBeInstanceOf(ConnectError);
  });

  it('sends with the stored access token while it is still good', async () => {
    const { adapter, transport, refresh, saved } = msAdapter({ secret: SECRET });
    expect((await adapter.send(HELLO)).ok).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(transport.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: { type: 'OAuth2', user: 'you@contoso.test', accessToken: 'at-0' } }));
  });

  it('refreshes an expired access token and hands the rotated secret back', async () => {
    const { adapter, transport, refresh, saved } = msAdapter({ secret: { ...SECRET, accessTokenExpiresAt: '2026-11-02T11:59:00.000Z' }, refreshes: [tokens(1)] });
    expect((await adapter.send(HELLO)).ok).toBe(true);
    expect(refresh).toHaveBeenCalledWith('client-1', 'rt-0');
    expect(saved).toEqual([{ ...SECRET, refreshToken: 'rt-1', accessToken: 'at-1', accessTokenExpiresAt: '2026-11-02T13:00:00.000Z' }]);
    expect(transport.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: { type: 'OAuth2', user: 'you@contoso.test', accessToken: 'at-1' } }));
  });

  it('treats a token that runs out within a minute as expired', async () => {
    const { adapter, refresh } = msAdapter({ secret: { ...SECRET, accessTokenExpiresAt: '2026-11-02T12:00:30.000Z' }, refreshes: [tokens(1)] });
    await adapter.send(HELLO);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('builds a new SMTP connection when the token changes', async () => {
    const { adapter, transport, clock } = msAdapter({ secret: SECRET, refreshes: [tokens(1, '2026-11-02T14:00:00.000Z')] });
    await adapter.send(HELLO);
    clock.set('2026-11-02T12:40:00Z');
    await adapter.send(HELLO);
    expect(transport.createTransport).toHaveBeenCalledTimes(2);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it('refreshes once and retries when SMTP refuses the token', async () => {
    let attempts = 0;
    const { adapter, refresh } = msAdapter({
      secret: SECRET,
      refreshes: [tokens(1)],
      sendMail: async () => {
        if (attempts++ === 0) throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
        return { messageId: '<ok@x>', rejected: [] };
      },
    });
    expect(await adapter.send(HELLO)).toEqual({ ok: true, externalId: '<ok@x>' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('gives up with auth after one refresh when SMTP keeps refusing', async () => {
    const { adapter, refresh } = msAdapter({
      secret: SECRET,
      refreshes: [tokens(1), tokens(2)],
      sendMail: async () => {
        throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
      },
    });
    expect(await adapter.send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reports auth from send when the refresh token has been revoked', async () => {
    const { adapter } = msAdapter({ secret: { ...SECRET, accessTokenExpiresAt: '2026-11-02T11:00:00.000Z' }, refreshes: [new OAuthError('invalid_grant', 'AADSTS70000: sign in again')] });
    expect(await adapter.send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth', message: 'AADSTS70000: sign in again' } });
  });

  it('polls IMAP with the access token and refreshes once when IMAP refuses it', async () => {
    const { adapter, imap, refresh } = msAdapter({
      secret: SECRET,
      refreshes: [tokens(1)],
      imapErrors: [Object.assign(new Error('AUTHENTICATE failed'), { authenticationFailed: true })],
    });
    expect(await adapter.poll(null)).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(imap.calls.configs.map((c) => c.auth)).toEqual([
      { user: 'you@contoso.test', accessToken: 'at-0' },
      { user: 'you@contoso.test', accessToken: 'at-1' },
    ]);
  });

  it('throws ConnectError "auth" when IMAP refuses a freshly refreshed token too', async () => {
    const refused = () => Object.assign(new Error('AUTHENTICATE failed'), { authenticationFailed: true });
    const { adapter, refresh } = msAdapter({ secret: SECRET, refreshes: [tokens(1), tokens(2)], imapErrors: [refused(), refused()] });
    await expect(adapter.poll(null)).rejects.toThrow('auth');
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('close', () => {
  it('closes the SMTP connection', async () => {
    const { adapter, transport } = makeAdapter([]);
    await adapter.send(HELLO);
    await adapter.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
