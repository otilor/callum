import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE, placeholderMessage } from '../engine/guard.js';
import { createCtx } from '../context.js';
import { COULD_NOT_RECORD, CLOSED_WHILE_SENDING, dispatchDue, recoverSending } from './dispatch.js';
import { INCIDENT_COPY } from './incidents.js';
import { openDb } from '../db/db.js';
import { harness, NOW } from './testing.test-helpers.js';

const at = (iso: string) => new Date(iso).toISOString();

describe('dispatchDue: sending', () => {
  it('sends a due item, records it, and moves the person along', async () => {
    const h = harness();
    const p = h.person();
    const id = h.due(p.id, 'hello', 'Hi Kemi, hello.', 'Quick question');
    expect(await dispatchDue(h.ctx)).toBe(1);

    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.adapters.email.sent[0]).toMatchObject({ kind: 'hello', subject: 'Quick question', to: { email: p.email } });
    expect(h.adapters.email.sent[0]?.body).toBe(`Hi Kemi, hello.\n\n${OPT_OUT_LINE}`);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('sent');
    const [m] = h.ctx.repo.listMessages(p.id);
    expect(m).toMatchObject({ direction: 'out', kind: 'hello', channel: 'email', at: NOW, subject: 'Quick question' });
    expect(m?.body).toContain(OPT_OUT_LINE);
    expect(m?.externalId).toBe('<email-1@fake>');
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ touches: 1, stage: 'hello', lastTouchAt: NOW });
    expect(h.scopes).toEqual(expect.arrayContaining(['outbox', 'people']));
  });

  it('does not add the opt-out line to LinkedIn or X messages', async () => {
    const h = harness();
    const p = h.person({ channel: 'x', xHandle: 'kemi', email: null });
    h.due(p.id, 'hello', 'Hi Kemi.');
    await dispatchDue(h.ctx);
    expect(h.adapters.x.sent[0]?.body).toBe('Hi Kemi.');
  });

  it('threads an email onto the last message and replies under the same subject', async () => {
    const h = harness();
    const p = h.person({ stage: 'talking', status: 'active' });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'in', kind: 'inbound', subject: null, body: 'Tell me more', at: '2026-11-03T07:00:00.000Z', externalId: '<theirs@x>' });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: 'Quick question', body: 'Hi', at: '2026-11-02T10:00:00.000Z', externalId: '<ours@x>' });
    h.ctx.outbox.queueUserSend(p.id, 'reply', 'Thursday at 9:00 works.');
    h.clock.advance(11_000);
    await dispatchDue(h.ctx);
    expect(h.adapters.email.sent[0]).toMatchObject({ subject: 'Re: Quick question', inReplyTo: '<theirs@x>', kind: 'reply' });
  });

  it('records an invitation that lost its note as sent without one', async () => {
    const h = harness();
    const p = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/kemi', email: null });
    h.adapters.linkedin.results.push({ ok: true, externalId: null, noteDropped: true });
    h.due(p.id, 'invite', 'Hi Kemi, I would like to connect.', null);
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.listMessages(p.id)[0]).toMatchObject({ kind: 'invite', body: '' });
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ linkedinState: 'invited', touches: 1 });
  });

  it('sends in sendAfter order', async () => {
    const h = harness();
    const a = h.person();
    const b = h.person();
    h.ctx.outbox.queueAuto(b.id, 'hello', 'second', 'S', new Date('2026-11-03T08:20:00Z'), false);
    h.ctx.outbox.queueAuto(a.id, 'hello', 'first', 'F', new Date('2026-11-03T08:10:00Z'), false);
    await dispatchDue(h.ctx);
    expect(h.adapters.email.sent.map((m) => m.subject)).toEqual(['F', 'S']);
  });

  it('leaves items that are not due yet', async () => {
    const h = harness();
    const p = h.person();
    const item = h.ctx.outbox.queueAuto(p.id, 'hello', 'later', 'L', new Date('2026-11-03T09:00:00Z'), false);
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('scheduled');
  });
});

describe('dispatchDue: when', () => {
  it('moves an auto item that is due at 17:00 to the next 9:00', async () => {
    const h = harness({ now: '2026-11-03T16:00:00.000Z' }); // 17:00 in Lagos
    const p = h.person();
    const id = h.due(p.id, 'follow_up');
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.adapters.email.sent).toEqual([]);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-04T08:00:00Z') });
  });

  it('uses the recipient time zone', async () => {
    const h = harness();
    const p = h.person({ timezone: 'America/New_York' }); // 03:30 there
    const id = h.due(p.id, 'hello');
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-03T14:00:00Z') });
  });

  it('moves a weekend item to Monday 9:00', async () => {
    const h = harness({ now: '2026-11-07T10:00:00.000Z' }); // Saturday
    const p = h.person();
    const id = h.due(p.id, 'hello');
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)?.sendAfter).toBe(at('2026-11-09T08:00:00Z'));
  });

  it('sends a user reply at any hour', async () => {
    const h = harness({ now: '2026-11-07T02:00:00.000Z' }); // Saturday night
    const p = h.person({ status: 'waiting', stage: 'talking' });
    h.ctx.outbox.queueUserSend(p.id, 'reply', 'Thursday at 9:00 works.');
    h.clock.advance(11_000);
    expect(await dispatchDue(h.ctx)).toBe(1);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'active', stage: 'talking', badge: 'sent', draft: null });
  });

  it('stops after the email cap and sends the rest tomorrow', async () => {
    const h = harness();
    const ids = Array.from({ length: 21 }, () => h.due(h.person().id, 'hello'));
    expect(await dispatchDue(h.ctx)).toBe(20);
    const last = h.ctx.repo.getOutbox(ids[20]!);
    expect(last).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-04T08:00:00Z') });
    expect(h.adapters.email.sent).toHaveLength(20);
    // And the next day it goes.
    h.clock.set('2026-11-04T08:00:00Z');
    expect(await dispatchDue(h.ctx)).toBe(1);
  });

  it('counts the day in the user time zone', async () => {
    const h = harness({ now: '2026-11-03T23:30:00.000Z', timezone: 'Pacific/Auckland' }); // Wed 12:30 in Auckland
    // 20 sent at Tue 23:00 UTC = Wed 12:00 Auckland: same local day as now.
    const p = h.person({ timezone: 'Pacific/Auckland' });
    for (let i = 0; i < 20; i++) {
      h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: null, body: 'x', at: '2026-11-03T23:00:00.000Z', externalId: null });
    }
    const id = h.due(p.id, 'follow_up');
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('scheduled');
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('does not count user replies against the cap', async () => {
    const h = harness();
    const talker = h.person({ stage: 'talking' });
    for (let i = 0; i < 20; i++) {
      h.ctx.repo.insertMessage({ personId: talker.id, channel: 'email', direction: 'out', kind: 'reply', subject: null, body: 'x', at: '2026-11-03T07:00:00.000Z', externalId: null });
    }
    h.due(h.person().id, 'hello');
    expect(await dispatchDue(h.ctx)).toBe(1);
  });

  it('keeps LinkedIn invites and messages on separate caps', async () => {
    const h = harness();
    for (let i = 0; i < 15; i++) {
      const p = h.person({ channel: 'linkedin', linkedinUrl: `https://www.linkedin.com/in/p${i}`, email: null });
      h.ctx.repo.insertMessage({ personId: p.id, channel: 'linkedin', direction: 'out', kind: 'invite', subject: null, body: 'x', at: '2026-11-03T07:00:00.000Z', externalId: null });
    }
    const invitee = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/new', email: null });
    const messagee = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/old', email: null, touches: 1, linkedinState: 'connected' });
    const invite = h.due(invitee.id, 'invite', 'Hi', null);
    const thanks = h.due(messagee.id, 'thanks', 'Thanks for connecting');
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(invite)?.state).toBe('scheduled');
    expect(h.ctx.repo.getOutbox(thanks)?.state).toBe('sent');
  });

  it('uses the half pace after a LinkedIn check', async () => {
    const h = harness();
    h.ctx.repo.updateChannel('linkedin', { halfPaceUntil: '2026-11-09T00:00:00.000Z' });
    for (let i = 0; i < 7; i++) {
      const p = h.person({ channel: 'linkedin', linkedinUrl: `https://www.linkedin.com/in/p${i}`, email: null });
      h.ctx.repo.insertMessage({ personId: p.id, channel: 'linkedin', direction: 'out', kind: 'invite', subject: null, body: 'x', at: '2026-11-03T07:00:00.000Z', externalId: null });
    }
    const p = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/new', email: null });
    const id = h.due(p.id, 'invite', 'Hi', null);
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('scheduled');
  });

  it('shares the cap across projects, earliest due first', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Payroll', offer: 'Payroll for small teams' });
    h.ctx.repo.updateProject(second.id, { startedAt: '2026-11-02T10:00:00.000Z', approvalsLeft: 0 });
    const base = new Date('2026-11-03T08:00:00Z').getTime();
    const order: string[] = [];
    for (let i = 0; i < 15; i++) {
      const a = h.person();
      const b = h.person({ projectId: second.id });
      h.ctx.outbox.queueAuto(a.id, 'hello', 'one', `A${i}`, new Date(base + i * 60_000), false);
      h.ctx.outbox.queueAuto(b.id, 'hello', 'two', `B${i}`, new Date(base + i * 60_000 + 30_000), false);
      order.push(`A${i}`, `B${i}`);
    }
    expect(await dispatchDue(h.ctx)).toBe(20);
    expect(h.adapters.email.sent.map((m) => m.subject)).toEqual(order.slice(0, 20));
    const waiting = h.ctx.repo.listOutbox({ state: ['scheduled'] });
    expect(waiting).toHaveLength(10);
    expect(waiting.every((i) => i.sendAfter === at('2026-11-04T08:00:00Z'))).toBe(true);
  });
});

describe('dispatchDue: who and whether', () => {
  it('only sends project 1 when project 2 is paused', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Payroll', offer: 'Payroll for small teams' });
    h.ctx.repo.updateProject(second.id, { startedAt: '2026-11-02T10:00:00.000Z', state: 'paused', pausedUntil: '2026-11-20T00:00:00.000Z' });
    const a = h.person();
    const b = h.person({ projectId: second.id });
    const ia = h.due(a.id, 'hello');
    const ib = h.due(b.id, 'hello');
    expect(await dispatchDue(h.ctx)).toBe(1);
    expect(h.ctx.repo.getOutbox(ia)?.state).toBe('sent');
    expect(h.ctx.repo.getOutbox(ib)).toMatchObject({ state: 'scheduled', sendAfter: NOW });
  });

  it('still sends a user reply for a paused project', async () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { state: 'paused', pausedUntil: '2026-11-20T00:00:00.000Z' });
    const p = h.person({ status: 'waiting', stage: 'talking' });
    h.ctx.outbox.queueUserSend(p.id, 'reply', 'Yes, Thursday.');
    h.clock.advance(11_000);
    expect(await dispatchDue(h.ctx)).toBe(1);
  });

  it('keeps auto items for a wrapped project', async () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { state: 'wrapped' });
    const id = h.due(h.person().id, 'hello');
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('scheduled');
  });

  it('holds auto items while everything is paused but sends user replies', async () => {
    const h = harness();
    h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: '2026-11-20T00:00:00.000Z' });
    const auto = h.due(h.person().id, 'hello');
    const talker = h.person({ status: 'waiting', stage: 'talking' });
    h.ctx.outbox.queueUserSend(talker.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    expect(await dispatchDue(h.ctx)).toBe(1);
    expect(h.ctx.repo.getOutbox(auto)?.state).toBe('scheduled');
    expect(h.adapters.email.sent.map((m) => m.kind)).toEqual(['reply']);
  });

  it('holds items for a channel that is not connected', async () => {
    const h = harness({ connected: ['linkedin'] });
    const id = h.due(h.person().id, 'hello');
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('scheduled');
  });

  it.each(['stopped', 'closed', 'removed', 'held'] as const)('cancels the item of a person who is %s', async (status) => {
    const h = harness();
    const p = h.person({ status });
    const id = h.due(p.id, 'follow_up');
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('cancelled');
    expect(h.adapters.email.sent).toEqual([]);
  });

  it.each(['waiting', 'snoozed'] as const)('cancels an auto item for someone who is %s', async (status) => {
    const h = harness();
    const id = h.due(h.person({ status }).id, 'follow_up');
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('cancelled');
  });

  it('cancels the item of a person who is gone', async () => {
    const h = harness();
    const p = h.person();
    const id = h.due(p.id, 'hello');
    h.ctx.repo.updatePerson(p.id, { status: 'removed' });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('cancelled');
  });

  it('does not send an item that was taken back after it became due', async () => {
    const h = harness();
    const first = h.person();
    const second = h.person();
    h.ctx.outbox.queueAuto(first.id, 'hello', 'Hi', 'A', new Date('2026-11-03T08:20:00Z'), false);
    const later = h.ctx.outbox.queueAuto(second.id, 'hello', 'Hi', 'B', new Date('2026-11-03T08:30:00Z'), false).id;
    // Both are due when the run starts; the second is taken back while the first is on its way.
    h.adapters.email.onSend = () => {
      h.ctx.repo.updateOutbox(later, { state: 'awaiting_ok' });
    };
    expect(await dispatchDue(h.ctx)).toBe(1);
    expect(h.adapters.email.sent.map((m) => m.subject)).toEqual(['A']);
    expect(h.ctx.repo.getOutbox(later)?.state).toBe('awaiting_ok');
  });

  it('sends an item once when dispatch runs twice at the same time', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.adapters.email.onSend = () => gate;
    const first = dispatchDue(h.ctx);
    const second = dispatchDue(h.ctx);
    await Promise.resolve();
    release();
    const counts = await Promise.all([first, second]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('sent');
    expect(h.ctx.repo.listMessages(h.ctx.repo.getOutbox(id)!.personId)).toHaveLength(1);
  });
});

describe('dispatchDue: placeholders', () => {
  it('blocks an auto body with a placeholder and says what to fix', async () => {
    const h = harness();
    const p = h.person();
    const id = h.due(p.id, 'hello', 'Hi Kemi, our price is [YOUR PRICE].');
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'blocked', error: placeholderMessage('[YOUR PRICE]') });
    expect(h.adapters.email.sent).toEqual([]);
    expect(placeholderMessage('[YOUR PRICE]')).toBe('Add your price first. Callum never sends a message with [YOUR PRICE] in it.');
  });

  it('also blocks a placeholder in the subject', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello', 'Hi.', 'Hello {first_name}');
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'blocked', error: placeholderMessage('{first_name}') });
  });
});

describe('dispatchDue: when a channel complains', () => {
  it('signs email out on auth, keeps every email, and says how many wait', async () => {
    const h = harness();
    h.ctx.repo.setChannelSecret('email', { provider: 'google', address: 'ada@example.com' });
    const a = h.due(h.person().id, 'hello');
    const b = h.due(h.person().id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'auth', message: 'Invalid credentials' } });
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getChannel('email').status).toBe('error');
    expect(h.ctx.repo.getOutbox(a)?.state).toBe('scheduled');
    expect(h.ctx.repo.getOutbox(b)?.state).toBe('scheduled');
    expect(h.adapters.email.sent).toHaveLength(1); // the second one was not even tried
    const [incident] = h.ctx.repo.listIncidents({ open: true });
    expect(incident).toMatchObject({
      channel: 'email', kind: 'mailbox_signed_out',
      message: 'Google signed Callum out of ada@example.com. 2 emails are waiting and nothing was lost.',
    });
    expect(h.scopes).toEqual(expect.arrayContaining(['channels', 'incidents']));
  });

  it('pauses LinkedIn on a check and keeps email going in the same run', async () => {
    const h = harness();
    const li = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/kemi', email: null });
    const mail = h.person();
    const liItem = h.ctx.outbox.queueAuto(li.id, 'invite', 'Hi', null, new Date('2026-11-03T08:00:00Z'), false).id;
    const mailItem = h.ctx.outbox.queueAuto(mail.id, 'hello', 'Hi', 'S', new Date('2026-11-03T08:10:00Z'), false).id;
    h.adapters.linkedin.results.push({ ok: false, error: { code: 'checkpoint', message: 'check' } });
    expect(await dispatchDue(h.ctx)).toBe(1);
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    expect(h.ctx.repo.getOutbox(liItem)?.state).toBe('scheduled');
    expect(h.ctx.repo.getOutbox(mailItem)?.state).toBe('sent');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      channel: 'linkedin', kind: 'linkedin_check',
      message: "LinkedIn asked to check it's you, so Callum paused LinkedIn to keep your account safe. Email and X keep going.",
    }]);
  });

  it('blocks invites until Monday on the weekly limit and keeps messages going', async () => {
    const h = harness();
    const a = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/a', email: null });
    const b = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/b', email: null });
    const c = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/c', email: null, touches: 1, linkedinState: 'connected' });
    const ia = h.due(a.id, 'invite', 'Hi', null);
    const ib = h.due(b.id, 'invite', 'Hi', null);
    const ic = h.due(c.id, 'thanks', 'Thanks');
    h.adapters.linkedin.results.push({ ok: false, error: { code: 'weekly_limit', message: 'weekly' } });
    await dispatchDue(h.ctx);
    // Monday 00:00 in Lagos is Sunday 23:00 UTC; invites resume at Monday 9:00 there.
    expect(h.ctx.repo.getChannel('linkedin').invitesBlockedUntil).toBe(at('2026-11-08T23:00:00Z'));
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('connected');
    expect(h.ctx.repo.getOutbox(ia)).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-09T08:00:00Z') });
    expect(h.ctx.repo.getOutbox(ib)).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-09T08:00:00Z') });
    expect(h.ctx.repo.getOutbox(ic)?.state).toBe('sent');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      kind: 'linkedin_weekly_limit',
      message: "LinkedIn's weekly invite limit is reached. New invites wait until Monday. Messages to your connections keep going.",
    }]);
  });

  it('pauses X until the next local midnight on a 429', async () => {
    const h = harness();
    const a = h.person({ channel: 'x', xHandle: 'a', email: null });
    const b = h.person({ channel: 'x', xHandle: 'b', email: null });
    const ia = h.due(a.id, 'hello');
    const ib = h.due(b.id, 'hello');
    h.adapters.x.results.push({ ok: false, error: { code: 'rate_limit', message: 'slow down' } });
    expect(await dispatchDue(h.ctx)).toBe(0);
    const x = h.ctx.repo.getChannel('x');
    expect(x.status).toBe('paused');
    expect(x.pausedUntil).toBe(at('2026-11-03T23:00:00Z')); // Wednesday 00:00 in Lagos
    expect(h.ctx.repo.getOutbox(ia)?.state).toBe('scheduled');
    expect(h.ctx.repo.getOutbox(ib)?.state).toBe('scheduled');
    expect(h.adapters.x.sent).toHaveLength(1);
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{ channel: 'x', kind: 'x_limit', message: INCIDENT_COPY.x_limit }]);
  });

  it('tries an auto item again in 15 minutes after a temporary error', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'temporary', message: 'timeout' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-03T08:45:00Z') });
    expect(h.ctx.repo.listIncidents()).toEqual([]);
  });

  it('puts an email over its provider quota off until tomorrow', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'rate_limit', message: 'Daily user sending quota exceeded' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-04T08:00:00Z') });
    expect(h.ctx.repo.getChannel('email').status).toBe('connected');
  });

  it('fails an auto item that errors for no known reason, so it is not written again', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'unknown', message: 'Something odd' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'failed', error: 'Something odd' });
  });

  it('treats an adapter that throws like an unknown failure', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    h.adapters.email.onSend = () => { throw new Error('socket closed'); };
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'failed', error: 'socket closed' });
  });
});

describe('dispatchDue: bounces', () => {
  it('clears the address, moves the person to LinkedIn, and cancels the item', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    const id = h.due(p.id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'invalid_recipient', message: 'no such user' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('cancelled');
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ email: null, channel: 'linkedin', touches: 0, status: 'active' });
    expect(h.ctx.repo.getPerson(p.id)?.nextTouchAt).not.toBeNull();
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      kind: 'bounces', channel: 'email',
      message: '1 address at okopay.com bounced. Callum removed it and will try LinkedIn for that person.',
    }]);
  });

  it('writes one incident for two bounces at the same domain', async () => {
    const h = harness();
    const a = h.person({ email: 'a@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/a' });
    const b = h.person({ email: 'b@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/b' });
    h.due(a.id, 'hello');
    h.due(b.id, 'hello');
    h.adapters.email.results.push(
      { ok: false, error: { code: 'bounce', message: 'gone' } },
      { ok: false, error: { code: 'invalid_recipient', message: 'gone' } },
    );
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      kind: 'bounces',
      message: '2 addresses at okopay.com bounced. Callum removed them and will try LinkedIn for those people.',
    }]);
    expect(h.ctx.repo.getPerson(a.id)?.channel).toBe('linkedin');
    expect(h.ctx.repo.getPerson(b.id)?.channel).toBe('linkedin');
  });

  it('removes a person who has nowhere else to go', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com' });
    h.due(p.id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'bounce', message: 'gone' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ email: null, status: 'removed', nextTouchAt: null });
    expect(h.ctx.repo.listIncidents({ open: true })[0]?.message).toBe('1 address at okopay.com bounced. Callum removed it.');
  });

  it('does not move a person to a channel that is not connected', async () => {
    const h = harness({ connected: ['email'] });
    const p = h.person({ linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    h.due(p.id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'bounce', message: 'gone' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'removed' });
  });

  it('clears a rejected LinkedIn address without a bounce incident', async () => {
    const h = harness();
    const p = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/kemi', email: 'kemi@okopay.com' });
    h.due(p.id, 'invite', 'Hi', null);
    h.adapters.linkedin.results.push({ ok: false, error: { code: 'invalid_recipient', message: 'gone' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ linkedinUrl: null, channel: 'email' });
    expect(h.ctx.repo.listIncidents()).toEqual([]);
  });
});

describe('dispatchDue: user messages that fail', () => {
  it('fails the item and tells the user their reply is saved', async () => {
    const h = harness();
    const p = h.person({ name: 'Kemi Eze', firstName: 'Kemi', status: 'waiting', stage: 'talking' });
    const item = h.ctx.outbox.queueUserSend(p.id, 'reply', 'Thursday at 9:00 works.');
    h.clock.advance(11_000);
    h.adapters.email.results.push({ ok: false, error: { code: 'unknown', message: 'Gmail says the mailbox is full' } });
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(item.id)).toMatchObject({ state: 'failed', error: 'Gmail says the mailbox is full' });
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      kind: 'send_failed', channel: 'email', personId: p.id,
      message: "Your reply to Kemi didn't go out: Gmail says the mailbox is full. It's saved here.",
    }]);
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('waiting');
  });

  it('does not repeat the full stop when the reason already ends with one', async () => {
    const h = harness();
    const p = h.person({ firstName: 'Kemi', status: 'waiting', stage: 'talking' });
    h.ctx.outbox.queueUserSend(p.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    h.adapters.email.results.push({ ok: false, error: { code: 'temporary', message: 'The server is busy.' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.listIncidents()[0]?.message).toBe("Your reply to Kemi didn't go out: The server is busy. It's saved here.");
  });

  it('keeps one incident per person', async () => {
    const h = harness();
    const a = h.person({ firstName: 'Kemi', status: 'waiting', stage: 'talking' });
    const b = h.person({ firstName: 'Tomas', status: 'waiting', stage: 'talking' });
    h.ctx.outbox.queueUserSend(a.id, 'reply', 'Yes.');
    h.ctx.outbox.queueUserSend(b.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    h.adapters.email.results.push(
      { ok: false, error: { code: 'unknown', message: 'one' } },
      { ok: false, error: { code: 'unknown', message: 'two' } },
    );
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.listIncidents().map((i) => i.personId)).toEqual([a.id, b.id]);
  });

  it('leaves a reply scheduled when the mailbox is signed out', async () => {
    const h = harness();
    const p = h.person({ status: 'waiting', stage: 'talking' });
    const item = h.ctx.outbox.queueUserSend(p.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    h.adapters.email.results.push({ ok: false, error: { code: 'auth', message: 'no' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('scheduled');
    expect(h.ctx.repo.listIncidents({ open: true })[0]?.kind).toBe('mailbox_signed_out');
  });

  it('cancels the rest of the sequence once the user has written', async () => {
    const h = harness();
    const p = h.person({ status: 'waiting', stage: 'talking' });
    const later = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Later', 'L', new Date('2026-11-10T08:00:00Z'), false);
    h.ctx.outbox.queueUserSend(p.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(later.id)?.state).toBe('cancelled');
  });
});

describe('dispatchDue: a send is never repeated', () => {
  it('claims the item before the channel is asked', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    let during: unknown = null;
    h.adapters.email.onSend = () => {
      during = h.ctx.repo.getOutbox(id);
    };
    await dispatchDue(h.ctx);
    expect(during).toMatchObject({ state: 'sending', claimedAt: NOW });
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'sent', claimedAt: null, detail: null });
  });

  it('puts the claim back when the channel says no', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    h.adapters.email.results.push({ ok: false, error: { code: 'temporary', message: 'timeout' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'scheduled', claimedAt: null });
  });

  it('records a send again when writing it down failed once, and sends it once', async () => {
    const h = harness();
    const p = h.person();
    const id = h.due(p.id, 'hello');
    const real = h.ctx.repo.insertMessage.bind(h.ctx.repo);
    let fail = true;
    h.ctx.repo.insertMessage = (m) => {
      if (fail) { fail = false; throw new Error('database is locked'); }
      return real(m);
    };
    expect(await dispatchDue(h.ctx)).toBe(1);
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('sent');
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(1);
    expect(h.ctx.repo.getPerson(p.id)?.touches).toBe(1);
  });

  it('writes a send down once even when a step after the commit fails, and says so', async () => {
    const h = harness();
    const p = h.person({ stage: 'talking', touches: 1 });
    const item = h.ctx.outbox.queueUserSend(p.id, 'reply', 'Thanks, Tuesday works.');
    h.clock.advance(60_000);
    const real = h.ctx.outbox.cancelPending.bind(h.ctx.outbox);
    let once = true;
    h.ctx.outbox.cancelPending = (...a: Parameters<typeof real>) => {
      if (once) { once = false; throw new Error('database is locked'); }
      return real(...a);
    };
    h.ctx.repo.insertIncident({ channel: 'email', kind: 'send_failed', message: 'old', personId: p.id });
    const errors: unknown[] = [];
    expect(await dispatchDue(h.ctx, { onError: (e) => errors.push(e) })).toBe(1);
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.ctx.repo.listMessages(p.id).filter((m) => m.direction === 'out')).toHaveLength(1);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('sent');
    expect(errors.map((e) => (e as Error).message)).toEqual(['database is locked']);
    // The other follow-up step still ran.
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
  });

  it('fails an item that went out but could not be written down, and never sends it again', async () => {
    const h = harness();
    const p = h.person();
    const id = h.due(p.id, 'hello');
    h.ctx.repo.insertMessage = () => { throw new Error('disk full'); };
    const errors: unknown[] = [];
    expect(await dispatchDue(h.ctx, { onError: (e) => errors.push(e) })).toBe(0);
    expect(errors).toHaveLength(1);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'failed', error: COULD_NOT_RECORD, detail: '{"maybeSent":true,"unrecorded":true}' });
    await dispatchDue(h.ctx);
    await dispatchDue(h.ctx);
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('lets one bad item go without stopping the rest', async () => {
    const h = harness();
    const bad = h.person();
    const good = h.person();
    h.ctx.outbox.queueAuto(bad.id, 'hello', 'x', 'B', new Date('2026-11-03T08:00:00Z'), false);
    h.ctx.outbox.queueAuto(good.id, 'hello', 'y', 'G', new Date('2026-11-03T08:10:00Z'), false);
    const real = h.ctx.repo.listMessages.bind(h.ctx.repo);
    h.ctx.repo.listMessages = (id) => {
      if (id === bad.id) throw new Error('boom');
      return real(id);
    };
    const errors: unknown[] = [];
    expect(await dispatchDue(h.ctx, { onError: (e) => errors.push(e) })).toBe(1);
    expect(errors).toHaveLength(1);
    expect(h.adapters.email.sent.map((m) => m.subject)).toEqual(['G']);
  });

  it('keeps an adapter that throws apart from one that reports a failure', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    h.adapters.email.onSend = () => { throw new Error('socket closed'); };
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(id)).toMatchObject({ state: 'failed', error: 'socket closed', detail: '{"thrown":true}', claimedAt: null });
    const reported = harness();
    const other = reported.due(reported.person().id, 'hello');
    reported.adapters.email.results.push({ ok: false, error: { code: 'unknown', message: 'Something odd' } });
    await dispatchDue(reported.ctx);
    expect(reported.ctx.repo.getOutbox(other)).toMatchObject({ state: 'failed', detail: null });
  });

  it('turns a claim left by a run that never finished into a failure marked maybe sent, on the next start', () => {
    const h = harness();
    const auto = h.person();
    const talker = h.person({ firstName: 'Kemi', status: 'waiting', stage: 'talking' });
    const a = h.ctx.repo.insertOutbox({ personId: auto.id, channel: 'email', kind: 'hello', body: 'x', state: 'sending', origin: 'auto', sendAfter: NOW, claimedAt: NOW });
    const u = h.ctx.repo.insertOutbox({ personId: talker.id, channel: 'email', kind: 'reply', body: 'x', state: 'sending', origin: 'user', sendAfter: NOW, claimedAt: NOW });
    expect(recoverSending(h.ctx)).toBe(2);
    expect(h.ctx.repo.getOutbox(a.id)).toMatchObject({ state: 'failed', error: CLOSED_WHILE_SENDING, detail: '{"maybeSent":true}' });
    expect(h.ctx.repo.getOutbox(u.id)?.detail).toBe('{"maybeSent":true}');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      kind: 'send_failed', personId: talker.id,
      message: 'Callum was closed while your reply to Kemi was going out. It may have gone, so check your Sent folder before you try again.',
    }]);
    expect(recoverSending(h.ctx)).toBe(0);
  });

  it('leaves a claim alone while its send is under way in this process, as a second ctx starting would find it', async () => {
    const h = harness();
    const id = h.due(h.person().id, 'hello');
    let recovered = -1;
    h.adapters.email.onSend = () => {
      recovered = recoverSending(h.ctx);
    };
    await dispatchDue(h.ctx);
    expect(recovered).toBe(0);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('sent');
  });

  it('does this when Callum starts, and never sends the item on its own afterwards', async () => {
    const db = openDb(':memory:');
    const first = createCtx({ db, env: {}, factory: () => harness().adapters.email });
    const project = first.repo.insertProject({ name: 'One' });
    const p = first.repo.insertPerson({ projectId: project.id, name: 'Kemi Eze', source: 'csv', email: 'k@x.com', channel: 'email' });
    const item = first.repo.insertOutbox({ personId: p.id, channel: 'email', kind: 'hello', body: 'x', state: 'sending', origin: 'auto', sendAfter: '2020-01-01T00:00:00.000Z' });
    const second = createCtx({ db, env: {}, factory: () => harness().adapters.email });
    expect(second.repo.getOutbox(item.id)).toMatchObject({ state: 'failed', detail: '{"maybeSent":true}' });
    expect(second.outbox.due()).toEqual([]);
  });
});

describe('dispatchDue: ordering and holding', () => {
  it('sends the user\'s messages first when asked to, and Callum\'s only after', async () => {
    const h = harness();
    const talker = h.person({ status: 'waiting', stage: 'talking' });
    h.due(h.person().id, 'hello');
    h.ctx.outbox.queueUserSend(talker.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    expect(await dispatchDue(h.ctx, { origin: 'user' })).toBe(1);
    expect(h.adapters.email.sent.map((m) => m.kind)).toEqual(['reply']);
    expect(await dispatchDue(h.ctx, { origin: 'auto' })).toBe(1);
  });

  it('keeps automatic messages for someone whose reply has not been read yet', async () => {
    const h = harness();
    const p = h.person();
    const id = h.due(p.id, 'follow_up');
    h.ctx.repo.insertInboundFailure({ channel: 'email', externalId: '<a@x>', personId: p.id, event: '{}', error: 'down' });
    expect(await dispatchDue(h.ctx)).toBe(0);
    expect(h.ctx.repo.getOutbox(id)?.state).toBe('scheduled');
  });

  it('records the subject that went out, and the thread it was in', async () => {
    const h = harness();
    const p = h.person({ stage: 'talking' });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: 'Quick question', body: 'Hi', at: '2026-11-02T10:00:00.000Z', externalId: '<ours@x>' });
    h.ctx.outbox.queueUserSend(p.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    await dispatchDue(h.ctx);
    expect(h.adapters.email.sent[0]).toMatchObject({ subject: 'Re: Quick question', inReplyTo: '<ours@x>' });
    expect(h.ctx.repo.listMessages(p.id).at(-1)).toMatchObject({ subject: 'Re: Quick question', kind: 'reply' });
  });
});

describe('dispatchDue: a mailbox at its own limit', () => {
  it('holds a reply to the next slot and tells the user when it goes, then settles the notice', async () => {
    const h = harness();
    const p = h.person({ firstName: 'Kemi', status: 'waiting', stage: 'talking' });
    const item = h.ctx.outbox.queueUserSend(p.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    h.adapters.email.results.push({ ok: false, error: { code: 'rate_limit', message: 'Daily user sending quota exceeded' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.getOutbox(item.id)).toMatchObject({ state: 'scheduled', sendAfter: at('2026-11-04T08:00:00Z') });
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{
      kind: 'send_failed', personId: p.id,
      message: "Your reply to Kemi goes Wednesday at 9:00. Your mailbox reached today's limit.",
    }]);
    h.clock.set('2026-11-04T08:00:00Z');
    expect(await dispatchDue(h.ctx)).toBe(1);
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
  });

  it('says the time in the user\'s zone, not the person\'s', async () => {
    const h = harness();
    const p = h.person({ firstName: 'Kemi', status: 'waiting', stage: 'talking', timezone: 'America/New_York' });
    h.ctx.outbox.queueUserSend(p.id, 'reply', 'Yes.');
    h.clock.advance(11_000);
    h.adapters.email.results.push({ ok: false, error: { code: 'rate_limit', message: 'quota' } });
    await dispatchDue(h.ctx);
    // 9:00 in New York is 15:00 in Lagos.
    expect(h.ctx.repo.listIncidents({ open: true })[0]?.message).toBe("Your reply to Kemi goes Wednesday at 15:00. Your mailbox reached today's limit.");
  });
});

describe('dispatchDue: signed out of X or LinkedIn', () => {
  it('uses a notice of its own for each', async () => {
    const h = harness();
    const x = h.person({ channel: 'x', xHandle: 'a', email: null });
    const li = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/a', email: null });
    h.due(x.id, 'hello');
    h.due(li.id, 'invite', 'Hi', null);
    h.adapters.x.results.push({ ok: false, error: { code: 'auth', message: 'no' } });
    h.adapters.linkedin.results.push({ ok: false, error: { code: 'auth', message: 'no' } });
    await dispatchDue(h.ctx);
    expect(h.ctx.repo.listIncidents({ open: true }).map((i) => [i.channel, i.kind, i.message])).toEqual([
      ['x', 'x_signed_out', 'X signed Callum out. 1 message is waiting and nothing was lost.'],
      ['linkedin', 'linkedin_signed_out', 'LinkedIn signed Callum out. 1 message is waiting and nothing was lost.'],
    ]);
  });
});
