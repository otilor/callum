import { describe, expect, it } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { DEMO_REPLIES, createDemoAdapter, demoHash } from './demo.js';
import type { Recipient } from './types.js';

function recipient(name: string): Recipient {
  return { name, email: `${name.toLowerCase().replace(/ /g, '.')}@example.com`, linkedinUrl: null, xHandle: null };
}

// Find names with a given hash residue so the tests do not depend on a specific hash value.
function nameWhere(test: (h: number) => boolean): string {
  for (let i = 0; i < 500; i++) {
    const name = `Person ${i}`;
    if (test(demoHash(name))) return name;
  }
  throw new Error('no name found');
}

describe('demoHash', () => {
  it('is a stable 32-bit FNV-1a', () => {
    expect(demoHash('')).toBe(0x811c9dc5);
    expect(demoHash('a')).toBe(0xe40c292c);
    expect(demoHash('foobar')).toBe(0xbf9cf968);
  });
});

describe('DEMO_REPLIES', () => {
  it('has six realistic replies including a question about pricing and a stop', () => {
    expect(DEMO_REPLIES).toHaveLength(6);
    expect(DEMO_REPLIES.some((t) => t.includes('Can you tell me more about pricing?'))).toBe(true);
    expect(DEMO_REPLIES.some((t) => t.includes('Please take me off your list.'))).toBe(true);
    for (const t of DEMO_REPLIES) expect(t).not.toContain('!');
  });
});

describe('createDemoAdapter', () => {
  it('connects instantly with a channel-specific identity', async () => {
    const clock = fixedClock('2026-11-02T10:00:00Z');
    expect((await createDemoAdapter('email', clock).connect({})).identity).toBe('you@yourcompany.com');
    expect((await createDemoAdapter('linkedin', clock).connect({})).identity).toBe('You on LinkedIn');
    expect((await createDemoAdapter('x', clock).connect({})).identity).toBe('@you');
  });

  it('replies once, only after replyAfterMs, for hash % 3 === 0', async () => {
    const clock = fixedClock('2026-11-02T10:00:00Z');
    const adapter = createDemoAdapter('email', clock);
    const name = nameWhere((h) => h % 3 === 0);
    const sent = await adapter.send({ to: recipient(name), kind: 'hello', subject: 'Hello', body: 'Hi', inReplyTo: null });
    expect(sent.ok).toBe(true);
    expect(await adapter.poll(null)).toEqual([]);
    clock.advance(89_999);
    expect(await adapter.poll(null)).toEqual([]);
    clock.advance(1);
    const events = await adapter.poll(null);
    expect(events).toEqual([
      {
        type: 'reply',
        from: { email: recipient(name).email, name },
        text: DEMO_REPLIES[demoHash(name) % DEMO_REPLIES.length],
        at: '2026-11-02T10:01:30.000Z',
        externalId: null,
      },
    ]);
    clock.advance(10 * 60_000);
    expect(await adapter.poll(null)).toEqual([]);
  });

  it('never replies for hash % 3 !== 0', async () => {
    const clock = fixedClock('2026-11-02T10:00:00Z');
    const adapter = createDemoAdapter('email', clock, { replyAfterMs: 1000 });
    const name = nameWhere((h) => h % 3 !== 0);
    await adapter.send({ to: recipient(name), kind: 'hello', subject: 'Hello', body: 'Hi', inReplyTo: null });
    clock.advance(3_600_000);
    expect(await adapter.poll(null)).toEqual([]);
  });

  it('counts the reply delay from the first send', async () => {
    const clock = fixedClock('2026-11-02T10:00:00Z');
    const adapter = createDemoAdapter('email', clock, { replyAfterMs: 1000 });
    const name = nameWhere((h) => h % 3 === 0);
    const msg = { to: recipient(name), kind: 'hello' as const, subject: 'Hello', body: 'Hi', inReplyTo: null };
    await adapter.send(msg);
    clock.advance(900);
    await adapter.send({ ...msg, kind: 'follow_up' });
    clock.advance(100);
    expect(await adapter.poll(null)).toHaveLength(1);
  });

  it('addresses a linkedin reply by profile and an x reply by handle', async () => {
    const clock = fixedClock('2026-11-02T10:00:00Z');
    const name = nameWhere((h) => h % 3 === 0);
    const li = createDemoAdapter('linkedin', clock, { replyAfterMs: 0 });
    await li.send({ to: { name, email: null, linkedinUrl: 'https://www.linkedin.com/in/x', xHandle: null }, kind: 'thanks', subject: null, body: 'Hi', inReplyTo: null });
    const [liEvent] = await li.poll(null);
    expect(liEvent).toMatchObject({ type: 'reply', from: { linkedinUrl: 'https://www.linkedin.com/in/x', name } });
    const x = createDemoAdapter('x', clock, { replyAfterMs: 0 });
    await x.send({ to: { name, email: null, linkedinUrl: null, xHandle: 'someone' }, kind: 'hello', subject: null, body: 'Hi', inReplyTo: null });
    const [xEvent] = await x.poll(null);
    expect(xEvent).toMatchObject({ type: 'reply', from: { xHandle: 'someone', name } });
  });

  it('reports an accepted invite once on linkedin for even hashes after acceptAfterMs', async () => {
    const clock = fixedClock('2026-11-02T10:00:00Z');
    const adapter = createDemoAdapter('linkedin', clock, { replyAfterMs: 10 * 3_600_000 });
    const even = nameWhere((h) => h % 2 === 0 && h % 3 !== 0);
    const odd = nameWhere((h) => h % 2 === 1);
    const to = (name: string): Recipient => ({ name, email: null, linkedinUrl: `https://www.linkedin.com/in/${demoHash(name)}`, xHandle: null });
    await adapter.send({ to: to(even), kind: 'invite', subject: null, body: 'Hi', inReplyTo: null });
    await adapter.send({ to: to(odd), kind: 'invite', subject: null, body: 'Hi', inReplyTo: null });
    clock.advance(59_999);
    expect(await adapter.poll(null)).toEqual([]);
    clock.advance(1);
    expect(await adapter.poll(null)).toEqual([{ type: 'accepted', linkedinUrl: to(even).linkedinUrl, at: '2026-11-02T10:01:00.000Z' }]);
    clock.advance(3_600_000);
    expect(await adapter.poll(null)).toEqual([]);
  });

  it('does not report accepted for non-invites or on other channels', async () => {
    const clock = fixedClock('2026-11-02T10:00:00Z');
    const even = nameWhere((h) => h % 2 === 0 && h % 3 !== 0);
    const li = createDemoAdapter('linkedin', clock, { acceptAfterMs: 0 });
    await li.send({ to: { name: even, email: null, linkedinUrl: 'https://www.linkedin.com/in/a', xHandle: null }, kind: 'hello', subject: null, body: 'Hi', inReplyTo: null });
    expect(await li.poll(null)).toEqual([]);
    const em = createDemoAdapter('email', clock, { acceptAfterMs: 0 });
    await em.send({ to: recipient(even), kind: 'invite', subject: null, body: 'Hi', inReplyTo: null });
    expect(await em.poll(null)).toEqual([]);
  });

  it('knows no addresses and closes cleanly', async () => {
    const adapter = createDemoAdapter('email', fixedClock('2026-11-02T10:00:00Z'));
    expect(adapter.channel).toBe('email');
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe('demo linkedin search', () => {
  it('finds the same few people with LinkedIn addresses, and only on linkedin', async () => {
    const clock = fixedClock('2026-11-02T09:00:00Z');
    const li = createDemoAdapter('linkedin', clock);
    const found = await li.searchPeople?.('https://www.linkedin.com/search/results/people/?keywords=fintech', 4);
    expect(found).toHaveLength(4);
    expect(found?.[0]).toMatchObject({ name: 'Amara Nwosu', source: 'linkedin_search', linkedinUrl: 'https://www.linkedin.com/in/amara-nwosu' });
    expect(await li.searchPeople?.('https://www.linkedin.com/search/results/people/', 100)).toHaveLength(6);
    expect(createDemoAdapter('email', clock).searchPeople).toBeUndefined();
  });
});
