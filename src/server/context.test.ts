import { describe, expect, it } from 'vitest';
import { TemplateWriter } from './ai/templates.js';
import type { AdapterHooks, ChannelAdapter } from './channels/types.js';
import { createCtx } from './context.js';
import { openDb } from './db/db.js';
import { fixedClock } from './engine/clock.js';
import { ApolloSource } from './leads/apollo.js';

describe('createCtx', () => {
  it('wires everything to one clock and one bus', () => {
    const clock = fixedClock('2026-11-03T08:30:00Z');
    const ctx = createCtx({ db: openDb(':memory:'), clock, env: {} });
    expect(ctx.clock).toBe(clock);
    expect(ctx.demo).toBe(false);
    expect(ctx.dataDir).toBe('./data');
    expect(ctx.apollo).toBeNull();
    const project = ctx.repo.insertProject({ name: 'One' });
    expect(project.createdAt).toBe('2026-11-03T08:30:00.000Z');
    const seen: string[] = [];
    ctx.bus.on((s) => seen.push(s));
    const person = ctx.repo.insertPerson({ projectId: project.id, name: 'Kemi Eze', source: 'csv', email: 'k@x.com', channel: 'email' });
    ctx.outbox.queueAuto(person.id, 'hello', 'Hi', 'S', clock.now(), false);
    expect(seen).toEqual(['outbox']);
  });

  it('takes the data folder from the environment, unless told otherwise', () => {
    expect(createCtx({ db: openDb(':memory:'), env: { CALLUM_DATA_DIR: '/var/callum' } }).dataDir).toBe('/var/callum');
    expect(createCtx({ db: openDb(':memory:'), env: { CALLUM_DATA_DIR: '/var/callum' }, dataDir: '/tmp/x' }).dataDir).toBe('/tmp/x');
    expect(createCtx({ db: openDb(':memory:'), env: { CALLUM_DATA_DIR: '  ' } }).dataDir).toBe('./data');
  });

  it('has Apollo only when there is a key', () => {
    expect(createCtx({ db: openDb(':memory:'), env: { APOLLO_API_KEY: 'k' } }).apollo).toBeInstanceOf(ApolloSource);
    expect(createCtx({ db: openDb(':memory:'), env: { APOLLO_API_KEY: '  ' } }).apollo).toBeNull();
  });

  it('uses the writer it is given, and the template writer without a key', () => {
    const writer = new TemplateWriter();
    expect(createCtx({ db: openDb(':memory:'), writer, env: {} }).writer).toBe(writer);
    expect(createCtx({ db: openDb(':memory:'), env: {} }).writer).toBeInstanceOf(TemplateWriter);
  });

  it('stores a secret the adapter rotates, such as a Microsoft refresh token', async () => {
    let hooks: AdapterHooks | undefined;
    const adapter: ChannelAdapter = {
      channel: 'email',
      connect: async () => ({ identity: 'ada@example.com', secret: { refreshToken: 'one' } }),
      send: async () => ({ ok: true, externalId: null }),
      poll: async () => [],
      close: async () => undefined,
    };
    const ctx = createCtx({
      db: openDb(':memory:'), env: {},
      factory: (_ch, _secret, h) => {
        hooks = h;
        return adapter;
      },
    });
    await ctx.adapters.connect('email', {}, ctx.clock.now());
    expect(ctx.repo.getChannelSecret('email')).toEqual({ refreshToken: 'one' });
    hooks?.saveSecret({ refreshToken: 'two' });
    expect(ctx.repo.getChannelSecret('email')).toEqual({ refreshToken: 'two' });
  });

  it('makes demo adapters in demo mode', async () => {
    const ctx = createCtx({ db: openDb(':memory:'), demo: true, env: {} });
    const account = await ctx.adapters.connect('email', {}, ctx.clock.now());
    expect(account).toMatchObject({ status: 'connected', identity: 'you@yourcompany.com' });
    expect(ctx.demo).toBe(true);
  });
});
