import { describe, expect, it } from 'vitest';
import { createSpacer, SEND_GAP_MS } from './dispatch.js';
import { restAgain, wakeEarly } from '../services/person.js';
import { Runner } from './runner.js';
import { harness } from './testing.test-helpers.js';

// A morning of messages goes out one at a time with a pause between, never as a burst.

const NINE = '2026-11-03T08:00:00.000Z'; // Tuesday 9:00 in Lagos
const MIN = 60_000;

function setup(random = () => 0) {
  const h = harness({ now: NINE });
  const errors: unknown[] = [];
  const runner = new Runner(h.ctx, { onError: (e) => errors.push(e), spacing: { random } });
  return { h, runner, errors };
}
const sentTo = (h: ReturnType<typeof harness>, ch: 'email' | 'linkedin') => h.adapters[ch].sent.map((m) => m.to.name);

describe('gaps between a channel\'s automatic messages', () => {
  it('are 3 to 8 minutes on LinkedIn, 45 to 150 seconds on email and about a minute on X', () => {
    expect(SEND_GAP_MS.linkedin).toEqual([3 * MIN, 8 * MIN]);
    expect(SEND_GAP_MS.email).toEqual([45_000, 150_000]);
    const [xLow, xHigh] = SEND_GAP_MS.x;
    expect(xLow).toBeGreaterThanOrEqual(45_000);
    expect(xHigh).toBeLessThanOrEqual(75_000);
    expect((xLow + xHigh) / 2).toBe(60_000);
  });

  it('are drawn between the two ends by the random number', () => {
    const now = new Date(NINE);
    for (const ch of ['linkedin', 'email', 'x'] as const) {
      const [low, high] = SEND_GAP_MS[ch];
      for (const [r, gap] of [[0, low], [1, high], [0.5, Math.round((low + high) / 2)]] as const) {
        const spacer = createSpacer(() => r);
        expect(spacer.ready(ch, now)).toBe(true);
        spacer.used(ch, now);
        expect(spacer.ready(ch, new Date(now.getTime() + gap - 1))).toBe(false);
        expect(spacer.ready(ch, new Date(now.getTime() + gap))).toBe(true);
      }
    }
  });

  it('are kept apart per channel: LinkedIn waiting does not hold email', () => {
    const spacer = createSpacer(() => 1);
    const now = new Date(NINE);
    spacer.used('linkedin', now);
    expect(spacer.ready('email', now)).toBe(true);
    expect(spacer.ready('x', now)).toBe(true);
  });
});

describe('one pass of the runner', () => {
  it('sends at most one automatic message per channel, however many are due', async () => {
    const { h, runner, errors } = setup();
    for (let i = 0; i < 10; i++) h.person({ name: `Li${i} Person`, email: null, channel: 'linkedin', linkedinUrl: `https://www.linkedin.com/in/li-${i}` });
    for (let i = 0; i < 10; i++) h.person({ name: `Em${i} Person`, email: `em${i}@example.com` });
    await runner.tick();
    expect(errors).toEqual([]);
    expect(h.adapters.linkedin.sent).toHaveLength(1);
    expect(h.adapters.email.sent).toHaveLength(1);
    // Straight after, nothing more: the gap has not passed.
    await runner.tick();
    expect(h.adapters.linkedin.sent).toHaveLength(1);
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('sends the next one only when the gap is over, and the spread over a morning is a trickle', async () => {
    const { h, runner } = setup(() => 0);
    for (let i = 0; i < 6; i++) h.person({ name: `Li${i} Person`, email: null, channel: 'linkedin', linkedinUrl: `https://www.linkedin.com/in/li-${i}` });
    for (let i = 0; i < 6; i++) h.person({ name: `Em${i} Person`, email: `em${i}@example.com` });
    const at: string[] = [];
    for (let s = 0; s <= 10 * MIN; s += 15_000) {
      const before = [h.adapters.linkedin.sent.length, h.adapters.email.sent.length];
      await runner.tick();
      const after = [h.adapters.linkedin.sent.length, h.adapters.email.sent.length];
      if (after[0] !== before[0]) at.push(`linkedin +${s / 1000}s`);
      if (after[1] !== before[1]) at.push(`email +${s / 1000}s`);
      h.clock.advance(15_000);
    }
    // random() = 0 means the shortest gaps: LinkedIn every 3 minutes, email every 45 seconds.
    expect(at.filter((l) => l.startsWith('linkedin'))).toEqual(['linkedin +0s', 'linkedin +180s', 'linkedin +360s', 'linkedin +540s']);
    expect(at.filter((l) => l.startsWith('email'))).toEqual(['email +0s', 'email +45s', 'email +90s', 'email +135s', 'email +180s', 'email +225s']);
  });

  it('with the longest gaps nothing goes sooner than 8 minutes on LinkedIn', async () => {
    const { h, runner } = setup(() => 1);
    for (let i = 0; i < 3; i++) h.person({ name: `Li${i} Person`, email: null, channel: 'linkedin', linkedinUrl: `https://www.linkedin.com/in/li-${i}` });
    await runner.tick();
    h.clock.advance(8 * MIN - 1000);
    await runner.tick();
    expect(h.adapters.linkedin.sent).toHaveLength(1);
    h.clock.advance(1000);
    await runner.tick();
    expect(h.adapters.linkedin.sent).toHaveLength(2);
  });
});

describe('what the user wrote', () => {
  it('is never spaced and goes ahead of Callum\'s own, even while a channel is waiting out its gap', async () => {
    const { h, runner } = setup(() => 1);
    const people = Array.from({ length: 4 }, (_, i) => h.person({ name: `Em${i} Person`, email: `em${i}@example.com`, status: 'waiting', stage: 'hello', touches: 1 }));
    for (let i = 0; i < 3; i++) h.person({ name: `Auto${i} Person`, email: `auto${i}@example.com` });
    await runner.tick();
    expect(sentTo(h, 'email')).toHaveLength(1); // one automatic hello; the gap is now 150 s
    for (const p of people) h.ctx.outbox.queueUserSend(p.id, 'reply', `Thanks ${p.firstName}, Thursday works.`, null);
    h.clock.advance(11_000); // past the 10 s undo, inside the 150 s gap
    await runner.tick();
    const names = sentTo(h, 'email');
    expect(names.slice(1).sort()).toEqual(people.map((p) => p.name).sort());
    expect(names.filter((n) => n.startsWith('Auto'))).toHaveLength(1);
  });

  it('goes first in the pass: with an automatic message due on the same channel, the reply is sent before it', async () => {
    const { h, runner } = setup(() => 0);
    const bola = h.person({ name: 'Bola Ade', email: 'bola@example.com', status: 'waiting', stage: 'hello', touches: 1 });
    h.person({ name: 'Auto Person', email: 'auto@example.com' });
    h.ctx.outbox.queueUserSend(bola.id, 'reply', 'Thanks Bola, Thursday works.', null);
    h.clock.advance(11_000);
    await runner.tick();
    expect(sentTo(h, 'email')).toEqual(['Bola Ade', 'Auto Person']);
  });

  it('waits out its 10 seconds of undo, wherever the pass falls', async () => {
    const { h, runner } = setup(() => 0);
    const bola = h.person({ name: 'Bola Ade', email: 'bola@example.com', status: 'waiting', stage: 'hello', touches: 1 });
    h.clock.advance(3 * MIN);
    h.ctx.outbox.queueUserSend(bola.id, 'reply', 'Thanks Bola, Thursday works.', null);
    await runner.tick();
    expect(sentTo(h, 'email')).toEqual([]);
    h.clock.advance(9_000);
    await runner.tick();
    expect(sentTo(h, 'email')).toEqual([]);
    h.clock.advance(1_000);
    await runner.tick();
    expect(sentTo(h, 'email')).toEqual(['Bola Ade']);
  });
});

describe('a person who asks Callum to stop', () => {
  it('is heard before any follow-up to them, because each pass reads the replies first and passes are short', async () => {
    const { h, runner } = setup(() => 0);
    // Busy morning: LinkedIn sends are going out one every 3 minutes, email one every 45 seconds.
    for (let i = 0; i < 6; i++) h.person({ name: `Li${i} Person`, email: null, channel: 'linkedin', linkedinUrl: `https://www.linkedin.com/in/li-${i}` });
    for (let i = 0; i < 6; i++) h.person({ name: `Em${i} Person`, email: `em${i}@example.com` });
    // Kemi's follow-up falls due at 9:03.
    const kemi = h.person({ name: 'Kemi Eze', email: 'kemi@okopay.com', touches: 1, stage: 'hello', lastTouchAt: '2026-10-29T09:00:00.000Z', nextTouchAt: '2026-11-03T08:03:00.000Z' });
    await runner.tick();
    h.clock.advance(3 * MIN);
    // She writes stop at 9:03, the moment before her follow-up is due.
    h.adapters.email.inbox.push([{ type: 'reply', from: { email: 'kemi@okopay.com' }, text: 'Please stop emailing me.', at: h.clock.now().toISOString(), externalId: '<stop@okopay>' }]);
    await runner.tick();
    expect(h.ctx.repo.getPerson(kemi.id)?.status).toBe('stopped');
    expect(h.ctx.repo.isSuppressed({ email: 'kemi@okopay.com' })).toBe(true);
    expect(h.adapters.email.sent.some((m) => m.to.email === 'kemi@okopay.com')).toBe(false);
    for (let i = 0; i < 40; i++) {
      h.clock.advance(15_000);
      await runner.tick();
    }
    expect(h.adapters.email.sent.some((m) => m.to.email === 'kemi@okopay.com')).toBe(false);
  });
});

describe('waking someone early', () => {
  it('sends nothing until the 10 seconds of Undo are over, and Undo in that time takes the hello back', async () => {
    const { h, runner } = setup(() => 0);
    const p = h.person({ email: 'kemi@okopay.com', status: 'resting', stage: 'stranger', touches: 0, restUntil: '2027-01-30T00:00:00.000Z', lastTouchAt: '2026-10-01T09:00:00.000Z' });
    wakeEarly(h.ctx, p.id);
    await runner.tick();
    expect(h.adapters.email.sent).toEqual([]);
    h.clock.advance(3_000);
    expect(restAgain(h.ctx, p.id).status).toBe('resting');
    h.clock.advance(60_000);
    await runner.tick();
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('sends the hello once the Undo window has passed', async () => {
    const { h, runner } = setup(() => 0);
    const p = h.person({ email: 'kemi@okopay.com', status: 'resting', stage: 'stranger', touches: 0, restUntil: '2027-01-30T00:00:00.000Z', lastTouchAt: '2026-10-01T09:00:00.000Z' });
    wakeEarly(h.ctx, p.id);
    h.clock.advance(10_500);
    await runner.tick();
    expect(h.adapters.email.sent.map((m) => m.to.email)).toEqual(['kemi@okopay.com']);
  });
});
