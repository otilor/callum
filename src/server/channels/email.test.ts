import type nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { createEmailAdapter, type ImapConfig, type ImapLike, type ImapMessage } from './email.js';
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
  to?: string[];
  cc?: string[];
  headers?: string;
}
interface FakeBox { path: string; specialUse?: string; messages: FakeMessage[] }

function fakeImap(boxes: FakeBox[], opts: { connectError?: unknown } = {}) {
  const calls = { configs: [] as ImapConfig[], opened: [] as string[], released: 0, logouts: 0, searches: [] as unknown[] };
  const createImap = (cfg: ImapConfig): ImapLike => {
    calls.configs.push(cfg);
    let current: FakeBox | undefined;
    return {
      async connect() {
        if (opts.connectError) throw opts.connectError;
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
      async *fetch(range) {
        const wanted = new Set(range.split(',').map(Number));
        for (const m of current?.messages ?? []) {
          if (!wanted.has(m.uid)) continue;
          const out: ImapMessage = { uid: m.uid, internalDate: new Date(m.internalDate) };
          if (m.source) out.source = Buffer.from(m.source);
          if (m.headers) out.headers = Buffer.from(m.headers);
          out.envelope = {
            ...(m.messageId ? { messageId: m.messageId } : {}),
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

function makeAdapter(boxes: FakeBox[], extra: { transport?: ReturnType<typeof fakeTransport>; imapOpts?: { connectError?: unknown }; now?: string } = {}) {
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
    await expect(failure).rejects.toThrow("Couldn't sign in to you@x.com. Check the app password.");
  });

  it('rejects with the same message when IMAP refuses the login', async () => {
    const adapter = createEmailAdapter(null, {
      createTransport: fakeTransport().createTransport,
      createImap: fakeImap([], { connectError: Object.assign(new Error('Command failed'), { authenticationFailed: true }) }).createImap,
    });
    await expect(adapter.connect(INPUT)).rejects.toThrow("Couldn't sign in to you@x.com. Check the app password.");
  });

  it('says the server could not be reached when the network fails', async () => {
    const transport = fakeTransport({ verify: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
    const adapter = createEmailAdapter(null, { createTransport: transport.createTransport, createImap: fakeImap([]).createImap });
    await expect(adapter.connect(INPUT)).rejects.toThrow("Couldn't reach smtp.gmail.com. Check the server and port.");
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
    expect(sent.headers).toMatchObject({ 'List-Unsubscribe': '<mailto:you@x.com?subject=stop>' });
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

describe('poll', () => {
  const inbox: FakeBox = {
    path: 'INBOX',
    messages: [
      { uid: 1, internalDate: '2026-11-02T10:00:00Z', source: KEMI_REPLY },
      { uid: 2, internalDate: '2026-11-02T10:05:00Z', source: BOUNCE },
      { uid: 3, internalDate: '2026-11-02T10:06:00Z', source: mail({ from: 'You <YOU@x.com>', id: '<own-1@x.com>', body: 'copy of my own mail' }) },
    ],
  };

  it('emits a reply with quoted text stripped and a bounce, skipping the user\'s own mail', async () => {
    const { adapter } = makeAdapter([inbox]);
    const events = await adapter.poll(new Date('2026-11-02T09:00:00Z'));
    expect(events).toEqual([
      { type: 'reply', from: { email: 'kemi@okopay.test', name: 'Kemi Okoye' }, text: 'Yes, Thursday at 9:00 works.', at: '2026-11-02T10:00:00.000Z', externalId: '<reply-1@okopay.test>' },
      { type: 'bounce', email: 'ghost@okopay.test', at: '2026-11-02T10:05:00.000Z' },
    ]);
  });

  it('does not emit the same message twice', async () => {
    const { adapter } = makeAdapter([inbox]);
    expect(await adapter.poll(null)).toHaveLength(2);
    expect(await adapter.poll(null)).toEqual([]);
  });

  it('only returns messages that arrived at or after since', async () => {
    const { adapter, imap } = makeAdapter([inbox]);
    const events = await adapter.poll(new Date('2026-11-02T10:03:00Z'));
    expect(events).toEqual([{ type: 'bounce', email: 'ghost@okopay.test', at: '2026-11-02T10:05:00.000Z' }]);
    // The server search starts a day early because IMAP SINCE has day precision.
    expect(imap.calls.searches[0]).toEqual({ since: new Date('2026-11-01T10:03:00Z') });
  });

  it('looks back three days when there is no since', async () => {
    const { adapter, imap } = makeAdapter([inbox], { now: '2026-11-02T12:00:00Z' });
    await adapter.poll(null);
    expect(imap.calls.searches[0]).toEqual({ since: new Date('2026-10-29T12:00:00Z') });
  });

  it('emits outbound_seen for each Sent recipient but not for mail Callum sent', async () => {
    const sent: FakeBox = {
      path: 'Sent',
      specialUse: '\\Sent',
      messages: [
        { uid: 1, internalDate: '2026-11-02T10:30:00Z', messageId: '<s1@x.com>', to: ['Amara@Zed.test'], cc: ['boss@zed.test'] },
        { uid: 2, internalDate: '2026-11-02T10:31:00Z', messageId: '<s2@x.com>', to: ['kemi@okopay.test'], headers: 'X-Callum: sent\r\n\r\n' },
        { uid: 3, internalDate: '2026-11-01T01:00:00Z', messageId: '<s3@x.com>', to: ['old@zed.test'] },
      ],
    };
    const { adapter } = makeAdapter([{ path: 'INBOX', messages: [] }, sent]);
    const events = await adapter.poll(new Date('2026-11-02T00:00:00Z'));
    expect(events).toEqual([
      { type: 'outbound_seen', email: 'amara@zed.test', at: '2026-11-02T10:30:00.000Z' },
      { type: 'outbound_seen', email: 'boss@zed.test', at: '2026-11-02T10:30:00.000Z' },
    ]);
    expect(await adapter.poll(new Date('2026-11-02T00:00:00Z'))).toEqual([]);
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
    const { adapter } = makeAdapter([inbox], { imapOpts: { connectError: Object.assign(new Error('nope'), { authenticationFailed: true }) } });
    const failure = adapter.poll(null);
    await expect(failure).rejects.toBeInstanceOf(ConnectError);
    await expect(failure).rejects.toThrow('auth');
  });

  it('passes other connection errors through unchanged', async () => {
    const boom = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { adapter } = makeAdapter([inbox], { imapOpts: { connectError: boom } });
    await expect(adapter.poll(null)).rejects.toBe(boom);
  });

  it('throws ConnectError "auth" when never connected', async () => {
    const adapter = createEmailAdapter(null, { createImap: fakeImap([]).createImap });
    await expect(adapter.poll(null)).rejects.toThrow('auth');
  });
});

describe('knownAddresses', () => {
  it('returns the unique recipients of Sent mail, lower-cased and without the user', async () => {
    const sent: FakeBox = {
      path: 'Sent Items',
      messages: [
        { uid: 1, internalDate: '2026-10-01T10:00:00Z', to: ['Amara@Zed.test'], cc: ['you@x.com'] },
        { uid: 2, internalDate: '2026-10-02T10:00:00Z', to: ['amara@zed.test', 'kemi@okopay.test'] },
      ],
    };
    const { adapter } = makeAdapter([{ path: 'INBOX', messages: [] }, sent]);
    expect((await adapter.knownAddresses?.())?.sort()).toEqual(['amara@zed.test', 'kemi@okopay.test']);
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

describe('close', () => {
  it('closes the SMTP connection', async () => {
    const { adapter, transport } = makeAdapter([]);
    await adapter.send(HELLO);
    await adapter.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
