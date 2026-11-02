import { describe, expect, it } from 'vitest';
import type { Person, PersonStatus, Stage } from '../../shared/types.js';
import { riverLayout, STAGE_ORDER, type FaceItem, type GroupItem } from './layout.js';

function person(id: number, stage: Stage, status: PersonStatus = 'active', over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name: `Person ${id}`, firstName: `Person${id}`, company: 'Oko Pay', role: 'Founder', email: `p${id}@okopay.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage, status, touches: 0, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z',
    ...over,
  };
}

const faces = (items: ReturnType<typeof riverLayout>['items']) => items.filter((i): i is FaceItem => i.kind === 'face');
const groups = (items: ReturnType<typeof riverLayout>['items']) => items.filter((i): i is GroupItem => i.kind === 'group');

describe('riverLayout', () => {
  it('has four lanes from stranger to talking', () => {
    expect(STAGE_ORDER).toEqual(['stranger', 'hello', 'following', 'talking']);
  });

  it('puts one person per stage left to right and grows the faces', () => {
    const { items } = riverLayout(STAGE_ORDER.map((s, i) => person(i + 1, s)), 1000, 280);
    const f = faces(items);
    expect(f).toHaveLength(4);
    const byStage = (s: Stage) => f.find((x) => x.person.stage === s)!;
    expect(byStage('stranger').x).toBeLessThan(byStage('hello').x);
    expect(byStage('hello').x).toBeLessThan(byStage('following').x);
    expect(byStage('following').x).toBeLessThan(byStage('talking').x);
    expect(STAGE_ORDER.map((s) => byStage(s).size)).toEqual([22, 26, 30, 34]);
  });

  it('keeps every face inside the river', () => {
    const people = Array.from({ length: 50 }, (_, i) => person(i + 1, STAGE_ORDER[i % 4]!));
    for (const f of faces(riverLayout(people, 1000, 280).items)) {
      expect(f.x).toBeGreaterThan(0);
      expect(f.x).toBeLessThan(1000);
      expect(f.y).toBeGreaterThan(0);
      expect(f.y).toBeLessThan(280);
    }
  });

  it('sends waiting people and snoozed people who are due to the dock, not the river', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    const people = [
      person(1, 'talking', 'waiting', { repliedAt: '2026-11-02T08:00:00Z' }),
      person(2, 'hello', 'snoozed', { snoozedUntil: '2026-11-02T09:00:00Z', repliedAt: '2026-11-01T08:00:00Z' }),
      person(3, 'hello', 'snoozed', { snoozedUntil: '2026-11-09T09:00:00Z' }),
      person(4, 'hello'),
    ];
    const out = riverLayout(people, 1000, 280, { now });
    expect(out.dock.map((p) => p.id)).toEqual([2, 1]);
    expect(faces(out.items).map((f) => f.person.id)).toEqual([4]);
  });

  it('does not draw stopped, closed, resting or removed people, and keeps held people in their lane', () => {
    const people = [
      person(1, 'hello', 'stopped'), person(2, 'hello', 'closed'), person(3, 'hello', 'resting'), person(4, 'hello', 'removed'),
      person(5, 'following', 'held'),
    ];
    const out = riverLayout(people, 1000, 280);
    expect(faces(out.items).map((f) => f.person.id)).toEqual([5]);
    expect(out.dock).toEqual([]);
  });

  it('collapses each lane into one group bubble with its exact count past sixty faces', () => {
    const stages: Stage[] = ['stranger', 'stranger', 'stranger', 'hello', 'following', 'talking'];
    const people = Array.from({ length: 61 }, (_, i) => person(i + 1, stages[i % stages.length]!));
    const out = riverLayout(people, 1000, 280);
    expect(faces(out.items)).toHaveLength(0);
    const g = groups(out.items);
    expect(g.map((x) => x.stage)).toEqual(STAGE_ORDER);
    expect(g.reduce((sum, x) => sum + x.count, 0)).toBe(61);
    expect(g.find((x) => x.stage === 'stranger')!.count).toBe(people.filter((p) => p.stage === 'stranger').length);
  });

  it('keeps faces at exactly sixty and honours a different groupAbove', () => {
    const sixty = Array.from({ length: 60 }, (_, i) => person(i + 1, 'stranger'));
    expect(faces(riverLayout(sixty, 1000, 280).items)).toHaveLength(60);
    expect(groups(riverLayout(sixty, 1000, 280, { groupAbove: 10 }).items)).toHaveLength(1);
  });

  it('counts people the dock holds out of the face total', () => {
    const people = [...Array.from({ length: 60 }, (_, i) => person(i + 1, 'stranger')), person(99, 'talking', 'waiting')];
    const out = riverLayout(people, 1000, 280);
    expect(faces(out.items)).toHaveLength(60);
    expect(out.dock).toHaveLength(1);
  });

  it('is deterministic for the same input and does not move a face when someone else leaves another lane', () => {
    const people = Array.from({ length: 20 }, (_, i) => person(i + 1, STAGE_ORDER[i % 4]!));
    expect(riverLayout(people, 1000, 280)).toEqual(riverLayout([...people], 1000, 280));
    const before = faces(riverLayout(people, 1000, 280).items).find((f) => f.person.id === 2)!;
    const without = people.filter((p) => p.id !== 4);
    const after = faces(riverLayout(without, 1000, 280).items).find((f) => f.person.id === 2)!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
  });

  it('never puts two faces of the same lane on the same spot', () => {
    const people = Array.from({ length: 40 }, (_, i) => person(i + 1, 'stranger'));
    const spots = new Set(faces(riverLayout(people, 1000, 280).items).map((f) => `${f.x.toFixed(2)},${f.y.toFixed(2)}`));
    expect(spots.size).toBe(40);
  });

  it('reports a count for each lane', () => {
    const people = [person(1, 'stranger'), person(2, 'stranger'), person(3, 'talking')];
    expect(riverLayout(people, 1000, 280).counts).toEqual({ stranger: 2, hello: 0, following: 0, talking: 1 });
  });
});
