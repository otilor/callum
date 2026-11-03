// Callum against a real mail server, no demo adapters anywhere.
//
// Starts GreenMail (a real SMTP + IMAP server) and Callum in normal mode (not demo), connects Callum's email the way a
// person with their own mail server does (the "another provider" form), and checks what lands in the mailboxes.
// Run it with `npm run test:real`. It needs Java and .cache/greenmail.jar (scripts/mail-it.sh and this script both fetch it).
//
// What is real: Callum's whole server, the database, the runner, the email adapter, SMTP, IMAP, the mailboxes read at the end.
// What is not: the clock. Callum is told what time it is, because a hello cannot go out on the day Start is pressed, and
// the follow-ups come days later. The mail itself is dated by GreenMail, in real time, so the clock only ever moves from a
// little in the past up to now, and then forward by whole days after every message that matters has been exchanged.
//
// Run 1: four people, hellos, a reply to answer, a "stop", the unsubscribe link, follow-ups over two weeks.
// Run 2: two projects sharing the email limit of 20 a day, and a pause of one of them.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import type { Clock } from '../src/server/engine/clock.js';
import { firstSlotAfterStart, isSendingTime } from '../src/server/engine/windows.js';
import { localParts } from '../src/server/engine/time.js';
import { startServer, type RunningServer } from '../src/server/main.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JAR = join(ROOT, '.cache', 'greenmail.jar');
const JAR_URL = 'https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/2.1.3/greenmail-standalone-2.1.3.jar';
const SMTP_PORT = Number(process.env.CALLUM_MAIL_SMTP_PORT ?? 3025);
const IMAP_PORT = Number(process.env.CALLUM_MAIL_IMAP_PORT ?? 3143);
const HOST = '127.0.0.1';
const PASSWORD = 'secret';
const OPT_OUT = "If this isn't for you, just reply stop and I won't write again.";
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ---- reporting -------------------------------------------------------------------------------

let failures = 0;
const say = (line = '') => console.log(line);
const heading = (line: string) => say(`\n== ${line}`);
function check(ok: boolean, what: string, detail?: string): void {
  if (!ok) failures++;
  say(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n        ${detail.replace(/\n/g, '\n        ')}` : ''}`);
}
const show = (label: string, text: string) => say(`        ${label}: ${text.replace(/\r?\n/g, '\n        ')}`);

// ---- GreenMail -------------------------------------------------------------------------------

const portOpen = (port: number) =>
  new Promise<boolean>((done) => {
    const s = createConnection({ host: HOST, port });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });

async function startGreenMail(users: string[]): Promise<ChildProcess> {
  if (!existsSync(JAR)) {
    mkdirSync(dirname(JAR), { recursive: true });
    say('Downloading GreenMail 2.1.3');
    const res = await fetch(JAR_URL);
    if (!res.ok) throw new Error(`Could not fetch GreenMail (${res.status}). Put greenmail-standalone-2.1.3.jar at ${JAR}.`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(JAR, Buffer.from(await res.arrayBuffer()));
  }
  if ((await portOpen(SMTP_PORT)) || (await portOpen(IMAP_PORT))) throw new Error(`Port ${SMTP_PORT} or ${IMAP_PORT} is already in use. Stop that server first.`);
  const accounts = users.map((u) => `${u.split('@')[0]}:${PASSWORD}@${u.split('@')[1]}`).join(',');
  const child = spawn(
    'java',
    [`-Dgreenmail.setup.test.smtp.port=${SMTP_PORT}`, `-Dgreenmail.setup.test.imap.port=${IMAP_PORT}`, '-Dgreenmail.setup.test.smtp', '-Dgreenmail.setup.test.imap', `-Dgreenmail.users=${accounts}`, '-Dgreenmail.users.login=email', `-Dgreenmail.hostname=${HOST}`, '-jar', JAR],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 150; i++) {
    if ((await portOpen(SMTP_PORT)) && (await portOpen(IMAP_PORT))) return child;
    if (child.exitCode !== null) throw new Error('GreenMail stopped early. Is Java installed?');
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('GreenMail did not open its ports in 30 seconds.');
}

async function inbox(user: string): Promise<ParsedMail[]> {
  const client = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, doSTARTTLS: false, auth: { user, pass: PASSWORD }, logger: false });
  client.on('error', () => undefined);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const sources: Buffer[] = [];
    if (client.mailbox && typeof client.mailbox === 'object' && client.mailbox.exists > 0) {
      for await (const msg of client.fetch('1:*', { source: true })) if (msg.source) sources.push(msg.source);
    }
    return await Promise.all(sources.map((s) => simpleParser(s)));
  } finally {
    lock.release();
    await client.logout();
  }
}

const smtp = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true });

// ---- the clock Callum goes by ----------------------------------------------------------------

/** The computer's clock plus an offset. Moving the offset is how the run gets to "tomorrow at 9:00". */
class OffsetClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

const ZONES = [
  'Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Halifax', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/London', 'Africa/Lagos', 'Africa/Johannesburg', 'Europe/Moscow',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Noumea', 'Pacific/Auckland', 'Pacific/Kiritimati',
];

interface Timing {
  zone: string;
  /** Callum's clock while the run sets things up: far enough back that the first slot after Start has already passed in real time. */
  startOffset: number;
  /** Callum's clock for the mail itself: now, or, when no sending hours are open anywhere, a few days back. */
  sendOffset: number;
}

/** Picks a time zone whose sending hours (9:00 to 17:00 on a weekday) are open now and for the next quarter hour. */
function pickTiming(): Timing {
  const real = Date.now();
  for (let backDays = 0; backDays <= 3; backDays++) {
    const sendOffset = -backDays * DAY;
    const at = real + sendOffset;
    for (const zone of ZONES) {
      if (!isSendingTime(new Date(at), zone) || !isSendingTime(new Date(at + 15 * 60_000), zone)) continue;
      for (let h = 1; h <= 120; h++) {
        const startOffset = sendOffset - h * HOUR;
        if (firstSlotAfterStart(new Date(real + startOffset), zone).getTime() <= at - 60_000) return { zone, startOffset, sendOffset };
      }
    }
  }
  throw new Error('No time zone has sending hours open now or in the last three days. This cannot happen.');
}

// ---- driving Callum --------------------------------------------------------------------------

interface Person { id: number; name: string; firstName: string; email: string | null; status: string; stage: string; replyKind: string | null; draft: string | null; touches: number; projectId: number }
interface Outbox { id: number; personId: number; kind: string; state: string; body: string }
interface State { people: Person[]; outbox: Outbox[]; projects: Array<{ id: number; name: string; state: string; approvalsLeft: number }>; brief: { wantToTalk: number } }

class Callum {
  constructor(readonly server: RunningServer, readonly clock: OffsetClock, readonly dataDir: string) {}
  async api<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.server.url}/api${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  }
  state = () => this.api<State>('GET', '/state');
  /** One pass of the runner: poll, send what is due, plan what comes next. */
  async pass(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) await this.server.runner.tick();
  }
  /** OKs everything waiting for an OK, the way the Day one screen does. */
  async approveAll(): Promise<number> {
    let n = 0;
    for (const o of (await this.state()).outbox.filter((x) => x.state === 'awaiting_ok')) {
      await this.api('POST', `/outbox/${o.id}/approve`, {});
      n++;
    }
    return n;
  }
  rows<T = Record<string, unknown>>(sql: string, ...params: Array<string | number>): T[] {
    // The database Callum itself writes to, opened read only beside it.
    const db = new DatabaseSync(join(this.dataDir, 'callum.db'), { readOnly: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }
  async stop(): Promise<void> {
    await this.server.close();
  }
}

async function boot(dataDir: string, timing: Timing, who: { address: string; name: string }): Promise<Callum> {
  const clock = new OffsetClock();
  clock.offsetMs = timing.startOffset;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Normal mode: no demo adapters, and no Claude (no key, no Claude Code), so Callum writes with its own templates.
  delete env.CALLUM_DEMO;
  delete env.ANTHROPIC_API_KEY;
  env.CALLUM_CLAUDE_CODE = 'off';
  const server = await startServer({
    dataDir, host: '127.0.0.1', port: 0, password: null, webDir: null, env, clock,
    // The run does the passes itself, and looks in the mailbox on every one. Send spacing (one automatic send per channel
    // per pass, then a random 45 to 150 s) has its own tests; this run is about what reaches the mailboxes and when, and
    // 20 sends a day would otherwise need over half an hour of sending hours, so here everything due goes in the pass.
    tickEveryMs: 3_600_000, runnerOptions: { pollEveryMs: { email: 0 }, spacing: false }, log: () => undefined,
  });
  const callum = new Callum(server, clock, dataDir);
  if (server.ctx.demo) throw new Error('This run must not be in demo mode.');
  await callum.api('POST', '/settings', { senderName: who.name, timezone: timing.zone });
  await callum.api('POST', '/channels/email/connect', {
    provider: 'custom', address: who.address, name: who.name, password: PASSWORD,
    smtpHost: HOST, smtpPort: String(SMTP_PORT), imapHost: HOST, imapPort: String(IMAP_PORT),
  });
  return callum;
}

const bodyOf = (m: ParsedMail) => (m.text ?? '').replace(/\r\n/g, '\n').trim();
const fromOf = (m: ParsedMail) => m.from?.text ?? '';
/** The header as it was on the wire. */
const headerLine = (m: ParsedMail, name: string) => m.headerLines.find((h) => h.key === name.toLowerCase())?.line.replace(/\r?\n\s*/g, ' ') ?? '';
const placeholder = /\[[A-Z][A-Z ]+\]|\{\{[^}]*\}\}|\{[a-z_]+\}/;

// ---- run 1: four people ---------------------------------------------------------------------

const YOU = 'you@callum.test';
const ADDRESS = { kemi: 'kemi@okopay.test', tunde: 'tunde@iretilabs.test', bisi: 'bisi@ikoyipay.test', chidi: 'chidi@lagosledger.test' };
const COUNT = Object.keys(ADDRESS).length;

async function runOne(timing: Timing): Promise<void> {
  heading(`Run 1: four people, one real mailbox each (recipients in ${timing.zone})`);
  const dataDir = mkdtempSync(join(tmpdir(), 'callum-real-'));
  const callum = await boot(dataDir, timing, { address: YOU, name: 'Gabriel Femi' });
  try {
    const email = callum.server.ctx.repo.listChannels().find((c) => c.channel === 'email');
    check(email?.status === 'connected' && email.identity === YOU, 'email is connected through the custom provider form (SMTP and IMAP on localhost, no TLS)', `${email?.channel}: ${email?.status}, ${email?.identity}`);

    // A real first start has no demo scene: the project is made the way New project makes it.
    const project = await callum.api<{ id: number }>('POST', '/projects', {
      name: 'Reconciliation', offer: "You help fintech teams take reconciliation off their ops team's plate.", audience: 'Founders at fintechs in Lagos', tone: 'warm',
    });
    await callum.api('POST', `/projects/${project.id}`, { calendarUrl: 'https://cal.example.com/gabriel' });
    const added = await callum.api<{ added: Person[]; skipped: unknown[] }>('POST', '/leads/import', {
      projectId: project.id,
      paste: `Kemi Eze, ${ADDRESS.kemi}, Oko Pay\nTunde Bello, ${ADDRESS.tunde}, Ireti Labs\nBisi Alade, ${ADDRESS.bisi}, Ikoyi Pay\nChidi Okeke, ${ADDRESS.chidi}, Lagos Ledger`,
    });
    check(added.added.length === COUNT && added.skipped.length === 0, `imported ${COUNT} people from a pasted list`, added.added.map((p) => `${p.name} <${p.email}>`).join(', '));

    await callum.api('POST', '/start', { projectId: project.id });
    let s = await callum.state();
    const waiting = s.outbox.filter((o) => o.state === 'awaiting_ok');
    check(waiting.length === COUNT && waiting.every((o) => o.kind === 'hello'), `Start wrote ${COUNT} first hellos and they wait for an OK`, waiting.map((o) => `#${o.id} ${o.state}`).join(', '));
    check((await Promise.all(Object.values(ADDRESS).map((a) => inbox(a)))).every((m) => m.length === 0), 'nothing has been sent yet (every mailbox is empty)');

    check((await callum.approveAll()) === COUNT, `OK on the first ${COUNT} hellos`);
    // The clock catches up to the real one: the first slot after Start has come.
    callum.clock.offsetMs = timing.sendOffset;
    await callum.pass(3);
    s = await callum.state();
    const sentRows = callum.rows<{ state: string }>("select state from outbox where kind = 'hello'");
    check(sentRows.length === COUNT && sentRows.every((r) => r.state === 'sent'), `the runner sent all ${COUNT} hellos`, sentRows.map((r) => r.state).join(', '));

    // What arrived, read from the recipients' own mailboxes over IMAP.
    const hellos: Record<string, ParsedMail> = {};
    for (const [first, address] of Object.entries(ADDRESS)) {
      const mails = await inbox(address);
      check(mails.length === 1, `${address} has exactly one message`, `${mails.length} in the inbox`);
      const m = mails[0];
      if (!m) continue;
      hellos[first] = m;
      const text = bodyOf(m);
      check(fromOf(m).includes('Gabriel Femi') && fromOf(m).includes(YOU), `  From is ${fromOf(m)}`);
      check(text.endsWith(`\n\n${OPT_OUT}`), '  the body ends with the opt-out line, after a blank line');
      check(headerLine(m, 'list-unsubscribe').includes(`mailto:${YOU}`), '  List-Unsubscribe points back at the sender', headerLine(m, 'list-unsubscribe'));
      check(!placeholder.test(`${m.subject}\n${text}`), '  no placeholder in the subject or body');
      check(text.toLowerCase().includes(first), `  it is written to ${first[0]?.toUpperCase()}${first.slice(1)}`);
    }
    const kemiHello = hellos.kemi;
    if (kemiHello) {
      say('        --- Kemi\'s hello, as delivered ---');
      show('From', fromOf(kemiHello));
      show('To', kemiHello.to ? (Array.isArray(kemiHello.to) ? kemiHello.to.map((t) => t.text).join(', ') : kemiHello.to.text) : '');
      show('Subject', kemiHello.subject ?? '');
      show('Message-ID', kemiHello.messageId ?? '');
      show('List-Unsubscribe', headerLine(kemiHello, 'list-unsubscribe'));
      show('Body', bodyOf(kemiHello));
    }

    // Kemi writes back, as a reply to the hello.
    const kemi = (await callum.state()).people.find((p) => p.email === ADDRESS.kemi)!;
    const tunde = (await callum.state()).people.find((p) => p.email === ADDRESS.tunde)!;
    const kemiSaid = 'Happy to chat, does Thursday work?';
    await smtp.sendMail({
      from: `Kemi Eze <${ADDRESS.kemi}>`, to: YOU, subject: `Re: ${kemiHello?.subject ?? ''}`, text: kemiSaid,
      ...(kemiHello?.messageId ? { inReplyTo: kemiHello.messageId, references: kemiHello.messageId } : {}),
    });
    await callum.pass(2);
    s = await callum.state();
    const k = s.people.find((p) => p.id === kemi.id)!;
    check(k.status === 'waiting' && k.replyKind === 'interested', 'Callum polled the mailbox: Kemi is on the dock, read as interested', `status ${k.status}, reply ${k.replyKind}, ${s.brief.wantToTalk} want to talk`);
    check(Boolean(k.draft) && !placeholder.test(k.draft ?? ''), 'Callum drafted a reply for her', k.draft ?? '(no draft)');
    const kept = callum.rows<{ body: string; direction: string }>("select body, direction from messages where person_id = ? and direction = 'in'", kemi.id);
    check(kept.length === 1 && kept[0]!.body.includes('Happy to chat'), 'her words were saved without the quoted hello under them', kept[0]?.body);

    // The user replies from the deck: the draft, sent as it is.
    await callum.api('POST', `/people/${kemi.id}/reply`, { body: k.draft });
    callum.clock.offsetMs += 11_000; // the ten second Undo window closes
    await callum.pass(2);
    const kemiMail = await inbox(ADDRESS.kemi);
    const answer = kemiMail.find((m) => m.messageId !== kemiHello?.messageId);
    check(kemiMail.length === 2 && answer !== undefined, 'the reply arrived in Kemi\'s inbox', `${kemiMail.length} messages`);
    if (answer) {
      const theirMessageId = callum.rows<{ external_id: string | null }>("select external_id from messages where person_id = ? and direction = 'in'", kemi.id)[0]?.external_id;
      check(answer.inReplyTo === theirMessageId && theirMessageId !== null, 'the reply is threaded: In-Reply-To is the id of Kemi\'s message', `In-Reply-To ${answer.inReplyTo}  |  Kemi's Message-ID ${theirMessageId}`);
      check(String(answer.references ?? '').includes(theirMessageId ?? '?') , 'References carries it too', String(answer.references));
      check(/^re:/i.test(answer.subject ?? ''), 'the subject keeps the thread', answer.subject ?? '');
      check(fromOf(answer).includes(YOU), 'it is from the same address', fromOf(answer));
      show('Reply body', bodyOf(answer));
    }
    s = await callum.state();
    check(s.people.find((p) => p.id === kemi.id)!.status !== 'waiting' && s.brief.wantToTalk === 0, 'Kemi left the dock once the reply went', `status ${s.people.find((p) => p.id === kemi.id)!.status}`);

    // Tunde says stop.
    await smtp.sendMail({ from: `Tunde Bello <${ADDRESS.tunde}>`, to: YOU, subject: `Re: ${hellos.tunde?.subject ?? ''}`, text: 'Please stop emailing me.', ...(hellos.tunde?.messageId ? { inReplyTo: hellos.tunde.messageId } : {}) });
    await callum.pass(2);
    const t = (await callum.state()).people.find((p) => p.id === tunde.id)!;
    check(t.status === 'stopped', 'Tunde wrote "Please stop emailing me." and is stopped', `status ${t.status}`);
    check(callum.rows("select * from outbox where person_id = ? and state in ('awaiting_ok','scheduled','sending')", tunde.id).length === 0, 'nothing is queued for Tunde');

    // Chidi uses the unsubscribe link in his mail program. It opens a message to the address in List-Unsubscribe,
    // with the subject "stop" and nothing in the body.
    const chidi = (await callum.state()).people.find((p) => p.email === ADDRESS.chidi)!;
    const unsubscribe = hellos.chidi ? headerLine(hellos.chidi, 'list-unsubscribe').match(/<mailto:([^?>]+)\?subject=([^>]+)>/) : null;
    await smtp.sendMail({ from: `Chidi Okeke <${ADDRESS.chidi}>`, to: unsubscribe?.[1] ?? YOU, subject: unsubscribe?.[2] ?? 'stop', text: '' });
    await callum.pass(2);
    const c = (await callum.state()).people.find((p) => p.id === chidi.id)!;
    check(c.status === 'stopped', 'Chidi used the unsubscribe link (subject "stop", empty body) and is stopped', `status ${c.status}, reply ${c.replyKind}`);
    check(callum.rows("select * from outbox where person_id = ? and state in ('awaiting_ok','scheduled','sending')", chidi.id).length === 0, 'nothing is queued for Chidi');

    // Two weeks go by, a day at a time, with a pass on each.
    const before = callum.rows<{ n: number }>("select count(*) as n from outbox where state = 'sent'")[0]!.n;
    for (let day = 1; day <= 14; day++) {
      callum.clock.offsetMs += DAY;
      await callum.pass(2);
    }
    const tundeMail = await inbox(ADDRESS.tunde);
    check(tundeMail.length === 1, 'two weeks later Tunde still has only the one message (no follow-up, ever)', `${tundeMail.length} message(s)`);
    check(callum.rows("select * from outbox where person_id = ? and kind != 'hello'", tunde.id).length === 0, 'and no follow-up was ever queued for him');
    check((await inbox(ADDRESS.chidi)).length === 1 && callum.rows("select * from outbox where person_id = ? and kind != 'hello'", chidi.id).length === 0, 'the same for Chidi: one message in two weeks, no follow-up queued');
    const kemiAfter = await inbox(ADDRESS.kemi);
    check(kemiAfter.length === 2, 'Kemi, who is talking with the user, got no automatic follow-ups', `${kemiAfter.length} messages`);
    const bisiMail = (await inbox(ADDRESS.bisi)).sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
    check(bisiMail.length === 3, 'Bisi, who never answered, got hello + 2 follow-ups in two weeks (gaps of 4 then 6 days)', `${bisiMail.length} messages: ${bisiMail.map((m) => m.subject).join(' | ')}`);
    check(bisiMail.every((m) => bodyOf(m).endsWith(OPT_OUT)), 'every one of them carries the opt-out line');
    check(callum.rows<{ n: number }>("select count(*) as n from outbox where state = 'sent'")[0]!.n - before === 2, 'two sends in the two weeks in all (both Bisi\'s)');
    say('        the sent-mail log for the run:');
    for (const r of callum.rows<{ at: string; person: string; kind: string; direction: string }>("select m.at as at, p.name as person, m.kind as kind, m.direction as direction from messages m join people p on p.id = m.person_id order by m.id")) {
      say(`          ${r.at}  ${r.direction === 'out' ? 'out' : ' in'}  ${r.kind.padEnd(10)} ${r.person}`);
    }
  } finally {
    await callum.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---- run 2: two projects, one email limit ----------------------------------------------------

const CAP_YOU = 'cap@callum.test';
const alpha = Array.from({ length: 15 }, (_, i) => `a${String(i + 1).padStart(2, '0')}@alpha.test`);
const beta = Array.from({ length: 15 }, (_, i) => `b${String(i + 1).padStart(2, '0')}@beta.test`);

async function runTwo(timing: Timing): Promise<void> {
  heading('Run 2: two projects share the email limit of 20 a day, and one is paused');
  const dataDir = mkdtempSync(join(tmpdir(), 'callum-real-'));
  const callum = await boot(dataDir, timing, { address: CAP_YOU, name: 'Gabriel Femi' });
  try {
    const list = (addresses: string[], company: string) => addresses.map((a, i) => `Person ${a.slice(0, 3)}, ${a}, ${company} ${i + 1}`).join('\n');
    const first = await callum.api<{ id: number }>('POST', '/projects', { name: 'Reconciliation', offer: 'You help fintech teams take reconciliation off their ops team.', tone: 'warm' });
    const second = await callum.api<{ id: number }>('POST', '/projects', { name: 'Payroll', offer: 'You help growing teams run payroll without spreadsheets.', tone: 'direct' });
    await callum.api('POST', '/leads/import', { projectId: first.id, paste: list(alpha, 'Alpha') });
    await callum.api('POST', '/leads/import', { projectId: second.id, paste: list(beta, 'Beta') });
    await callum.api('POST', '/start', { projectId: first.id });
    await callum.api('POST', '/start', { projectId: second.id });
    // The first ten of each project need an OK; the rest follow once those are given.
    for (let i = 0; i < 4; i++) {
      await callum.approveAll();
      await callum.pass();
    }
    await callum.api('POST', `/projects/${second.id}/pause`, { until: null });
    check((await callum.state()).projects.map((p) => `${p.name}:${p.state}`).join(', ') === 'Reconciliation:running, Payroll:paused', 'Payroll is paused, Reconciliation is running');

    const byProject = () => callum.rows<{ project: number; n: number }>("select p.project_id as project, count(*) as n from messages m join people p on p.id = m.person_id where m.direction = 'out' and m.kind = 'hello' and m.channel = 'email' group by p.project_id");
    const sentFor = (projectId: number) => byProject().find((r) => r.project === projectId)?.n ?? 0;
    const sentToday = () => sentFor(first.id) + sentFor(second.id);

    callum.clock.offsetMs = timing.sendOffset;
    await callum.pass(4);
    check(sentFor(first.id) === 15 && sentFor(second.id) === 0, 'with Payroll paused, Reconciliation sends all 15 and Payroll sends none', `Reconciliation ${sentFor(first.id)}, Payroll ${sentFor(second.id)}`);

    await callum.api('POST', `/projects/${second.id}/resume`, {});
    await callum.pass(4);
    check(sentToday() === 20, 'after Payroll resumes the day stops at 20 together: Payroll gets the 5 that are left of the limit', `Reconciliation ${sentFor(first.id)} + Payroll ${sentFor(second.id)} = ${sentToday()}`);
    await callum.pass(4);
    check(sentToday() === 20, 'more passes the same day send nothing more', `still ${sentToday()}`);
    const perDay = () => callum.rows<{ at: string }>("select at from messages where direction = 'out' and kind = 'hello'").map((r) => localParts(new Date(r.at), timing.zone)).reduce<Record<string, number>>((acc, p) => {
      const key = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    // The other 10 go on the next sending days, never more than 20 on any one day.
    for (let day = 1; day <= 6 && sentToday() < 30; day++) {
      callum.clock.offsetMs += DAY;
      await callum.pass(4);
    }
    const days = perDay();
    check(sentToday() === 30, 'all 30 hellos went out over the following days', JSON.stringify(days));
    check(Math.max(...Object.values(days)) <= 20, 'no day, in either project or both, went over 20', Object.entries(days).map(([d, n]) => `${d}: ${n}`).join('  '));
    const delivered = await Promise.all([...alpha, ...beta].map(async (a) => (await inbox(a)).length));
    check(delivered.every((n) => n === 1), 'each of the 30 mailboxes has exactly one hello', `${delivered.reduce((a, b) => a + b, 0)} messages in 30 mailboxes`);
  } finally {
    await callum.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---- main ------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const timing = pickTiming();
  say(`Callum real-mail run. Time zone ${timing.zone}; the clock starts ${Math.round(-timing.startOffset / HOUR)} h back and meets the real one when the first hellos are due${timing.sendOffset === 0 ? '' : ` (no sending hours are open anywhere right now, so mail is sent ${-timing.sendOffset / DAY} day(s) back)`}.`);
  const users = [YOU, ...Object.values(ADDRESS), CAP_YOU, ...alpha, ...beta];
  const greenmail = await startGreenMail(users);
  try {
    await runOne(timing);
    await runTwo(timing);
  } finally {
    smtp.close();
    greenmail.kill();
  }
  say(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
