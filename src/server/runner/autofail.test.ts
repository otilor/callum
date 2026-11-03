import { describe, expect, it } from 'vitest';
import { editBlocked, retry } from '../services/actions.js';
import { personDetail } from '../services/person.js';
import { resumeChannel } from './incidents.js';
import { Runner } from './runner.js';
import { ctxWith, harness, NOW, type Harness } from './testing.test-helpers.js';

// Callum's own messages that are stopped or do not go must never freeze a person without saying so.

const FOLLOW_UP = { touches: 1, stage: 'hello' as const, lastTouchAt: '2026-10-29T09:00:00.000Z', nextTouchAt: NOW };
const BLANK = { subject: 'Following up', body: 'Hi, the pilot is [YOUR PRICE] for the first month. Worth a look?' };

function runnerFor(h: Harness, ctx = h.ctx) {
  const errors: unknown[] = [];
  return { runner: new Runner(ctx, { onError: (e) => errors.push(e), spacing: false }), errors };
}
const open = (h: Harness) => h.ctx.repo.listIncidents({ open: true });
const detailOf = (i: { detail: string | null }) => JSON.parse(i.detail ?? 'null') as { auto: boolean; day: string; outboxId: number; outboxIds: number[]; personIds: number[] };

describe('a message with a blank in it', () => {
  it('is one notice for the channel and day however many people it holds, with the people on it', async () => {
    const h = harness();
    const ctx = ctxWith(h, { write: async () => BLANK });
    const people = Array.from({ length: 20 }, () => h.person({ ...FOLLOW_UP }));
    const { runner, errors } = runnerFor(h, ctx);
    await runner.tick();
    expect(errors).toEqual([]);
    expect(h.ctx.repo.listOutbox({ state: ['blocked'] })).toHaveLength(20);
    expect(h.adapters.email.sent).toEqual([]);
    const incidents = open(h);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: 'send_failed', channel: 'email', personId: null, message: "Callum couldn't send 20 follow-ups by email today" });
    const detail = detailOf(incidents[0]!);
    expect(detail.auto).toBe(true);
    expect(detail.personIds.sort((a, b) => a - b)).toEqual(people.map((p) => p.id));
    expect(detail.outboxIds).toHaveLength(20);
    // Another tick does not add a card, nor change the count.
    await runner.tick();
    expect(open(h)).toHaveLength(1);
  });

  it('says "a follow-up" for one and names the channel as the user does', async () => {
    const h = harness();
    const ctx = ctxWith(h, { write: async () => BLANK });
    h.person({ ...FOLLOW_UP });
    await runnerFor(h, ctx).runner.tick();
    expect(open(h)[0]?.message).toBe("Callum couldn't send a follow-up by email today");
    expect(open(h)[0]?.message).not.toContain('!');
  });

  it('keeps channels apart, and a new day gets a new notice that says which day the old one was for', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const ctx = ctxWith(h, { write: async () => BLANK });
    h.person({ ...FOLLOW_UP });
    h.person({ ...FOLLOW_UP, email: null, channel: 'linkedin', linkedinState: 'connected', linkedinUrl: 'https://www.linkedin.com/in/ada-l', invitedAt: '2026-10-20T09:00:00.000Z' });
    const { runner } = runnerFor(h, ctx);
    await runner.tick();
    expect(open(h).map((i) => `${i.channel}: ${i.message}`).sort()).toEqual([
      "email: Callum couldn't send a follow-up by email today",
      "linkedin: Callum couldn't send a thank-you by LinkedIn today",
    ]);
    h.clock.advance(86_400_000);
    h.person({ ...FOLLOW_UP, nextTouchAt: h.clock.now().toISOString() });
    await runner.tick();
    const emails = open(h).filter((i) => i.channel === 'email');
    expect(emails.map((i) => i.message).sort()).toEqual(["Callum couldn't send a follow-up by email on Tuesday", "Callum couldn't send a follow-up by email today"].sort());
  });

  it('names an older day by its date, so a week-old Tuesday is not mistaken for yesterday', async () => {
    const h = harness();
    const ctx = ctxWith(h, { write: async () => BLANK });
    h.person({ ...FOLLOW_UP });
    const { runner } = runnerFor(h, ctx);
    await runner.tick();
    h.clock.advance(14 * 86_400_000);
    await runner.tick();
    expect(open(h)[0]?.message).toBe("Callum couldn't send a follow-up by email on 3 November");
  });

  it('is fixed with editBlocked: the notice follows the people who are still stuck, and goes when none are', async () => {
    const h = harness();
    const ctx = ctxWith(h, { write: async () => BLANK });
    const a = h.person({ ...FOLLOW_UP });
    const b = h.person({ ...FOLLOW_UP });
    const { runner } = runnerFor(h, ctx);
    await runner.tick();
    const [first, second] = h.ctx.repo.listOutbox({ state: ['blocked'] });
    expect(open(h)[0]?.message).toBe("Callum couldn't send 2 follow-ups by email today");

    editBlocked(h.ctx, first!.id, 'Hi, the pilot is 400 dollars for the first month. Worth a look?');
    expect(open(h)[0]?.message).toBe("Callum couldn't send a follow-up by email today");
    expect(detailOf(open(h)[0]!).outboxIds).toEqual([second!.id]);
    expect(detailOf(open(h)[0]!).personIds).toEqual([second!.personId]);

    editBlocked(h.ctx, second!.id, 'Hi, the pilot is 400 dollars. Worth a look?');
    expect(open(h)).toEqual([]);
    // Both go out on the next pass, and nothing is stuck.
    await runner.tick();
    expect(h.adapters.email.sent.map((m) => m.to.email).sort()).toEqual([a.email, b.email].sort());
    expect(h.adapters.email.sent[0]?.body).toContain('400 dollars');
  });

  it('refuses a fix that still has a blank, in words, and keeps the notice', async () => {
    const h = harness();
    const ctx = ctxWith(h, { write: async () => BLANK });
    h.person({ ...FOLLOW_UP });
    await runnerFor(h, ctx).runner.tick();
    const item = h.ctx.repo.listOutbox({ state: ['blocked'] })[0]!;
    expect(() => editBlocked(h.ctx, item.id, 'Still [YOUR PRICE] here')).toThrow(/Add your price first/);
    expect(open(h)).toHaveLength(1);
  });

  it('drops a person from the notice when they ask to stop, and settles it when nobody is left', async () => {
    const h = harness();
    const ctx = ctxWith(h, { write: async () => BLANK });
    const p = h.person({ ...FOLLOW_UP });
    const { runner } = runnerFor(h, ctx);
    await runner.tick();
    h.ctx.repo.updatePerson(p.id, { status: 'stopped' });
    await runner.tick();
    expect(open(h)).toEqual([]);
  });

  it('is told on the person page, truthfully, instead of promising a send', async () => {
    const h = harness();
    const ctx = ctxWith(h, { write: async () => BLANK });
    const p = h.person({ ...FOLLOW_UP });
    await runnerFor(h, ctx).runner.tick();
    expect(personDetail(h.ctx, p.id).next).toBe('A follow-up is waiting for your edit');
    const item = h.ctx.repo.listOutbox({ state: ['blocked'] })[0]!;
    editBlocked(h.ctx, item.id, 'Hi, a plain follow-up. Worth a look?');
    expect(personDetail(h.ctx, p.id).next).toMatch(/^Follow-up goes out /);
  });
});

describe('a message that did not go', () => {
  const fail = (message = "Callum couldn't find Connect on LinkedIn. LinkedIn may have changed its page.") => ({ ok: false as const, error: { code: 'unknown' as const, message } });

  it('is on the notice, holds the person, and Try again puts the same message back in line', async () => {
    const h = harness({ connected: ['email'] });
    const p = h.person({ ...FOLLOW_UP });
    h.adapters.email.results.push(fail('The server said no.'));
    const { runner } = runnerFor(h);
    await runner.tick();
    const item = h.ctx.repo.listOutbox({ personId: p.id })[0]!;
    expect(item.state).toBe('failed');
    expect(open(h)).toMatchObject([{ kind: 'send_failed', message: "Callum couldn't send a follow-up by email today" }]);
    // An unknown failure may have gone out (see channels/types failureDetail), so the user is asked first.
    expect(personDetail(h.ctx, p.id).next).toBe("A follow-up may have gone out, and Callum couldn't confirm it");

    // The person is held while the message waits for the user: nothing else is written for them.
    await runner.tick();
    expect(h.ctx.repo.listOutbox({ personId: p.id })).toHaveLength(1);

    expect(() => retry(h.ctx, item.id)).toThrow('This may have gone out already. Send again?');
    const again = retry(h.ctx, item.id, { again: true });
    expect(again).toMatchObject({ id: item.id, state: 'scheduled', error: null, detail: null });
    expect(open(h)).toEqual([]);
    await runner.tick();
    expect(h.adapters.email.sent).toHaveLength(2);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('sent');
  });

  it('asks first when it may have gone out: nothing is sent again until the user says so', async () => {
    const h = harness({ connected: ['email'] });
    const p = h.person({ ...FOLLOW_UP });
    h.adapters.email.onSend = () => {
      throw new Error('socket hang up');
    };
    const { runner } = runnerFor(h);
    await runner.tick();
    const item = h.ctx.repo.listOutbox({ personId: p.id })[0]!;
    expect(item).toMatchObject({ state: 'failed', detail: '{"thrown":true}' });
    expect(open(h)).toHaveLength(1);
    expect(personDetail(h.ctx, p.id).next).toBe("A follow-up may have gone out, and Callum couldn't confirm it");

    expect(() => retry(h.ctx, item.id)).toThrow('This may have gone out already. Send again?');
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('failed');
    h.adapters.email.onSend = null;
    expect(retry(h.ctx, item.id, { again: true }).state).toBe('scheduled');
    await runner.tick();
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('sent');
  });

  it('refuses to try again for someone Callum has stopped writing to', async () => {
    const h = harness({ connected: ['email'] });
    const p = h.person({ ...FOLLOW_UP });
    h.adapters.email.results.push(fail());
    await runnerFor(h).runner.tick();
    const item = h.ctx.repo.listOutbox({ personId: p.id })[0]!;
    h.ctx.repo.updatePerson(p.id, { status: 'stopped' });
    expect(() => retry(h.ctx, item.id)).toThrow(`Callum isn't writing to ${p.firstName} any more.`);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('failed');
  });
});

describe('three sends in a row that Callum cannot confirm', () => {
  const unknown = { ok: false as const, error: { code: 'unknown' as const, message: "LinkedIn didn't confirm the invitation." } };

  function linkedinPeople(h: Harness, n: number) {
    return Array.from({ length: n }, (_, i) => h.person({ email: null, channel: 'linkedin', linkedinUrl: `https://www.linkedin.com/in/person-${i}`, linkedinState: 'connected' as const, ...FOLLOW_UP }));
  }

  it('pauses the channel with one notice, in the words of the design, and nothing is sent after that', async () => {
    const h = harness({ connected: ['linkedin'] });
    linkedinPeople(h, 6);
    h.adapters.linkedin.send = async (msg) => {
      h.adapters.linkedin.sent.push(msg);
      return unknown;
    };
    const { runner } = runnerFor(h);
    for (let i = 0; i < 6; i++) {
      await runner.tick();
      h.clock.advance(60_000);
    }
    // One send per pass would have made six attempts; the third failure stopped the channel.
    expect(h.adapters.linkedin.sent.length).toBeLessThan(7);
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    const paused = open(h).filter((i) => i.kind === 'channel_paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]?.message).toBe("LinkedIn changed something and Callum couldn't confirm 3 sends in a row. It paused LinkedIn so nothing goes twice. Check LinkedIn, then resume.");
    const attempts = h.adapters.linkedin.sent.length;
    await runner.tick();
    expect(h.adapters.linkedin.sent).toHaveLength(attempts);
    // The failed ones are on the day's notice with their people.
    expect(open(h).some((i) => i.kind === 'send_failed' && detailOf(i).auto)).toBe(true);
  });

  it('counts only failures in a row: a send that works starts the count again', async () => {
    const h = harness({ connected: ['linkedin'] });
    linkedinPeople(h, 5);
    const script = [unknown, unknown, { ok: true as const, externalId: null }, unknown, unknown];
    h.adapters.linkedin.send = async (msg) => {
      h.adapters.linkedin.sent.push(msg);
      return script.shift() ?? { ok: true as const, externalId: null };
    };
    const { runner } = runnerFor(h);
    for (let i = 0; i < 5; i++) await runner.tick();
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('connected');
    expect(open(h).filter((i) => i.kind === 'channel_paused')).toEqual([]);
  });

  it('is settled when the user resumes the channel, and the count starts from nothing', async () => {
    const h = harness({ connected: ['linkedin'] });
    linkedinPeople(h, 8);
    h.adapters.linkedin.send = async (msg) => {
      h.adapters.linkedin.sent.push(msg);
      return unknown;
    };
    // One send per pass and ten minutes between passes, as in a real day.
    const runner = new Runner(h.ctx, { onError: () => undefined, spacing: { random: () => 0 } });
    const pass = async () => {
      await runner.tick();
      h.clock.advance(10 * 60_000);
    };
    for (let i = 0; i < 3; i++) await pass();
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    resumeChannel(h.ctx, 'linkedin', 'full');
    expect(open(h).filter((i) => i.kind === 'channel_paused')).toEqual([]);
    // Two more failures do not stop it again: the run began from nothing.
    await pass();
    await pass();
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('connected');
  });
});

describe('a message left half sent when Callum closed', () => {
  it('is on the notice and asks first', async () => {
    const h = harness({ connected: ['email'] });
    const p = h.person({ ...FOLLOW_UP });
    const item = h.ctx.repo.insertOutbox({ personId: p.id, channel: 'email', kind: 'follow_up', body: 'Hi', state: 'sending', origin: 'auto', sendAfter: NOW, claimedAt: NOW });
    const { recoverSending } = await import('./dispatch.js');
    recoverSending(h.ctx);
    expect(open(h)).toMatchObject([{ kind: 'send_failed', message: "Callum couldn't send a follow-up by email today" }]);
    expect(() => retry(h.ctx, item.id)).toThrow('This may have gone out already. Send again?');
  });
});
