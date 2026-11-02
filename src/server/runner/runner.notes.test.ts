import { describe, expect, it } from 'vitest';
import { Runner } from './runner.js';
import { harness, type Harness } from './testing.test-helpers.js';

// Lagos is UTC+1 all year. Monday 2 November 8:30 there is 07:30 UTC.
const MONDAY_NOTE = '2026-11-02T07:30:00.000Z';

function runnerFor(h: Harness): { runner: Runner; errors: unknown[] } {
  const errors: unknown[] = [];
  return { runner: new Runner(h.ctx, { onError: (e) => errors.push(e) }), errors };
}

describe('Runner.tick: the weekly note', () => {
  it('sends exactly one weekly email at Monday 8:30 and none on the next tick', async () => {
    const h = harness({ now: MONDAY_NOTE, approvalsLeft: 0 });
    const kemi = h.person({ name: 'Kemi Eze', email: 'kemi@okopay.com', stage: 'hello', touches: 1, lastTouchAt: '2026-10-27T09:00:00.000Z', nextTouchAt: '2026-11-20T09:00:00.000Z' });
    h.ctx.repo.insertMessage({ personId: kemi.id, channel: 'email', direction: 'out', kind: 'hello', subject: null, body: 'Hi', at: '2026-10-27T09:12:00.000Z', externalId: null });
    const { runner, errors } = runnerFor(h);

    await runner.tick();
    expect(errors).toEqual([]);
    const notes = h.adapters.email.sent.filter((m) => m.to.email === 'ada@example.com');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.subject).toMatch(/^Your week/);

    await runner.tick();
    expect(h.adapters.email.sent.filter((m) => m.to.email === 'ada@example.com')).toHaveLength(1);
  });

  it('sends nothing before 8:30', async () => {
    const h = harness({ now: '2026-11-02T07:00:00.000Z', approvalsLeft: 0 });
    const { runner, errors } = runnerFor(h);
    await runner.tick();
    expect(errors).toEqual([]);
    expect(h.adapters.email.sent).toEqual([]);
  });
});

describe('Runner.tick: a referral is the user\'s to write to first', () => {
  it('does not plan a fresh referral for 24 hours, then plans it', async () => {
    const h = harness({ now: '2026-11-03T08:30:00.000Z', approvalsLeft: 0 }); // Tuesday 9:30 in Lagos
    const sam = h.person({ name: 'Sam Ojo', email: 'sam@okopay.com', source: 'referral' });
    const { runner, errors } = runnerFor(h);

    await runner.tick();
    expect(errors).toEqual([]);
    expect(h.ctx.repo.listOutbox({ personId: sam.id })).toEqual([]);
    expect(h.adapters.email.sent).toEqual([]);

    h.clock.set('2026-11-04T09:30:00.000Z'); // Wednesday 10:30, more than 24 hours on
    await runner.tick();
    expect(errors).toEqual([]);
    expect(h.adapters.email.sent.filter((m) => m.to.email === 'sam@okopay.com')).toHaveLength(1);
  });
});
