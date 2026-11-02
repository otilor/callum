import { describe, expect, it } from 'vitest';
import { INCIDENT_COPY, channelRateLimited, channelSignedOut, formatSlot, openIncident, refreshSignedOutCount, resumeChannel } from './incidents.js';
import { harness } from './testing.test-helpers.js';

describe('INCIDENT_COPY', () => {
  it('says what the design says', () => {
    expect(INCIDENT_COPY.linkedin_check).toBe("LinkedIn asked to check it's you, so Callum paused LinkedIn to keep your account safe. Email and X keep going.");
    expect(INCIDENT_COPY.linkedin_weekly_limit).toBe("LinkedIn's weekly invite limit is reached. New invites wait until Monday. Messages to your connections keep going.");
    expect(INCIDENT_COPY.x_limit).toBe("X stopped accepting Callum's messages because your X plan's daily limit is reached. DMs resume tomorrow at 9:00.");
    expect(INCIDENT_COPY.mailbox_signed_out('Google', 'gabriel@yourcompany.com', 14)).toBe('Google signed Callum out of gabriel@yourcompany.com. 14 emails are waiting and nothing was lost.');
    expect(INCIDENT_COPY.mailbox_signed_out('Google', 'a@b.com', 1)).toBe('Google signed Callum out of a@b.com. 1 email is waiting and nothing was lost.');
    expect(INCIDENT_COPY.mailbox_signed_out('Google', 'a@b.com', 0)).toBe('Google signed Callum out of a@b.com. No emails are waiting and nothing was lost.');
    expect(INCIDENT_COPY.bounces(8, 'fieldnote.com', 'LinkedIn')).toBe('8 addresses at fieldnote.com bounced. Callum removed them and will try LinkedIn for those people.');
    expect(INCIDENT_COPY.send_failed('Tomás', 'Gmail says the mailbox is full')).toBe("Your reply to Tomás didn't go out: Gmail says the mailbox is full. It's saved here.");
  });

  it('has no exclamation marks', () => {
    const texts = [
      INCIDENT_COPY.linkedin_check, INCIDENT_COPY.linkedin_weekly_limit, INCIDENT_COPY.x_limit,
      INCIDENT_COPY.mailbox_signed_out('Google', 'a@b.com', 3), INCIDENT_COPY.bounces(2, 'a.com', 'X'), INCIDENT_COPY.send_failed('Kemi', 'No'),
    ];
    expect(texts.join(' ')).not.toContain('!');
  });
});

describe('openIncident', () => {
  it('updates the open incident of the same channel and kind instead of adding another', () => {
    const h = harness();
    const first = openIncident(h.ctx, { channel: 'x', kind: 'x_limit', message: 'one', detail: 'a' });
    const second = openIncident(h.ctx, { channel: 'x', kind: 'x_limit', message: 'two' });
    expect(second.id).toBe(first.id);
    expect(h.ctx.repo.listIncidents()).toMatchObject([{ message: 'two', detail: 'a', state: 'open' }]);
    expect(h.scopes).toContain('incidents');
  });

  it('keeps different channels and kinds apart, and does not reuse a resolved one', () => {
    const h = harness();
    const a = openIncident(h.ctx, { channel: 'x', kind: 'x_limit', message: 'x' });
    const b = openIncident(h.ctx, { channel: 'linkedin', kind: 'linkedin_check', message: 'l' });
    h.ctx.repo.updateIncident(a.id, { state: 'resolved', resolvedAt: '2026-11-03T08:00:00.000Z' });
    const c = openIncident(h.ctx, { channel: 'x', kind: 'x_limit', message: 'again' });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('writes one bounces incident per domain per UTC day', () => {
    const h = harness();
    const bounce = (domain: string) => openIncident(h.ctx, { channel: 'email', kind: 'bounces', message: domain, detail: JSON.stringify({ domain, people: [] }) });
    const a = bounce('okopay.com');
    expect(bounce('okopay.com').id).toBe(a.id);
    expect(bounce('fieldnote.com').id).not.toBe(a.id);
    h.clock.set('2026-11-04T00:00:01Z');
    expect(bounce('okopay.com').id).not.toBe(a.id);
  });

  it('keeps a failed reply per person', () => {
    const h = harness();
    const a = openIncident(h.ctx, { channel: 'email', kind: 'send_failed', message: 'a', personId: 1 });
    expect(openIncident(h.ctx, { channel: 'email', kind: 'send_failed', message: 'a2', personId: 1 }).id).toBe(a.id);
    expect(openIncident(h.ctx, { channel: 'email', kind: 'send_failed', message: 'b', personId: 2 }).id).not.toBe(a.id);
  });
});

describe('resumeChannel', () => {
  it('goes back to connected at half pace for a week and settles the notice about the stop', () => {
    const h = harness();
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    openIncident(h.ctx, { channel: 'linkedin', kind: 'linkedin_check', message: 'c' });
    openIncident(h.ctx, { channel: 'linkedin', kind: 'linkedin_weekly_limit', message: 'w' });
    openIncident(h.ctx, { channel: 'x', kind: 'x_limit', message: 'x' });
    const account = resumeChannel(h.ctx, 'linkedin', 'half');
    expect(account).toMatchObject({ status: 'connected', pausedUntil: null, halfPaceUntil: '2026-11-10T08:30:00.000Z' });
    expect(h.ctx.repo.getChannel('linkedin').halfPaceUntil).toBe('2026-11-10T08:30:00.000Z');
    expect(h.ctx.repo.listIncidents({ open: true }).map((i) => i.kind).sort()).toEqual(['linkedin_weekly_limit', 'x_limit']);
    expect(h.ctx.repo.listIncidents().find((i) => i.kind === 'linkedin_check')).toMatchObject({ state: 'resolved', resolvedAt: '2026-11-03T08:30:00.000Z' });
    expect(h.scopes).toEqual(expect.arrayContaining(['channels', 'incidents']));
  });

  it('resumes at full pace and clears an earlier half pace', () => {
    const h = harness();
    h.ctx.repo.updateChannel('linkedin', { status: 'paused', halfPaceUntil: '2026-11-09T00:00:00.000Z' });
    expect(resumeChannel(h.ctx, 'linkedin', 'full')).toMatchObject({ status: 'connected', halfPaceUntil: null });
  });

  it('settles a sign-out notice when the channel is back', () => {
    const h = harness();
    for (const [channel, kind] of [['email', 'mailbox_signed_out'], ['x', 'x_signed_out'], ['linkedin', 'linkedin_signed_out']] as const) {
      openIncident(h.ctx, { channel, kind, message: 'out' });
      resumeChannel(h.ctx, channel, 'full');
    }
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
  });

  it('leaves a saved reply that did not go out', () => {
    const h = harness();
    openIncident(h.ctx, { channel: 'email', kind: 'send_failed', message: 's', personId: 1 });
    resumeChannel(h.ctx, 'email', 'full');
    expect(h.ctx.repo.listIncidents({ open: true })).toHaveLength(1);
  });
});

describe('channelRateLimited', () => {
  it('keeps the provider words when the account is out of credits', () => {
    const h = harness();
    const words = "X stopped accepting Callum's messages because your X developer account is out of credits. Add credits in the X developer portal.";
    channelRateLimited(h.ctx, 'x', words);
    expect(h.ctx.repo.listIncidents()[0]?.message).toBe(words);
  });
});

describe('signed out', () => {
  it('has copy of its own for X and LinkedIn', () => {
    expect(INCIDENT_COPY.x_signed_out(3)).toBe('X signed Callum out. 3 messages are waiting and nothing was lost.');
    expect(INCIDENT_COPY.linkedin_signed_out(1)).toBe('LinkedIn signed Callum out. 1 message is waiting and nothing was lost.');
    expect(INCIDENT_COPY.linkedin_signed_out(0)).toBe('LinkedIn signed Callum out. No messages are waiting and nothing was lost.');
  });

  it('uses a kind per channel, and keeps the count true as messages arrive', () => {
    const h = harness();
    const x = channelSignedOut(h.ctx, 'x');
    const li = channelSignedOut(h.ctx, 'linkedin');
    expect([x.kind, li.kind]).toEqual(['x_signed_out', 'linkedin_signed_out']);
    expect(h.ctx.repo.getChannel('x').status).toBe('error');
    const p = h.person({ channel: 'x', xHandle: 'a', email: null });
    h.due(p.id, 'hello');
    refreshSignedOutCount(h.ctx);
    expect(h.ctx.repo.listIncidents().find((i) => i.kind === 'x_signed_out')?.message).toBe('X signed Callum out. 1 message is waiting and nothing was lost.');
  });

  it('formats a time as a weekday and a clock time in the user zone', () => {
    expect(formatSlot(new Date('2026-11-04T08:00:00Z'), 'Africa/Lagos')).toBe('Wednesday at 9:00');
    expect(formatSlot(new Date('2026-11-05T13:30:00Z'), 'Africa/Lagos')).toBe('Thursday at 14:30');
  });
});
