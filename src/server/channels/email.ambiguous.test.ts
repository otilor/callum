import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmailAdapter } from './email.js';
import type { OutboundMessage } from './types.js';

const HELLO: OutboundMessage = {
  to: { name: 'Kemi Okoye', email: 'kemi@okopay.test', linkedinUrl: null, xHandle: null },
  kind: 'hello', subject: 'Hello from Ada', body: 'Hi Kemi', inReplyTo: null,
};

/** A small SMTP server on a local port. `afterData` decides what happens once the whole message has arrived. */
function smtpServer(afterData: (socket: Socket) => void): Promise<{ server: Server; port: number; data: string[] }> {
  const data: string[] = [];
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.write('220 test ESMTP\r\n');
    let buffer = '';
    let inData = false;
    let message = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) {
            message += buffer;
            buffer = '';
            return;
          }
          message += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          data.push(message);
          message = '';
          afterData(socket);
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        if (/^EHLO/i.test(line)) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/i.test(line)) socket.write('235 ok\r\n');
        else if (/^DATA/i.test(line)) {
          socket.write('354 go on\r\n');
          inData = true;
        } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, data })));
}

const secretFor = (port: number) => ({
  provider: 'custom', address: 'ada@okopay.test', name: 'Ada Obi', password: 'pw', smtpHost: '127.0.0.1', smtpPort: String(port), smtpSecure: 'false',
  imapHost: '127.0.0.1', imapPort: '1', imapSecure: 'false',
});

const open: Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('a send whose answer is lost', () => {
  it('is unknown, with its Message-ID, when the connection drops after the message was handed over', async () => {
    const { server, port, data } = await smtpServer((socket) => socket.destroy());
    open.push(server);
    const adapter = createEmailAdapter(secretFor(port));
    const result = await adapter.send(HELLO);
    await adapter.close();
    // The server did receive the whole message, and Callum never heard back: it must not be sent again on its own.
    expect(data).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown', messageId: expect.stringMatching(/^<[0-9a-f-]{36}@okopay\.test>$/) } });
    // The id in the error is the id that went out in the message.
    const error = result.ok ? null : result.error;
    expect(data[0]).toContain(`Message-ID: ${error?.messageId}`);
  });

  it('is temporary when the mail server cannot be reached at all, and the next try keeps the same Message-ID', async () => {
    const { server, port } = await smtpServer(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    const adapter = createEmailAdapter(secretFor(port));
    const first = await adapter.send(HELLO);
    const second = await adapter.send(HELLO);
    await adapter.close();
    expect(first).toMatchObject({ ok: false, error: { code: 'temporary', messageId: expect.any(String) } });
    expect(second).toMatchObject({ ok: false, error: { code: 'temporary' } });
    expect(second.ok ? null : second.error.messageId).toBe(first.ok ? null : first.error.messageId);
  });

  it('is temporary when the server answers 451 to the message, since nothing was accepted', async () => {
    const { server, port } = await smtpServer((socket) => socket.write('451 4.3.0 Try again later\r\n'));
    open.push(server);
    const adapter = createEmailAdapter(secretFor(port));
    expect(await adapter.send(HELLO)).toMatchObject({ ok: false, error: { code: 'temporary' } });
    await adapter.close();
  });

  it('sends with a fresh Message-ID for the next message, and gives the one that went out back as its id', async () => {
    const { server, port, data } = await smtpServer((socket) => socket.write('250 2.0.0 OK queued\r\n'));
    open.push(server);
    const adapter = createEmailAdapter(secretFor(port));
    const a = await adapter.send(HELLO);
    const b = await adapter.send({ ...HELLO, body: 'Another' });
    await adapter.close();
    expect(a).toMatchObject({ ok: true });
    const idA = a.ok ? a.externalId : null;
    const idB = b.ok ? b.externalId : null;
    expect(idA).not.toBe(idB);
    expect(data[0]).toContain(`Message-ID: ${idA}`);
    expect(data[1]).toContain(`Message-ID: ${idB}`);
  });
});
