import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Bus } from '../bus.js';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { makeProject } from '../db/testing.js';
import { fixedClock } from '../engine/clock.js';
import { Outbox, PlaceholderError, UNDO_MS, UndoError } from './outbox.js';
import type { Scope } from '../../shared/types.js';

const T0 = '2026-11-02T10:00:00.000Z';
let clock: ReturnType<typeof fixedClock>;
let repo: Repo;
let bus: Bus;
let outbox: Outbox;
let events: Scope[];
let projectId: number;
let personId: number;

beforeEach(() => {
  clock = fixedClock(T0);
  repo = new Repo(openDb(':memory:'), () => clock.now().toISOString());
  bus = new Bus();
  events = [];
  bus.on((s) => events.push(s));
  outbox = new Outbox(repo, clock, bus);
  projectId = makeProject(repo).id;
  personId = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv', email: 'kemi@okopay.com', channel: 'email' }).id;
});

const iso = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();

describe('queueUserSend', () => {
  it('schedules 10 seconds out with the person channel', () => {
    const item = outbox.queueUserSend(personId, 'reply', 'Thursday at 9:00 works.', 'Re: hello');
    expect(UNDO_MS).toBe(10_000);
    expect(item).toMatchObject({
      personId, channel: 'email', kind: 'reply', origin: 'user', state: 'scheduled',
      subject: 'Re: hello', body: 'Thursday at 9:00 works.', sendAfter: iso(10_000), undoUntil: iso(10_000),
    });
    expect(events).toContain('outbox');
  });
  it('defaults the subject to null', () => {
    expect(outbox.queueUserSend(personId, 'close', 'Thanks anyway.').subject).toBeNull();
  });
  it('throws PlaceholderError and queues nothing', () => {
    let err: unknown;
    try { outbox.queueUserSend(personId, 'reply', 'Our price is [YOUR PRICE].'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PlaceholderError);
    expect((err as PlaceholderError).placeholders).toEqual(['[YOUR PRICE]']);
    expect(repo.listOutbox()).toEqual([]);
    expect(events).toEqual([]);
  });
  it('also checks the subject for placeholders', () => {
    expect(() => outbox.queueUserSend(personId, 'reply', 'Fine.', 'Hi {first_name}')).toThrow(PlaceholderError);
  });
  it('cancels the earlier scheduled user item for that person only', () => {
    const other = repo.insertPerson({ projectId, name: 'Ada Obi', source: 'csv', email: 'a@b.com', channel: 'email' }).id;
    const first = outbox.queueUserSend(personId, 'reply', 'one');
    const theirs = outbox.queueUserSend(other, 'reply', 'other');
    const auto = outbox.queueAuto(personId, 'follow_up', 'auto', null, new Date(iso(60_000)), false);
    const second = outbox.queueUserSend(personId, 'reply', 'two');
    expect(repo.getOutbox(first.id)?.state).toBe('cancelled');
    expect(repo.getOutbox(second.id)?.state).toBe('scheduled');
    expect(repo.getOutbox(theirs.id)?.state).toBe('scheduled');
    expect(repo.getOutbox(auto.id)?.state).toBe('scheduled');
  });
  it('leaves an earlier user item alone once its undo window has closed', () => {
    const sent = outbox.queueUserSend(personId, 'reply', 'one');
    clock.advance(UNDO_MS);
    const second = outbox.queueUserSend(personId, 'reply', 'two');
    expect(repo.getOutbox(sent.id)?.state).toBe('scheduled');
    expect(repo.getOutbox(second.id)?.state).toBe('scheduled');
    expect(outbox.due().map((i) => i.id)).toEqual([sent.id]);
  });
  it('still cancels an earlier user item at +9.9 s', () => {
    const first = outbox.queueUserSend(personId, 'reply', 'one');
    clock.advance(9_900);
    outbox.queueUserSend(personId, 'reply', 'two');
    expect(repo.getOutbox(first.id)?.state).toBe('cancelled');
  });
  it('keeps the earlier item scheduled if the new one cannot be saved', () => {
    const first = outbox.queueUserSend(personId, 'reply', 'one');
    vi.spyOn(repo, 'insertOutbox').mockImplementationOnce(() => { throw new Error('disk full'); });
    events.length = 0;
    expect(() => outbox.queueUserSend(personId, 'reply', 'two')).toThrow('disk full');
    expect(repo.getOutbox(first.id)?.state).toBe('scheduled');
    expect(events).toEqual([]);
  });
  it('checks subject and body separately, with no match across the two', () => {
    expect(() => outbox.queueUserSend(personId, 'reply', 'PRICE] is fine', 'About [YOUR')).not.toThrow();
    let err: unknown;
    try { outbox.queueUserSend(personId, 'reply', 'Hi {first_name}, [YOUR PRICE], {first_name}', 'Re {first_name} [TOPIC]'); } catch (e) { err = e; }
    expect((err as PlaceholderError).placeholders).toEqual(['{first_name}', '[TOPIC]', '[YOUR PRICE]']);
  });
  it('rejects a person with no channel', () => {
    const bare = repo.insertPerson({ projectId, name: 'No Channel', source: 'paste' }).id;
    expect(() => outbox.queueUserSend(bare, 'reply', 'hi')).toThrow(/channel/);
  });
});

describe('queueAuto', () => {
  it('queues awaiting_ok with no undo window', () => {
    const item = outbox.queueAuto(personId, 'hello', 'Hi Kemi', 'Hello', new Date(iso(3_600_000)), true);
    expect(item).toMatchObject({
      origin: 'auto', state: 'awaiting_ok', channel: 'email', sendAfter: iso(3_600_000), undoUntil: null, subject: 'Hello',
    });
  });
  it('queues scheduled when no OK is needed', () => {
    expect(outbox.queueAuto(personId, 'follow_up', 'Hi again', null, new Date(iso(1000)), false).state).toBe('scheduled');
  });
  it('does not throw on placeholders', () => {
    const item = outbox.queueAuto(personId, 'hello', 'Price: [YOUR PRICE]', null, new Date(iso(1000)), true);
    expect(item.body).toBe('Price: [YOUR PRICE]');
  });
});

describe('undo', () => {
  it('cancels a user item at +9.9 s and refuses at +10 s', () => {
    const a = outbox.queueUserSend(personId, 'reply', 'one');
    clock.advance(9_900);
    expect(outbox.undo(a.id).state).toBe('cancelled');
    const b = outbox.queueUserSend(personId, 'reply', 'two');
    clock.advance(10_000);
    expect(() => outbox.undo(b.id)).toThrow(UndoError);
    expect(() => outbox.undo(b.id)).toThrow('Too late to undo');
    expect(repo.getOutbox(b.id)?.state).toBe('scheduled');
  });
  it('refuses an item that is not scheduled', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi', null, new Date(iso(1000)), true);
    expect(() => outbox.undo(auto.id)).toThrow('Too late to undo');
  });
  it('returns an approved auto item to awaiting_ok and restores the approval', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi Kemi', null, new Date(iso(1000)), true);
    outbox.approve(auto.id);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(9);
    clock.advance(5_000);
    const back = outbox.undo(auto.id);
    expect(back).toMatchObject({ state: 'awaiting_ok', undoUntil: null });
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(10);
  });
});

describe('undo and approvals', () => {
  it('gives back an approval that approve spent', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi', null, new Date(iso(1000)), true);
    expect(outbox.approve(auto.id).approvalCounted).toBe(true);
    expect(outbox.undo(auto.id)).toMatchObject({ state: 'awaiting_ok', approvalCounted: false });
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(10);
    outbox.approve(auto.id);
    outbox.undo(auto.id);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(10);
  });
  it('gives nothing back when approve was made with none left', () => {
    repo.updateProject(projectId, { approvalsLeft: 0 });
    const auto = outbox.queueAuto(personId, 'hello', 'Hi', null, new Date(iso(1000)), true);
    expect(outbox.approve(auto.id).approvalCounted).toBe(false);
    outbox.undo(auto.id);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(0);
  });
});

describe('approvals are per project', () => {
  it('spends and restores the approval of the project the person belongs to', () => {
    const second = makeProject(repo);
    const ada = repo.insertPerson({ projectId: second.id, name: 'Ada Obi', source: 'csv', email: 'ada@x.com', channel: 'email' }).id;
    const mine = outbox.queueAuto(personId, 'hello', 'Hi Kemi', null, new Date(iso(1000)), true);
    const theirs = outbox.queueAuto(ada, 'hello', 'Hi Ada', null, new Date(iso(1000)), true);
    outbox.approve(theirs.id);
    expect(repo.getProject(second.id)?.approvalsLeft).toBe(9);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(10);
    outbox.approve(mine.id);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(9);
    outbox.undo(theirs.id);
    expect(repo.getProject(second.id)?.approvalsLeft).toBe(10);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(9);
  });
  it('an empty project does not use up another project\'s approvals', () => {
    const second = makeProject(repo);
    repo.updateProject(second.id, { approvalsLeft: 0 });
    const ada = repo.insertPerson({ projectId: second.id, name: 'Ada Obi', source: 'csv', channel: 'email' }).id;
    const item = outbox.queueAuto(ada, 'hello', 'Hi Ada', null, new Date(iso(1000)), true);
    expect(outbox.approve(item.id).approvalCounted).toBe(false);
    expect(repo.getProject(second.id)?.approvalsLeft).toBe(0);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(10);
  });
});

describe('approve', () => {
  it('schedules at least 10 s out and spends one approval', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi Kemi', null, new Date(iso(1000)), true);
    const item = outbox.approve(auto.id);
    expect(item).toMatchObject({ state: 'scheduled', sendAfter: iso(10_000), undoUntil: iso(10_000) });
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(9);
  });
  it('keeps a later sendAfter', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi Kemi', null, new Date(iso(3_600_000)), true);
    expect(outbox.approve(auto.id)).toMatchObject({ sendAfter: iso(3_600_000), undoUntil: iso(10_000) });
  });
  it('takes an edited body', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi Kemi', null, new Date(iso(1000)), true);
    expect(outbox.approve(auto.id, 'Hi Kemi, edited').body).toBe('Hi Kemi, edited');
  });
  it('throws when the edited body has a placeholder and changes nothing', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi Kemi', null, new Date(iso(1000)), true);
    let err: unknown;
    try { outbox.approve(auto.id, 'Hi {first_name}'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PlaceholderError);
    expect((err as PlaceholderError).placeholders).toEqual(['{first_name}']);
    expect(repo.getOutbox(auto.id)).toMatchObject({ state: 'awaiting_ok', body: 'Hi Kemi' });
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(10);
  });
  it('throws when the stored body has a placeholder', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Price [YOUR PRICE]', null, new Date(iso(1000)), true);
    expect(() => outbox.approve(auto.id)).toThrow(PlaceholderError);
  });
  it('only works from awaiting_ok', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi', null, new Date(iso(1000)), false);
    expect(() => outbox.approve(auto.id)).toThrow(UndoError);
  });
  it('never takes approvalsLeft below 0', () => {
    repo.updateProject(projectId, { approvalsLeft: 0 });
    const auto = outbox.queueAuto(personId, 'hello', 'Hi', null, new Date(iso(1000)), true);
    outbox.approve(auto.id);
    expect(repo.getProject(projectId)?.approvalsLeft).toBe(0);
  });
});

describe('cancelPending', () => {
  it('cancels auto items by default and leaves user items', () => {
    const a = outbox.queueAuto(personId, 'hello', 'Hi', null, new Date(iso(1000)), true);
    const b = outbox.queueAuto(personId, 'follow_up', 'Hi again', null, new Date(iso(2000)), false);
    const u = outbox.queueUserSend(personId, 'reply', 'mine');
    expect(outbox.cancelPending(personId)).toBe(2);
    expect(repo.getOutbox(a.id)?.state).toBe('cancelled');
    expect(repo.getOutbox(b.id)?.state).toBe('cancelled');
    expect(repo.getOutbox(u.id)?.state).toBe('scheduled');
  });
  it('cancels user items when asked', () => {
    const u = outbox.queueUserSend(personId, 'reply', 'mine');
    expect(outbox.cancelPending(personId, ['auto', 'user'])).toBe(1);
    expect(repo.getOutbox(u.id)?.state).toBe('cancelled');
  });
  it('leaves sent items and other people alone, and is quiet when nothing changed', () => {
    const sent = repo.insertOutbox({ personId, channel: 'email', kind: 'hello', body: 'x', state: 'sent', origin: 'auto', sendAfter: T0 });
    const other = repo.insertPerson({ projectId, name: 'Ada Obi', source: 'csv', channel: 'email' }).id;
    outbox.queueAuto(other, 'hello', 'Hi', null, new Date(iso(1000)), true);
    events.length = 0;
    expect(outbox.cancelPending(personId)).toBe(0);
    expect(repo.getOutbox(sent.id)?.state).toBe('sent');
    expect(events).toEqual([]);
  });
});

describe('due and pendingFor', () => {
  it('due lists only scheduled items at or before now', () => {
    const now = outbox.queueAuto(personId, 'follow_up', 'now', null, new Date(T0), false);
    outbox.queueAuto(personId, 'follow_up', 'later', null, new Date(iso(1)), false);
    outbox.queueAuto(personId, 'hello', 'needs ok', null, new Date(T0), true);
    repo.insertOutbox({ personId, channel: 'email', kind: 'hello', body: 'x', state: 'sent', origin: 'auto', sendAfter: T0 });
    expect(outbox.due().map((i) => i.id)).toEqual([now.id]);
    clock.advance(1);
    expect(outbox.due()).toHaveLength(2);
  });
  it('pendingFor lists awaiting_ok and scheduled for one person', () => {
    outbox.queueAuto(personId, 'hello', 'a', null, new Date(iso(1000)), true);
    outbox.queueAuto(personId, 'follow_up', 'b', null, new Date(iso(2000)), false);
    const before = outbox.pendingFor(personId);
    expect(before).toHaveLength(2);
    outbox.cancelPending(personId, ['auto']);
    expect(outbox.pendingFor(personId)).toEqual([]);
    const d = outbox.queueAuto(personId, 'follow_up', 'd', null, new Date(iso(4000)), false);
    const other = repo.insertPerson({ projectId, name: 'Ada Obi', source: 'csv', channel: 'email' }).id;
    outbox.queueAuto(other, 'hello', 'x', null, new Date(iso(1000)), true);
    expect(outbox.pendingFor(personId).map((i) => i.id)).toEqual([d.id]);
  });
});

describe('bus', () => {
  it('emits outbox on every mutation', () => {
    const auto = outbox.queueAuto(personId, 'hello', 'Hi', null, new Date(iso(1000)), true);
    expect(events.at(-1)).toBe('outbox');
    events.length = 0;
    outbox.approve(auto.id);
    expect(events).toEqual(['outbox']);
    events.length = 0;
    outbox.undo(auto.id);
    expect(events).toEqual(['outbox']);
    events.length = 0;
    outbox.cancelPending(personId);
    expect(events).toEqual(['outbox']);
  });
});
