import { describe, expect, it } from 'vitest';
import type { InboundEvent } from '../channels/types.js';
import { MAX_INBOUND_ATTEMPTS, handleInbound, heldBackPeople, retryFailedInbound } from './inbound.js';
import { ctxWith, harness, NOW } from './testing.test-helpers.js';

type Reply = Extract<InboundEvent, { type: 'reply' }>;
const reply = (over: Partial<Reply> & { from: Reply['from'] }): Reply => ({
  type: 'reply', text: 'Can you tell me more about pricing?', at: '2026-11-03T08:00:00.000Z', externalId: '<r1@x>', ...over,
});

describe('handleInbound: replies', () => {
  it('puts an interested reply on the dock with a draft and takes back what was lined up', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', firstName: 'Kemi', touches: 1, stage: 'hello', lastTouchAt: '2026-11-01T09:00:00.000Z', nextTouchAt: '2026-11-05T08:00:00.000Z' });
    const auto = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Following up', 'S', new Date('2026-11-05T08:00:00Z'), false);
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'Kemi@Okopay.com' } })]);

    const after = h.ctx.repo.getPerson(p.id);
    expect(after).toMatchObject({ status: 'waiting', replyKind: 'question', lastInbound: 'Can you tell me more about pricing?', nextTouchAt: null });
    expect(after?.draft?.length).toBeGreaterThan(0);
    expect(after?.repliedAt).toBe('2026-11-03T08:00:00.000Z');
    expect(h.ctx.repo.getOutbox(auto.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.listMessages(p.id)).toMatchObject([{ direction: 'in', kind: 'inbound', channel: 'email', externalId: '<r1@x>', body: 'Can you tell me more about pricing?' }]);
    expect(h.scopes).toEqual(expect.arrayContaining(['people']));
  });

  it('ignores a reply from someone Callum does not know', async () => {
    const h = harness();
    h.person({ email: 'kemi@okopay.com' });
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'stranger@elsewhere.com' } })]);
    expect(h.ctx.repo.listPeople().map((x) => x.status)).toEqual(['active']);
    expect(h.ctx.repo.hasMessageWithExternalId('email', '<r1@x>', 'in')).toBe(false);
  });

  it('stops a person who asks, cancels everything for them, and keeps them off the dock', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', touches: 1, stage: 'hello' });
    const auto = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'x', 'S', new Date('2026-11-05T08:00:00Z'), false);
    const user = h.ctx.outbox.queueUserSend(p.id, 'reply', 'A note');
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' }, text: 'Please stop emailing me' })]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'stopped', replyKind: 'stop', draft: null });
    expect(h.ctx.repo.getOutbox(auto.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.getOutbox(user.id)?.state).toBe('cancelled');
  });

  it('closes a hostile reply without a draft', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com' });
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' }, text: 'Stop spamming me you idiots, this is harassment.' })]);
    const after = h.ctx.repo.getPerson(p.id);
    expect(['closed', 'stopped']).toContain(after?.status);
    expect(after?.draft).toBeNull();
  });

  it('keeps the follow-up but moves it after the return date for an out-of-office note', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', touches: 1, stage: 'hello', lastTouchAt: '2026-11-01T09:00:00.000Z', nextTouchAt: '2026-11-05T08:00:00.000Z' });
    const auto = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'x', 'S', new Date('2026-11-05T08:00:00Z'), false);
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' }, text: "I'm out of the office until 20 November" })]);
    const after = h.ctx.repo.getPerson(p.id);
    expect(after).toMatchObject({ status: 'active', replyKind: null, draft: null });
    // The day after she is back, 9:00 in Lagos.
    expect(after?.nextTouchAt).toBe('2026-11-23T08:00:00.000Z');
    expect(h.ctx.repo.getOutbox(auto.id)).toMatchObject({ state: 'scheduled', sendAfter: '2026-11-23T08:00:00.000Z' });
  });

  it('adds the person a referral points to, in the same project, with the context as a note', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Payroll', offer: 'Payroll for small teams' });
    const p = h.person({ email: 'kemi@okopay.com', projectId: second.id, touches: 1, stage: 'hello' });
    const text = 'You should talk to Sam Bello (sam@okopay.com), she runs finance';
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' }, text })]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'waiting', replyKind: 'referral' });
    const sam = h.ctx.repo.findPersonByHandle({ email: 'sam@okopay.com' });
    expect(sam).toMatchObject({ name: 'Sam Bello', source: 'referral', note: text, projectId: second.id, status: 'active', stage: 'stranger', channel: 'email' });
  });

  it('does not add a referred person twice', async () => {
    const h = harness();
    h.person({ email: 'kemi@okopay.com' });
    h.person({ email: 'sam@okopay.com', name: 'Sam Bello' });
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' }, text: 'You should talk to Sam Bello (sam@okopay.com), she runs finance' })]);
    expect(h.ctx.repo.listPeople()).toHaveLength(2);
  });

  it('records the same reply once however often it is delivered', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com' });
    const event = reply({ from: { email: 'kemi@okopay.com' } });
    await handleInbound(h.ctx, 'email', [event]);
    await handleInbound(h.ctx, 'email', [event, event]);
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(1);
  });

  it('records two replies that carry no id', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com' });
    await handleInbound(h.ctx, 'email', [
      reply({ from: { email: 'kemi@okopay.com' }, externalId: null, text: 'Tell me more' }),
      reply({ from: { email: 'kemi@okopay.com' }, externalId: null, text: 'Tell me more' }),
    ]);
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(2);
  });

  it('matches a person on another channel and in any project', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Payroll', offer: 'Payroll for small teams' });
    const p = h.person({ projectId: second.id, email: 'kemi@okopay.com', xHandle: 'kemi', touches: 1, stage: 'hello' });
    await handleInbound(h.ctx, 'x', [reply({ from: { xHandle: 'Kemi' }, externalId: 'dm1' })]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'waiting' });
    expect(h.ctx.repo.listMessages(p.id)[0]).toMatchObject({ channel: 'x', externalId: 'dm1' });
  });

  it('keeps a stopped person stopped when they write again', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', status: 'stopped' });
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' } })]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'stopped', draft: null });
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(1);
  });

  it('brings someone who was talking back to the dock', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', stage: 'talking', badge: 'sent' });
    await handleInbound(h.ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' }, text: 'Thursday at 9:00 works for me.' })]);
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('waiting');
  });
});

describe('handleInbound: accepted', () => {
  it('thanks go out at the next 11:00 after an invite is accepted', async () => {
    const h = harness();
    const p = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/kemi', email: null, touches: 1, stage: 'hello', linkedinState: 'invited', invitedAt: '2026-11-01T09:00:00.000Z' });
    await handleInbound(h.ctx, 'linkedin', [{ type: 'accepted', linkedinUrl: 'https://uk.linkedin.com/in/Kemi/', at: NOW }]);
    // Tuesday 11:00 in Lagos, the next one after 9:30.
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ linkedinState: 'connected', nextTouchAt: '2026-11-03T10:00:00.000Z' });
  });

  it('ignores an acceptance for someone Callum never invited', async () => {
    const h = harness();
    const p = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/kemi', email: null });
    await handleInbound(h.ctx, 'linkedin', [{ type: 'accepted', linkedinUrl: 'https://www.linkedin.com/in/kemi', at: NOW }]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ linkedinState: 'none', nextTouchAt: null });
    await handleInbound(h.ctx, 'linkedin', [{ type: 'accepted', linkedinUrl: 'https://www.linkedin.com/in/nobody', at: NOW }]);
  });
});

describe('handleInbound: bounces', () => {
  it('moves a bounced person on and writes one incident for a domain', async () => {
    const h = harness();
    const a = h.person({ email: 'a@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/a' });
    const b = h.person({ email: 'b@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/b' });
    const waiting = h.ctx.outbox.queueAuto(a.id, 'hello', 'x', 'S', new Date('2026-11-05T08:00:00Z'), false);
    await handleInbound(h.ctx, 'email', [
      { type: 'bounce', email: 'a@okopay.com', at: NOW, externalId: '<dsn@x>' },
      { type: 'bounce', email: 'b@okopay.com', at: NOW, externalId: '<dsn@x>' },
    ]);
    expect(h.ctx.repo.getPerson(a.id)).toMatchObject({ email: null, channel: 'linkedin' });
    expect(h.ctx.repo.getPerson(b.id)).toMatchObject({ email: null, channel: 'linkedin' });
    expect(h.ctx.repo.getOutbox(waiting.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      kind: 'bounces', message: '2 addresses at okopay.com bounced. Callum removed them and will try LinkedIn for those people.',
    }]);
  });

  it('counts a delivered-twice bounce once', async () => {
    const h = harness();
    h.person({ email: 'a@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/a' });
    const event: InboundEvent = { type: 'bounce', email: 'a@okopay.com', at: NOW, externalId: '<dsn@x>' };
    await handleInbound(h.ctx, 'email', [event]);
    await handleInbound(h.ctx, 'email', [event]);
    expect(h.ctx.repo.listIncidents()).toMatchObject([{ message: '1 address at okopay.com bounced. Callum removed it and will try LinkedIn for that person.' }]);
  });

  it('leaves a stopped person with their address', async () => {
    const h = harness();
    const p = h.person({ email: 'a@okopay.com', status: 'stopped' });
    await handleInbound(h.ctx, 'email', [{ type: 'bounce', email: 'a@okopay.com', at: NOW, externalId: null }]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ email: 'a@okopay.com', status: 'stopped' });
    expect(h.ctx.repo.listIncidents()).toEqual([]);
  });

  it('ignores a bounce for an address Callum does not have', async () => {
    const h = harness();
    await handleInbound(h.ctx, 'email', [{ type: 'bounce', email: 'ghost@okopay.com', at: NOW, externalId: null }]);
    expect(h.ctx.repo.listIncidents()).toEqual([]);
  });
});

describe('handleInbound: the user wrote from their own mailbox', () => {
  const seen = (email: string, externalId: string | null = '<mine@x>'): InboundEvent => ({ type: 'outbound_seen', email, at: NOW, externalId });

  it('marks the person as talking and takes back the follow-ups', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', touches: 1, stage: 'hello', nextTouchAt: '2026-11-05T08:00:00.000Z' });
    const auto = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'x', 'S', new Date('2026-11-05T08:00:00Z'), false);
    await handleInbound(h.ctx, 'email', [seen('kemi@okopay.com')]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ stage: 'talking', status: 'active', badge: 'sent', nextTouchAt: null });
    expect(h.ctx.repo.getOutbox(auto.id)?.state).toBe('cancelled');
  });

  it('ignores a message Callum sent itself', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', touches: 1, stage: 'hello' });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: 'S', body: 'Hi', at: NOW, externalId: '<mine@x>' });
    await handleInbound(h.ctx, 'email', [seen('kemi@okopay.com', '<mine@x>')]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ stage: 'hello', badge: null });
  });

  it('ignores people who are already talking, stopped, closed, removed or unknown', async () => {
    const h = harness();
    const talking = h.person({ email: 'a@okopay.com', stage: 'talking', badge: 'booked' });
    const stopped = h.person({ email: 'b@okopay.com', status: 'stopped' });
    const closed = h.person({ email: 'c@okopay.com', status: 'closed' });
    await handleInbound(h.ctx, 'email', ['a', 'b', 'c', 'nobody'].map((n) => seen(`${n}@okopay.com`, null)));
    expect(h.ctx.repo.getPerson(talking.id)?.badge).toBe('booked');
    expect(h.ctx.repo.getPerson(stopped.id)?.status).toBe('stopped');
    expect(h.ctx.repo.getPerson(closed.id)).toMatchObject({ status: 'closed', stage: 'stranger' });
  });
});

describe('handleInbound: checkpoint', () => {
  it('pauses LinkedIn and explains', async () => {
    const h = harness();
    await handleInbound(h.ctx, 'linkedin', [{ type: 'checkpoint', at: NOW }]);
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    expect(h.ctx.repo.getChannel('email').status).toBe('connected');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      channel: 'linkedin', kind: 'linkedin_check',
      message: "LinkedIn asked to check it's you, so Callum paused LinkedIn to keep your account safe. Email and X keep going.",
    }]);
  });
});

describe('handleInbound: a user who answered by hand', () => {
  it('takes someone off the dock, drops the draft and what was queued, and makes them talking', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', status: 'waiting', stage: 'hello', touches: 1, draft: 'Hi Kemi, yes.', replyKind: 'question' });
    const auto = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'x', 'S', new Date('2026-11-05T08:00:00Z'), false);
    const user = h.ctx.outbox.queueUserSend(p.id, 'reply', 'My own draft');
    await handleInbound(h.ctx, 'email', [{ type: 'outbound_seen', email: 'kemi@okopay.com', at: NOW, externalId: '<hand@x>' }]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'active', stage: 'talking', badge: 'sent', draft: null });
    expect(h.ctx.repo.getOutbox(auto.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.getOutbox(user.id)?.state).toBe('cancelled');
  });
});

describe('handleInbound: the user answered someone already in conversation', () => {
  it('takes them off the dock even when they were already talking', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', status: 'waiting', stage: 'talking', touches: 1, draft: 'Hi Kemi, yes.', replyKind: 'question' });
    await handleInbound(h.ctx, 'email', [{ type: 'outbound_seen', email: 'kemi@okopay.com', at: NOW, externalId: '<hand@x>' }]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'active', stage: 'talking', draft: null });
  });
});

describe('handleInbound: an event that cannot be handled', () => {
  it('keeps it, reports it, and carries on with the rest', async () => {
    const h = harness();
    const bad = h.person({ email: 'bad@okopay.com' });
    const good = h.person({ email: 'good@okopay.com' });
    const real = h.ctx.writer;
    const ctx = ctxWith(h, { classify: async (t, c) => { if (c.person.id === bad.id) throw new Error('model down'); return real.classify(t, c); } });
    const errors: unknown[] = [];
    await handleInbound(ctx, 'email', [
      reply({ from: { email: 'bad@okopay.com' }, externalId: '<1@x>' }),
      reply({ from: { email: 'good@okopay.com' }, externalId: '<2@x>' }),
    ], (e) => errors.push(e));
    expect(errors).toHaveLength(1);
    expect(h.ctx.repo.getPerson(good.id)?.status).toBe('waiting');
    expect(h.ctx.repo.getPerson(bad.id)?.status).toBe('active');
    expect(h.ctx.repo.listMessages(bad.id)).toEqual([]);
    expect(h.ctx.repo.listInboundFailures()).toMatchObject([{ channel: 'email', externalId: '<1@x>', personId: bad.id, attempts: 1, error: 'model down' }]);
    expect(JSON.parse(h.ctx.repo.listInboundFailures()[0]?.event ?? '{}')).toMatchObject({ type: 'reply', text: 'Can you tell me more about pricing?' });
    expect([...heldBackPeople(ctx)]).toEqual([bad.id]);
  });

  it('is not kept twice when the same event fails again', async () => {
    const h = harness();
    h.person({ email: 'bad@okopay.com' });
    const ctx = ctxWith(h, { classify: async () => { throw new Error('model down'); } });
    const event = reply({ from: { email: 'bad@okopay.com' }, externalId: '<1@x>' });
    await handleInbound(ctx, 'email', [event]);
    await handleInbound(ctx, 'email', [event]);
    expect(h.ctx.repo.listInboundFailures()).toHaveLength(1);
  });

  it('is tried again a little later each time, up to five attempts, then left', async () => {
    const h = harness();
    const bad = h.person({ email: 'bad@okopay.com' });
    let calls = 0;
    const ctx = ctxWith(h, { classify: async () => { calls++; throw new Error('model down'); } });
    await handleInbound(ctx, 'email', [reply({ from: { email: 'bad@okopay.com' }, externalId: '<1@x>' })]);
    const errors: unknown[] = [];
    await retryFailedInbound(ctx, (e) => errors.push(e)); // too soon
    expect(calls).toBe(1);
    for (let i = 0; i < 10; i++) {
      h.clock.advance(6 * 60_000);
      await retryFailedInbound(ctx, (e) => errors.push(e));
    }
    expect(calls).toBe(MAX_INBOUND_ATTEMPTS);
    expect(h.ctx.repo.listInboundFailures()).toMatchObject([{ attempts: MAX_INBOUND_ATTEMPTS }]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['Callum gave up on a email message after 5 tries: model down']);
    // Once given up, the person is no longer held back.
    expect(heldBackPeople(ctx).has(bad.id)).toBe(false);
  });

  it('puts the person on the dock with the reply as it came, and tells the user, when it gives up', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', firstName: 'Kemi', touches: 1, stage: 'hello', nextTouchAt: '2026-11-05T08:00:00.000Z' });
    const auto = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'x', 'S', new Date('2026-11-05T08:00:00Z'), false);
    const ctx = ctxWith(h, { classify: async () => { throw new Error('model down'); } });
    await handleInbound(ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' }, externalId: '<1@x>', text: 'Yes, call me Thursday' })]);
    expect(h.ctx.repo.listMessages(p.id)).toEqual([]);
    for (let i = 0; i < 10; i++) {
      h.clock.advance(6 * 60_000);
      await retryFailedInbound(ctx);
    }
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'waiting', draft: null, lastInbound: 'Yes, call me Thursday' });
    expect(h.ctx.repo.listMessages(p.id)).toMatchObject([{ direction: 'in', body: 'Yes, call me Thursday', externalId: '<1@x>' }]);
    expect(h.ctx.repo.getOutbox(auto.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{ kind: 'reply_unread', personId: p.id, message: "Callum couldn't read a reply from Kemi. It's on your dock." }]);
  });

  it('opens a notice with the channel when the sender can no longer be matched', async () => {
    const h = harness();
    const p = h.person({ email: null, channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/ghost' });
    // The person's address is taken away while the last attempt is under way, so there is nobody to put on the dock.
    const ctx = ctxWith(h, { classify: async () => { h.ctx.repo.updatePerson(p.id, { linkedinUrl: null }); throw new Error('model down'); } });
    const event = reply({ from: { linkedinUrl: 'https://www.linkedin.com/in/ghost' }, externalId: 'li2' });
    h.ctx.repo.insertInboundFailure({ channel: 'linkedin', externalId: 'li2', personId: p.id, event: JSON.stringify(event), error: 'x' });
    h.ctx.repo.updateInboundFailure(1, { attempts: MAX_INBOUND_ATTEMPTS - 1, error: 'x' });
    h.clock.advance(60 * 60_000);
    await retryFailedInbound(ctx);
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{ channel: 'linkedin', kind: 'reply_unread', personId: null, message: "Callum couldn't read a reply from https://www.linkedin.com/in/ghost on LinkedIn. Check it by hand." }]);
  });

  it('leaves someone who said stop stopped when it gives up on a later reply', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', status: 'stopped' });
    h.ctx.repo.insertInboundFailure({ channel: 'email', externalId: '<z@x>', personId: p.id, event: JSON.stringify(reply({ from: { email: 'kemi@okopay.com' }, externalId: '<z@x>' })), error: 'x' });
    h.ctx.repo.updateInboundFailure(1, { attempts: MAX_INBOUND_ATTEMPTS - 1, error: 'x' });
    const ctx = ctxWith(h, { classify: async () => { throw new Error('model down'); } });
    h.clock.advance(60 * 60_000);
    await retryFailedInbound(ctx);
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('stopped');
  });

  it('is dropped once it has been handled, and a copy that arrives later is not recorded twice', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com' });
    let fail = true;
    const real = h.ctx.writer;
    const ctx = ctxWith(h, { classify: async (t, c) => { if (fail) throw new Error('model down'); return real.classify(t, c); } });
    const event = reply({ from: { email: 'kemi@okopay.com' }, externalId: '<1@x>' });
    await handleInbound(ctx, 'email', [event]);
    fail = false;
    await handleInbound(ctx, 'email', [event]); // the mailbox shows it again after a restart
    await retryFailedInbound(ctx);
    h.clock.advance(2 * 60_000);
    await retryFailedInbound(ctx);
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(1);
    expect(h.ctx.repo.listInboundFailures()).toEqual([]);
  });

  it('does not put someone on the dock who was stopped while the draft was being written', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com' });
    const real = h.ctx.writer;
    const ctx = ctxWith(h, { write: async (k, c) => { h.ctx.repo.updatePerson(p.id, { status: 'stopped' }); return real.write(k, c); } });
    await handleInbound(ctx, 'email', [reply({ from: { email: 'kemi@okopay.com' } })]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'stopped', draft: null });
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(1);
  });
});
