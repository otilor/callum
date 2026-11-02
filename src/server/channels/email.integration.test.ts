// Runs the email adapter against a real SMTP + IMAP server (GreenMail), not fakes.
// Opt in with CALLUM_MAIL_IT=1; `npm run test:mail` starts GreenMail and does this.
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmailAdapter } from './email.js';
import { ConnectError, type ChannelAdapter } from './types.js';

const SMTP_PORT = process.env.CALLUM_MAIL_SMTP_PORT ?? '3025';
const IMAP_PORT = process.env.CALLUM_MAIL_IMAP_PORT ?? '3143';
const HOST = '127.0.0.1';
const YOU = 'you@yourcompany.test';
const KEMI = 'kemi@okopay.test';
const PASSWORD = 'secret';
const RUN = Date.now().toString(36);

const connectInput = { provider: 'custom', address: YOU, name: 'Gabriel Femi', password: PASSWORD, smtpHost: HOST, smtpPort: SMTP_PORT, imapHost: HOST, imapPort: IMAP_PORT };

function imapClient(user: string): ImapFlow {
  const client = new ImapFlow({ host: HOST, port: Number(IMAP_PORT), secure: false, doSTARTTLS: false, auth: { user, pass: PASSWORD }, logger: false });
  client.on('error', () => {});
  return client;
}

async function eventually<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function mailboxMessages(user: string, path: string): Promise<ParsedMail[]> {
  const client = imapClient(user);
  await client.connect();
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const sources: Buffer[] = [];
    for await (const msg of client.fetch('1:*', { source: true })) if (msg.source) sources.push(msg.source);
    return await Promise.all(sources.map((s) => simpleParser(s)));
  } catch {
    return [];
  } finally {
    lock.release();
    await client.logout();
  }
}

const sendAsKemi = nodemailer.createTransport({ host: HOST, port: Number(SMTP_PORT), secure: false, ignoreTLS: true });

describe.skipIf(!process.env.CALLUM_MAIL_IT)('email adapter against GreenMail', () => {
  const testStart = new Date(Date.now() - 5000);
  const subject = `Hello from Gabriel ${RUN}`;
  let adapter: ChannelAdapter;
  let helloId: string | null = null;

  beforeAll(async () => {
    adapter = createEmailAdapter(null);
    await adapter.connect(connectInput);
  }, 30_000);

  afterAll(async () => {
    await adapter.close();
    sendAsKemi.close();
  });

  it('connect returns the identity and a secret that can be reused', async () => {
    const result = await createEmailAdapter(null).connect(connectInput);
    expect(result.identity).toBe(YOU);
    expect(result.secret).toMatchObject({ provider: 'custom', address: YOU, password: PASSWORD, smtpHost: HOST, smtpPort: SMTP_PORT, smtpSecure: 'false', imapHost: HOST, imapPort: IMAP_PORT, imapSecure: 'false' });
    const again = createEmailAdapter(result.secret);
    expect(await again.poll(testStart)).toBeDefined();
    await again.close();
  }, 30_000);

  it('connect with a wrong password rejects with the sign-in message', async () => {
    const failure = createEmailAdapter(null).connect({ ...connectInput, password: 'wrong' });
    await expect(failure).rejects.toBeInstanceOf(ConnectError);
    await expect(failure).rejects.toThrow("Your mail server didn't accept that password. Check the password and both server names.");
  }, 30_000);

  it('connect to a port nobody listens on says the server could not be reached', async () => {
    await expect(createEmailAdapter(null).connect({ ...connectInput, smtpPort: '3999' })).rejects.toThrow(`Couldn't reach ${HOST}. Check the server name and port.`);
  }, 30_000);

  it('send delivers a message with the From name and List-Unsubscribe header', async () => {
    const result = await adapter.send({
      to: { name: 'Kemi Okoye', email: KEMI, linkedinUrl: null, xHandle: null },
      kind: 'hello',
      subject,
      body: "Hi Kemi,\n\nI liked your note on payments.\n\nIf this isn't for you, just reply stop and I won't write again.",
      inReplyTo: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) helloId = result.externalId;
    expect(helloId).toMatch(/^<.+@.+>$/);

    const received = await eventually(async () => (await mailboxMessages(KEMI, 'INBOX')).find((m) => m.subject === subject), 'the hello in Kemi\'s mailbox');
    expect(received.from?.value[0]).toMatchObject({ name: 'Gabriel Femi', address: YOU });
    expect(received.to).toMatchObject({ value: [{ name: 'Kemi Okoye', address: KEMI }] });
    const unsubscribe = received.headerLines.find((h) => h.key === 'list-unsubscribe');
    expect(unsubscribe?.line).toBe(`List-Unsubscribe: <mailto:${YOU}?subject=stop>`);
    expect(received.headerLines.some((h) => h.key === 'x-callum')).toBe(false);
    expect(received.messageId).toBe(helloId);
    expect(received.text).toContain('I liked your note on payments.');
  }, 30_000);

  it('poll returns Kemi\'s reply with the quoted part stripped, once', async () => {
    expect(helloId).not.toBeNull();
    await sendAsKemi.sendMail({
      from: `"Kemi Okoye" <${KEMI}>`,
      to: YOU,
      subject: `Re: ${subject}`,
      inReplyTo: helloId ?? undefined,
      references: helloId ?? undefined,
      text: [
        'Yes, Thursday at 9:00 works for me.',
        '',
        `On Mon, Nov 2, 2026 at 9:03 AM Gabriel Femi <${YOU}> wrote:`,
        '> Hi Kemi,',
        '>',
        '> I liked your note on payments.',
      ].join('\n'),
    });
    const events = await eventually(async () => {
      const found = await adapter.poll(testStart);
      return found.length > 0 ? found : undefined;
    }, 'the reply from poll');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'reply', from: { email: KEMI, name: 'Kemi Okoye' }, text: 'Yes, Thursday at 9:00 works for me.' });
    expect((events[0] as { externalId: string | null }).externalId).toMatch(/^<.+@.+>$/);
    expect(Number.isNaN(Date.parse((events[0] as { at: string }).at))).toBe(false);

    expect(await adapter.poll(testStart)).toEqual([]);
  }, 30_000);

  it('poll returns a bounce for the address in a delivery status notification', async () => {
    const ghost = `ghost-${RUN}@okopay.test`;
    const dsn = [
      'From: Mail Delivery Subsystem <mailer-daemon@okopay.test>',
      `To: ${YOU}`,
      'Subject: Delivery Status Notification (Failure)',
      `Message-ID: <dsn-${RUN}@okopay.test>`,
      'Date: Mon, 02 Nov 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn-boundary"',
      '',
      '--dsn-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Your message to ${ghost} could not be delivered.`,
      '',
      '--dsn-boundary',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.okopay.test',
      '',
      `Final-Recipient: rfc822; ${ghost}`,
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 user unknown',
      '',
      '--dsn-boundary--',
      '',
    ].join('\r\n');
    await sendAsKemi.sendMail({ envelope: { from: 'mailer-daemon@okopay.test', to: [YOU] }, raw: dsn });
    const events = await eventually(async () => {
      const found = await adapter.poll(testStart);
      return found.length > 0 ? found : undefined;
    }, 'the bounce from poll');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'bounce', email: ghost, externalId: `<dsn-${RUN}@okopay.test>` });
    expect(await adapter.poll(testStart)).toEqual([]);
  }, 30_000);

  it('poll gives no bounce for a delay notice', async () => {
    const slow = `slow-${RUN}@okopay.test`;
    const notice = [
      'From: Mail Delivery Subsystem <mailer-daemon@okopay.test>',
      `To: ${YOU}`,
      'Subject: Delivery Status Notification (Delay)',
      `Message-ID: <delay-${RUN}@okopay.test>`,
      'Date: Mon, 02 Nov 2026 10:10:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="delay-boundary"',
      '',
      '--delay-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Delivery to ${slow} has been delayed. The server will keep trying.`,
      '',
      '--delay-boundary',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.okopay.test',
      '',
      `Final-Recipient: rfc822; ${slow}`,
      'Action: delayed',
      'Status: 4.4.1',
      '',
      '--delay-boundary--',
      '',
    ].join('\r\n');
    await sendAsKemi.sendMail({ envelope: { from: 'mailer-daemon@okopay.test', to: [YOU] }, raw: notice });
    // A reply sent after the notice proves the notice has been seen: poll returns it, and nothing for the delay.
    await sendAsKemi.sendMail({ from: `"Kemi Okoye" <${KEMI}>`, to: YOU, subject: `Second note ${RUN}`, text: 'One more thing.' });
    const events = await eventually(async () => {
      const found = await adapter.poll(testStart);
      return found.length > 0 ? found : undefined;
    }, 'the second note from poll');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'reply', text: 'One more thing.' });
  }, 30_000);

  it('a message in the Sent mailbox produces outbound_seen and a known address, but Callum\'s own mail does not', async () => {
    const client = imapClient(YOU);
    await client.connect();
    try {
      const boxes = await client.list();
      if (!boxes.some((b) => b.path === 'Sent' || b.specialUse === '\\Sent')) await client.mailboxCreate('Sent');
      const amara = `amara-${RUN}@zedco.test`;
      await client.append(
        'Sent',
        [`From: Gabriel Femi <${YOU}>`, `To: Amara Zed <${amara}>`, `Subject: Quick question ${RUN}`, `Message-ID: <sent-${RUN}@yourcompany.test>`, 'Date: Mon, 02 Nov 2026 10:00:00 +0000', 'Content-Type: text/plain', '', 'Hi Amara', ''].join('\r\n'),
        ['\\Seen'],
        new Date(),
      );
      // Mail clients such as Gmail also file Callum's own sends in Sent; those must not count.
      // The copy keeps the Message-ID the adapter returned from send().
      const hello = (await mailboxMessages(KEMI, 'INBOX')).find((m) => m.subject === subject);
      expect(hello).toBeDefined();
      const copy = await eventually(async () => {
        const kemi = imapClient(KEMI);
        await kemi.connect();
        const lock = await kemi.getMailboxLock('INBOX', { readOnly: true });
        try {
          for await (const msg of kemi.fetch('1:*', { source: true, envelope: true })) if (msg.envelope?.subject === subject) return msg.source;
        } finally {
          lock.release();
          await kemi.logout();
        }
        return undefined;
      }, 'the raw hello');
      await client.append('Sent', copy as Buffer, ['\\Seen'], new Date());

      const events = await adapter.poll(testStart);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'outbound_seen', email: amara, externalId: `<sent-${RUN}@yourcompany.test>` });
      expect(await adapter.poll(testStart)).toEqual([]);

      const known = (await adapter.knownAddresses?.()) ?? [];
      expect(known).toContain(amara);
      expect(known).toContain(KEMI);
      expect(known).not.toContain(YOU);
    } finally {
      await client.logout();
    }
  }, 30_000);
});
