import { describe, expect, it } from 'vitest';
import { findPlaceholders } from '../engine/guard.js';
import { fixedClock } from '../engine/clock.js';
import { findDate, inlineOffer, isExplicitOptOut, nameFromOffer, offerSentence, stripQuoted, TemplateWriter } from './templates.js';
import { inbound, outbound, testCtx, testPerson, testProject } from './testing.test-helpers.js';
import type { OutKind } from '../../shared/types.js';

const writer = new TemplateWriter(fixedClock('2026-11-02T10:00:00.000Z'));
const OFFER_FP = "I help fintech teams take reconciliation off their ops team's plate.";

describe('TemplateWriter.write', () => {
  it('hello, warm', async () => {
    const out = await writer.write('hello', testCtx());
    expect(out.body).toBe(`Hi Kemi, I've been following what Oko Pay is building. ${OFFER_FP} Would a quick chat be useful?`);
  });
  it('hello, direct', async () => {
    const out = await writer.write('hello', testCtx({ project: testProject({ tone: 'direct' }) }));
    expect(out.body).toBe(`Hi Kemi, ${OFFER_FP} Worth 15 minutes next week?`);
  });
  it('hello, playful', async () => {
    const out = await writer.write('hello', testCtx({ project: testProject({ tone: 'playful' }) }));
    expect(out.body).toBe(`Hi Kemi, quick question: who at Oko Pay would get the most out of this? ${OFFER_FP}`);
  });
  it('invite, thanks, reply, booking, close', async () => {
    const li = testCtx({ channel: 'linkedin' });
    expect((await writer.write('invite', li)).body).toBe(`Hi Kemi, ${OFFER_FP} Would love to connect.`);
    expect((await writer.write('thanks', li)).body).toBe(`Thanks for connecting, Kemi. ${OFFER_FP} Would a quick chat be useful?`);
    expect((await writer.write('reply', li)).body).toBe('Thanks, Kemi. Happy to share more. Would a short call this week work?');
    expect((await writer.write('booking', li)).body).toBe("Great. Here's my calendar, pick any time that suits you: https://cal.example.com/ada");
    expect((await writer.write('close', li)).body).toBe("Thanks for letting me know, Kemi. I won't follow up. All the best with Oko Pay.");
  });
  it('follow-up depends on how many notes went out', async () => {
    const one = await writer.write('follow_up', testCtx({ person: testPerson({ touches: 1 }) }));
    expect(one.body).toBe('Hi Kemi, following up on my note. Happy to share how this could work for Oko Pay.');
    const two = await writer.write('follow_up', testCtx({ person: testPerson({ touches: 2 }) }));
    expect(two.body).toBe('Hi Kemi, last note from me. If the timing is wrong, no problem at all.');
    const three = await writer.write('follow_up', testCtx({ person: testPerson({ touches: 3 }) }));
    expect(three.body).toBe(two.body);
  });
  it('falls back to "your team" without a company', async () => {
    const ctx = testCtx({ person: testPerson({ company: null, touches: 1 }) });
    expect((await writer.write('follow_up', ctx)).body).toContain('work for your team.');
    expect((await writer.write('close', ctx)).body).toContain('All the best with your team.');
  });
  it('writes the offer in the sender\'s voice, never "You help" to the recipient', async () => {
    for (const tone of ['warm', 'direct', 'playful'] as const) {
      const { body } = await writer.write('hello', testCtx({ project: testProject({ tone }) }));
      expect(body).not.toMatch(/\bYou help\b/);
      expect(body).toContain('I help fintech teams');
    }
  });
  it('uses a placeholder the guard blocks when there is no offer or calendar link', async () => {
    const noOffer = testCtx({ project: testProject({ offer: null, calendarUrl: null }) });
    const hello = await writer.write('hello', noOffer);
    expect(hello.body).toContain('[WHAT YOU OFFER]');
    expect(findPlaceholders(hello.body)).toEqual(['[WHAT YOU OFFER]']);
    const booking = await writer.write('booking', noOffer);
    expect(findPlaceholders(booking.body)).toEqual(['[YOUR CALENDAR LINK]']);
  });
  it('keeps an invite within 280 characters, even for a long offer', async () => {
    const long = `You help ${'fintech teams with a very long list of finance operations '.repeat(10)}`;
    const out = await writer.write('invite', testCtx({ channel: 'linkedin', project: testProject({ offer: long }) }));
    expect(out.body.length).toBeLessThanOrEqual(280);
    expect(out.body.startsWith('Hi Kemi, I help fintech teams')).toBe(true);
  });
  it('email subjects', async () => {
    expect((await writer.write('hello', testCtx())).subject).toBe('Quick question, Kemi');
    const history = [outbound()];
    for (const kind of ['follow_up', 'reply', 'booking', 'close'] as OutKind[]) {
      expect((await writer.write(kind, testCtx({ history }))).subject).toBe('Re: Quick question, Kemi');
    }
    expect((await writer.write('follow_up', testCtx())).subject).toBe('Re: Quick question, Kemi');
    expect((await writer.write('reply', testCtx({ history: [outbound({ subject: 'Reconciling Oko Pay' })] }))).subject).toBe('Re: Reconciling Oko Pay');
    expect((await writer.write('reply', testCtx({ history: [outbound({ subject: 'Re: Reconciling Oko Pay' })] }))).subject).toBe('Re: Reconciling Oko Pay');
  });
  it('has no subject on other channels', async () => {
    for (const channel of ['linkedin', 'x'] as const) {
      for (const kind of ['hello', 'follow_up', 'reply', 'booking', 'close'] as OutKind[]) {
        expect((await writer.write(kind, testCtx({ channel }))).subject).toBeNull();
      }
    }
  });
  it('never writes an exclamation mark, even when the offer has one', async () => {
    const project = testProject({ offer: 'You help teams close their books faster!' });
    for (const tone of ['warm', 'direct', 'playful'] as const) {
      for (const kind of ['hello', 'invite', 'thanks', 'follow_up', 'reply', 'booking', 'close'] as OutKind[]) {
        const out = await writer.write(kind, testCtx({ project: { ...project, tone }, person: testPerson({ touches: 1 }) }));
        expect(out.body).not.toContain('!');
        expect(out.subject ?? '').not.toContain('!');
      }
    }
  });
});

describe('offerSentence', () => {
  it('adds a final period and speaks as the sender', () => {
    expect(offerSentence('You help teams  close\nbooks')).toBe('I help teams close books.');
    expect(offerSentence("You're the finance team's second pair of hands. You're quick.")).toBe("I'm the finance team's second pair of hands. I'm quick.");
    expect(offerSentence('Payroll for Lagos teams.')).toBe('Payroll for Lagos teams.');
    expect(offerSentence('  ')).toBe('[WHAT YOU OFFER].');
  });
});

describe('classify', () => {
  const classify = (text: string, today = '2026-11-02T10:00:00.000Z') => new TemplateWriter(fixedClock(today)).classify(text, testCtx());

  it.each([
    ['Please take me off your list.', 'stop', 'close'],
    ['STOP', 'stop', 'close'],
    ['stop.', 'stop', 'close'],
    ['Unsubscribe', 'stop', 'close'],
    ['please remove me from this', 'stop', 'close'],
    ["Don't contact me again", 'stop', 'close'],
    ['Do not email me.', 'stop', 'close'],
    ['Please stop emailing me', 'stop', 'close'],
    ['This is spam. Go away.', 'hostile', 'close'],
    ['Leave me alone', 'hostile', 'close'],
    ['what a scam', 'hostile', 'close'],
    ['This is bullshit', 'hostile', 'close'],
    ["I'm not interested, thanks.", 'not_interested', 'close'],
    ['No thanks', 'not_interested', 'close'],
    ['No thank you.', 'not_interested', 'close'],
    ['Not a fit for us', 'not_interested', 'close'],
    ['no', 'not_interested', 'close'],
    ["We're all set, thanks", 'not_interested', 'close'],
    ["I don't have time for this", 'not_interested', 'close'],
    ['Not right now, maybe next quarter', 'not_now', 'snooze'],
    ['Not now, thanks', 'not_now', 'snooze'],
    ['Circle back in the new year', 'not_now', 'snooze'],
    ['Bad timing. Try again next month.', 'not_now', 'snooze'],
    ['Can you tell me more about pricing?', 'question', 'reply'],
    ['How does this work with NetSuite?', 'question', 'reply'],
    ['Do you work with companies outside Nigeria', 'question', 'reply'],
    ['Happy to chat, does Thursday work?', 'interested', 'book'],
    ["Let's talk", 'interested', 'book'],
    ['Sure, send me a calendar link', 'interested', 'book'],
    ['Can we do a quick call tomorrow?', 'interested', 'book'],
    ['Sounds good', 'interested', 'reply'],
    ['Yes, please tell me more.', 'interested', 'reply'],
    ['Interesting. We run 140 people on a spreadsheet today.', 'interested', 'reply'],
  ])('%s -> %s / %s', async (text, kind, suggested) => {
    const c = await classify(text);
    expect([c.kind, c.suggested]).toEqual([kind, suggested]);
    expect(c.language).toBe('en');
  });

  it('reads an out-of-office date and resolves it to the next such date', async () => {
    const c = await classify("I'm out of the office until 20 November");
    expect(c).toMatchObject({ kind: 'out_of_office', suggested: 'snooze', returnDate: '2026-11-20', referral: null });
  });
  it.each([
    ['Automatic reply: I am on leave until 2027-01-04.', '2027-01-04'],
    ['I am out of the office and will be back on November 9th.', '2026-11-09'],
    ['On annual leave, back 5 January', '2027-01-05'],
    ['OOO until Dec 1, 2026. For urgent matters contact Sam Bello.', '2026-12-01'],
    ['Away until 1 October', '2027-10-01'],
    ["I'm on leave until Monday", '2026-11-09'],
    ['Out of office, back on Thursday', '2026-11-05'],
    ['Out of the office. Back next week.', '2026-11-09'],
    ['I am out of the office with limited access to email.', null],
  ])('out of office: %s -> %s', async (text, returnDate) => {
    const c = await classify(text);
    expect(c.kind).toBe('out_of_office');
    expect(c.suggested).toBe('snooze');
    expect(c.returnDate).toBe(returnDate);
  });
  it('reads an out-of-office reply that quotes our note and its opt-out line', async () => {
    const text = [
      'I am away until 15 November.',
      '',
      'On Mon, 2 Nov 2026 at 09:00, Ada Obi <ada@example.com> wrote:',
      "> If this isn't for you, just reply stop and I won't write again.",
    ].join('\n');
    const c = await classify(text);
    expect(c).toMatchObject({ kind: 'out_of_office', returnDate: '2026-11-15' });
  });
  it('does not mistake our own opt-out line, quoted back, for a request to stop', async () => {
    const c = await classify("Sounds interesting, can we speak Friday?\n\n> Hi Kemi\n> If this isn't for you, just reply stop and I won't write again.");
    expect(c.kind).toBe('interested');
    expect((await classify("Thanks. If this isn't for you, just reply stop and I won't write again.")).kind).not.toBe('stop');
  });
  it('is not fooled by "spam folder" or "stop by"', async () => {
    expect((await classify('Your note went to my spam folder, sorry. Happy to chat.')).kind).toBe('interested');
    expect((await classify('Stop by our stand at the fair, chat then?')).kind).toBe('interested');
  });
  it('reads a referral with a name and email', async () => {
    const c = await classify('You should talk to Sam Bello (sam@okopay.com), she runs finance');
    expect(c).toMatchObject({
      kind: 'referral', suggested: 'reply',
      referral: { name: 'Sam Bello', email: 'sam@okopay.com' },
    });
    expect(c.referral?.context).toBe('You should talk to Sam Bello (sam@okopay.com), she runs finance');
  });
  it.each([
    ['Please reach out to Tunde Bakare, he handles this.', 'Tunde Bakare', null],
    ['Speak with Chioma. chioma.eze@okopay.com is her address.', 'Chioma', 'chioma.eze@okopay.com'],
    ["I'm not the right person. Contact Sam Bello at sam@okopay.com", 'Sam Bello', 'sam@okopay.com'],
    ['Try emailing sam.bello@okopay.com', 'Sam Bello', 'sam.bello@okopay.com'],
    ["I've looped in Femi Adeyemi, who owns this.", 'Femi Adeyemi', null],
  ])('referral: %s', async (text, name, email) => {
    const c = await classify(text);
    expect(c.kind).toBe('referral');
    expect(c.referral).toMatchObject({ name, email });
  });
  it('does not call "get in touch" or "contact me" a referral', async () => {
    expect((await classify('Please contact me on Thursday')).kind).not.toBe('referral');
    expect((await classify('Thanks for reaching out to me. Interested.')).kind).toBe('interested');
  });
  it('takes an explicit date for not-now, not a guess', async () => {
    expect(await classify('Not right now. Try me after 3 March.')).toMatchObject({ kind: 'not_now', returnDate: '2027-03-03' });
    expect((await classify('Not right now, maybe next quarter')).returnDate).toBeNull();
  });
  it('findDate resolves years and rejects impossible dates', () => {
    const today = new Date('2026-11-02T10:00:00Z');
    expect(findDate('on 2 November', today)).toBe('2026-11-02');
    expect(findDate('on 1 November', today)).toBe('2027-11-01');
    expect(findDate('31 February or 5th of Dec', today)).toBe('2026-12-05');
    expect(findDate('Nov 20, 2026', today)).toBe('2026-11-20');
    expect(findDate('may 2026 was busy', today)).toBeNull();
  });
  it('stripQuoted drops quoted history', () => {
    expect(stripQuoted('Yes\n> old\nOn Tue, Nov 3, 2026 at 9:00 AM Ada wrote:\nstuff')).toBe('Yes');
  });
});

describe('parseAsk', () => {
  const people = [
    { id: 11, name: 'Kemi Eze' },
    { id: 12, name: 'Nneka Obi' },
    { id: 13, name: 'Temi Alade' },
  ];
  const ask = (t: string) => writer.parseAsk(t, people);

  it('find more like', async () => {
    expect(await ask('find 20 more like Kemi')).toEqual({ intent: 'find', likePersonId: 11, query: null, count: 20 });
    expect(await ask('Find more like temi')).toEqual({ intent: 'find', likePersonId: 13, query: null, count: 20 });
    expect(await ask('find 200 more like Kemi')).toMatchObject({ count: 50 });
    expect(await ask('can you find 5 more people like Nneka please')).toEqual({ intent: 'find', likePersonId: 12, query: null, count: 5 });
  });
  it('find by description', async () => {
    expect(await ask('find 15 fintech founders in Lagos')).toEqual({ intent: 'find', likePersonId: null, query: 'fintech founders in Lagos', count: 15 });
    expect(await ask('find heads of finance')).toEqual({ intent: 'find', likePersonId: null, query: 'heads of finance', count: 20 });
  });
  it('pause and resume', async () => {
    expect(await ask('pause LinkedIn')).toEqual({ intent: 'pause', channel: 'linkedin' });
    expect(await ask('Pause email')).toEqual({ intent: 'pause', channel: 'email' });
    expect(await ask('pause x')).toEqual({ intent: 'pause', channel: 'x' });
    expect(await ask('resume linkedin')).toEqual({ intent: 'resume', channel: 'linkedin' });
    expect(await ask('please resume email.')).toEqual({ intent: 'resume', channel: 'email' });
  });
  it('tone', async () => {
    expect(await ask('use a warmer tone')).toEqual({ intent: 'tone', tone: 'warm' });
    expect(await ask('direct tone')).toEqual({ intent: 'tone', tone: 'direct' });
    expect(await ask('make it more playful')).toEqual({ intent: 'tone', tone: 'playful' });
    expect(await ask('sound more direct')).toEqual({ intent: 'tone', tone: 'direct' });
  });
  it('switch', async () => {
    expect(await ask('switch Nneka and Temi to email')).toEqual({ intent: 'switch', personIds: [12, 13], channel: 'email' });
    expect(await ask('move Kemi to LinkedIn')).toEqual({ intent: 'switch', personIds: [11], channel: 'linkedin' });
  });
  it('warm, why, unknown', async () => {
    expect(await ask("who's warm?")).toEqual({ intent: 'warm' });
    expect(await ask('who is warming up')).toEqual({ intent: 'warm' });
    expect(await ask('why did Kemi get a follow-up')).toEqual({ intent: 'why' });
    expect(await ask('Why is LinkedIn paused?')).toEqual({ intent: 'why' });
    expect(await ask('what is the weather')).toEqual({ intent: 'unknown' });
    expect(await ask('')).toEqual({ intent: 'unknown' });
    expect(await ask('switch Zed to email')).toEqual({ intent: 'unknown' });
  });
});

describe('offerLine and projectName', () => {
  it('rewrites "We help" as "You help"', async () => {
    expect(await writer.offerLine('We help fintech teams close their books in two days. Book a demo today.', 'okopay.com')).toBe('You help fintech teams close their books in two days.');
    expect(await writer.offerLine('We help growing teams run payroll', 'x.com')).toBe('You help growing teams run payroll.');
  });
  it('falls back to a placeholder the guard blocks', async () => {
    expect(await writer.offerLine('Welcome to our site. Cookies are used.', 'x.com')).toBe('[WHAT YOU OFFER]');
    expect(await writer.offerLine('   ', 'x.com')).toBe('[WHAT YOU OFFER]');
  });
  it('names a project from its offer', async () => {
    expect(await writer.projectName("You help fintech teams take reconciliation off their ops team's plate.")).toBe('Reconciliation');
    expect(await writer.projectName('You help growing teams in Lagos and Accra run payroll without spreadsheets.')).toBe('Payroll');
    expect(await writer.projectName('You help clinics with patient scheduling and billing.')).toBe('Patient Scheduling');
    expect(await writer.projectName('Hello')).toBe('My project');
    expect(nameFromOffer('')).toBe('My project');
  });
});

describe('classify: ordinary replies that look like a stop, an insult or an auto-reply', () => {
  const classify = (text: string, ctx = testCtx()) => writer.classify(text, ctx);
  const kindOf = async (text: string) => (await classify(text)).kind;

  it.each([
    ["We've been non-stop since launch. Can we talk next month?", 'not_now'],
    ["We're a one-stop shop for payments, how is this different?", 'question'],
    ['We are a nonstop operation right now. Interested though.', 'interested'],
    ['Please don\'t stop, keen to hear more.', 'interested'],
    ["I can't stop thinking about the reconciliation problem. Tell me more.", 'question'],
    ["Full stop, we're happy with our current setup.", 'not_interested'],
    ['Stop by our office on Thursday?', 'interested'],
    ['Sorry for the stupid delay. Yes, let\'s talk.', 'interested'],
    ['My idiot filter caught your note. Happy to chat.', 'interested'],
    ['We got hit by a payment scam last year. How do you handle fraud?', 'question'],
    ['Holy shit, this is exactly what we need.', 'interested'],
    ['Wtf, that is a great idea. Call me.', 'interested'],
  ])('%s -> %s', async (text, kind) => {
    expect(await kindOf(text)).toBe(kind);
  });

  it.each([
    'Stop', 'Stop.', 'Please stop.', 'STOP!', 'stop emailing me', 'Stop it', 'No thanks. Stop.',
    'Unsubscribe', 'Remove me from your list', "Don't email me again", 'Please opt out', 'take me off',
  ])('still stops: %s', async (text) => {
    expect(await kindOf(text)).toBe('stop');
  });
  it.each([
    'This is spam', 'Spam.', 'You are a scammer', "It's a scam", 'Fuck off', 'f*** off', 'Go to hell', 'Piss off',
    'What a scam', 'Stop spamming me', 'Leave me alone', 'This is bullshit',
  ])('still hostile: %s', async (text) => {
    expect(await kindOf(text)).toBe('hostile');
  });
  it('knows which replies are explicit opt-outs', () => {
    expect(isExplicitOptOut('Please take me off your list')).toBe(true);
    expect(isExplicitOptOut('STOP')).toBe(true);
    expect(isExplicitOptOut('Stop it, this is spam')).toBe(false);
    expect(isExplicitOptOut("Full stop, we're happy")).toBe(false);
  });

  it.each([
    ["We're currently out of budget for this. Maybe next year.", 'not_now'],
    ["Let's circle back on Monday.", 'interested'],
    ['Can we get back on Thursday to discuss?', 'interested'],
    ["I'm away from my desk but yes, interested.", 'interested'],
    ["I'm currently away from my laptop, call me on 0803 555 0100.", 'interested'],
    ['I will be back on the project in January, happy to talk then.', 'interested'],
  ])('not an auto-reply: %s -> %s', async (text, kind) => {
    expect(await kindOf(text)).toBe(kind);
  });
  it('"let\'s circle back on Monday" is offered as a booking, not parked', async () => {
    expect(await classify("Let's circle back on Monday.")).toMatchObject({ kind: 'interested', suggested: 'book', returnDate: null });
  });
  it('reads "out sick, back tomorrow" as out of office, back the next day', async () => {
    expect(await classify("I'm out sick today, back tomorrow.")).toMatchObject({ kind: 'out_of_office', suggested: 'snooze', returnDate: '2026-11-03' });
  });
  it.each([
    ['Automatic reply: limited access to email until 9 November', 'out_of_office'],
    ['I am on holiday until 14 December', 'out_of_office'],
    ['On parental leave, back 2 February 2027', 'out_of_office'],
  ])('auto-reply wording: %s', async (text, kind) => {
    expect(await kindOf(text)).toBe(kind);
  });
});

describe('classify: the date of the message', () => {
  it('resolves "until 20 November" against the inbound message date, not the clock', async () => {
    const late = new TemplateWriter(fixedClock('2026-12-15T10:00:00.000Z'));
    const ctx = testCtx({ history: [outbound(), inbound({ at: '2026-11-02T08:30:00.000Z' })] });
    expect((await late.classify("I'm out of the office until 20 November", ctx)).returnDate).toBe('2026-11-20');
    // without the history the clock decides
    expect((await late.classify("I'm out of the office until 20 November", testCtx())).returnDate).toBe('2027-11-20');
  });
  it('uses the latest inbound message when there are several', async () => {
    const ctx = testCtx({ history: [inbound({ id: 1, at: '2026-01-05T08:00:00.000Z' }), outbound({ id: 2 }), inbound({ id: 3, at: '2026-11-02T08:00:00.000Z' })] });
    expect((await writer.classify('away until 20 November', ctx)).returnDate).toBe('2026-11-20');
  });
});

describe('classify: referrals', () => {
  const classify = (text: string, ctx = testCtx()) => writer.classify(text, ctx);

  it('catches "contact my assistant Jane Doe"', async () => {
    const c = await classify('Please contact my assistant Jane Doe (jane@okopay.com) to set this up.');
    expect(c).toMatchObject({ kind: 'referral', referral: { name: 'Jane Doe', email: 'jane@okopay.com' } });
  });
  it('catches "try our CFO, Sam Bello"', async () => {
    const c = await classify('Try our CFO, Sam Bello.');
    expect(c).toMatchObject({ kind: 'referral', referral: { name: 'Sam Bello', email: null } });
  });
  it('catches "talk to our head of finance Sam Bello"', async () => {
    expect((await classify('You want our head of finance Sam Bello.')).kind).not.toBe('referral'); // no referral verb
    expect((await classify('Best to talk to our head of finance Sam Bello.')).referral?.name).toBe('Sam Bello');
  });
  it('does not invent a person from "Kemi\'s team" or a role mailbox', async () => {
    for (const text of ["email Kemi's team at ops@okopay.com", 'Please email ops@okopay.com', 'contact finance@okopay.com for this']) {
      const c = await classify(text);
      expect(c.kind).not.toBe('referral');
      expect(c.referral).toBeNull();
    }
  });
  it('still takes a mailbox that looks like a person', async () => {
    expect((await classify('Please email sam.bello@okopay.com')).referral).toMatchObject({ name: 'Sam Bello', email: 'sam.bello@okopay.com' });
  });
  it('never returns the sender or the replier as the referral', async () => {
    const ctx = testCtx();
    expect((await classify('Happy to talk to Ada, call me.', ctx)).kind).not.toBe('referral');
    expect((await classify('Happy to talk to Ada Obi.', ctx)).kind).not.toBe('referral');
    expect((await classify('Please contact Kemi Eze for this.', ctx)).kind).not.toBe('referral');
    expect((await classify('Contact Kemi, she handles it.', ctx)).kind).not.toBe('referral');
    expect((await classify('Contact ada@example.com for details', ctx)).kind).not.toBe('referral');
    expect((await classify('Talk to Ada Obi. Or talk to Sam Bello.', ctx)).referral?.name).toBe('Sam Bello');
  });
});

describe('parseAsk with people who share a first name', () => {
  const people = [
    { id: 1, name: 'Kemi Eze' },
    { id: 2, name: 'Kemi Adeyemi' },
    { id: 3, name: 'Temi Alade' },
  ];
  it('prefers the exact full name', async () => {
    expect(await writer.parseAsk('switch Kemi Adeyemi to email', people)).toEqual({ intent: 'switch', personIds: [2], channel: 'email' });
    expect(await writer.parseAsk('switch Kemi Eze and Temi to linkedin', people)).toEqual({ intent: 'switch', personIds: [1, 3], channel: 'linkedin' });
    expect(await writer.parseAsk('find 10 more like Kemi Adeyemi', people)).toEqual({ intent: 'find', likePersonId: 2, query: null, count: 10 });
  });
  it('does not act on both when it is ambiguous', async () => {
    expect(await writer.parseAsk('switch Kemi to email', people)).toEqual({ intent: 'unknown' });
    expect(await writer.parseAsk('switch Kemi and Temi to email', people)).toEqual({ intent: 'unknown' });
    expect(await writer.parseAsk('find more like Kemi', people)).toEqual({ intent: 'unknown' });
  });
});

describe('projectName rules', () => {
  it('does not take "easy" from "make it easy"', async () => {
    expect(await writer.projectName('You make it easy to pay contractors abroad.')).toBe('Contractors');
    expect(await writer.projectName('You make it easy to pay contractors abroad.')).not.toBe('Easy');
  });
});

describe('an offer that is not written as "You ..."', () => {
  const run = (offer: string, tone: 'warm' | 'direct' | 'playful') => writer.write('hello', testCtx({ project: testProject({ offer, tone }) }));

  it('reads as correct English after "Hi Kemi, "', async () => {
    expect((await run('We help fintech teams reconcile faster', 'direct')).body).toBe('Hi Kemi, we help fintech teams reconcile faster. Worth 15 minutes next week?');
    expect((await run('We help fintech teams reconcile faster', 'warm')).body).toBe("Hi Kemi, I've been following what Oko Pay is building. We help fintech teams reconcile faster. Would a quick chat be useful?");
    expect((await writer.write('invite', testCtx({ channel: 'linkedin', project: testProject({ offer: 'We help fintech teams reconcile faster' }) }))).body).toBe('Hi Kemi, we help fintech teams reconcile faster. Would love to connect.');
  });
  it('keeps the capital of acronyms, product words and proper nouns', async () => {
    expect((await run('AI-powered reconciliation for fintech teams', 'direct')).body).toBe('Hi Kemi, AI-powered reconciliation for fintech teams. Worth 15 minutes next week?');
    expect((await run('Oko Pay builds payroll for Lagos teams', 'direct')).body).toContain('Hi Kemi, Oko Pay builds');
    expect(inlineOffer('I help teams.')).toBe('I help teams.');
    expect(inlineOffer("I'm a bookkeeper.")).toBe("I'm a bookkeeper.");
  });
});
