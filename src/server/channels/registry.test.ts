import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Bus } from '../bus.js';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { fixedClock } from '../engine/clock.js';
import type { Scope } from '../../shared/types.js';
import { AdapterRegistry, defaultFactory } from './registry.js';
import { ConnectError, type AdapterFactory, type ChannelAdapter } from './types.js';

let repo: Repo;
let bus: Bus;
let scopes: Scope[];
const clock = fixedClock('2026-11-02T10:00:00Z');

beforeEach(() => {
  repo = new Repo(openDb(':memory:'), () => clock.now().toISOString());
  bus = new Bus();
  scopes = [];
  bus.on((s) => scopes.push(s));
});

function stubAdapter(channel: ChannelAdapter['channel'], over: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    channel,
    connect: async (input) => ({ identity: input.address ?? 'who', secret: { address: input.address ?? 'who' } }),
    send: async () => ({ ok: true, externalId: null }),
    poll: async () => [],
    close: vi.fn(async () => undefined),
    ...over,
  };
}

describe('AdapterRegistry', () => {
  it('connect stores the secret, marks the channel connected and tells the bus', async () => {
    const registry = new AdapterRegistry(repo, (ch) => stubAdapter(ch), bus);
    const account = await registry.connect('email', { address: 'you@x.com' }, new Date('2026-11-02T10:00:00Z'));
    expect(account).toMatchObject({ channel: 'email', status: 'connected', identity: 'you@x.com', connectedAt: '2026-11-02T10:00:00.000Z' });
    expect(repo.getChannelSecret('email')).toEqual({ address: 'you@x.com' });
    expect(repo.listChannels().find((c) => c.channel === 'email')).toMatchObject({ status: 'connected', identity: 'you@x.com' });
    expect(scopes).toContain('channels');
    expect(registry.get('email')).not.toBeNull();
  });

  it('works with the demo factory and keeps nothing for other channels', async () => {
    const registry = new AdapterRegistry(repo, defaultFactory({ demo: true, clock, dataDir: '/tmp/unused' }), bus);
    expect(registry.get('linkedin')).toBeNull();
    const account = await registry.connect('linkedin', {}, clock.now());
    expect(account).toMatchObject({ status: 'connected', identity: 'You on LinkedIn' });
    expect(registry.get('linkedin')?.channel).toBe('linkedin');
    expect(registry.get('x')).toBeNull();
  });

  it('reconnecting keeps the original connectedAt', async () => {
    const registry = new AdapterRegistry(repo, (ch) => stubAdapter(ch), bus);
    await registry.connect('email', { address: 'a@x.com' }, new Date('2026-11-02T10:00:00Z'));
    const again = await registry.connect('email', { address: 'b@x.com' }, new Date('2026-11-09T10:00:00Z'));
    expect(again.connectedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(again.identity).toBe('b@x.com');
    expect(repo.getChannelSecret('email')).toEqual({ address: 'b@x.com' });
  });

  it('resolves an open mailbox_signed_out incident for email only', async () => {
    const registry = new AdapterRegistry(repo, (ch) => stubAdapter(ch), bus);
    const mail = repo.insertIncident({ channel: 'email', kind: 'mailbox_signed_out', message: 'Your mailbox signed Callum out.' });
    const other = repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_check', message: 'LinkedIn asked for a check.' });
    scopes.length = 0;
    await registry.connect('email', { address: 'you@x.com' }, new Date('2026-11-02T10:05:00Z'));
    expect(repo.listIncidents({ open: true }).map((i) => i.id)).toEqual([other.id]);
    const resolved = repo.listIncidents().find((i) => i.id === mail.id);
    expect(resolved).toMatchObject({ state: 'resolved', resolvedAt: '2026-11-02T10:05:00.000Z' });
    expect(scopes).toContain('incidents');
  });

  it('leaves state alone and closes the adapter when connecting fails', async () => {
    const adapter = stubAdapter('x', { connect: async () => { throw new ConnectError("Couldn't sign in to X."); } });
    const registry = new AdapterRegistry(repo, () => adapter, bus);
    await expect(registry.connect('x', { accessToken: 'bad' }, clock.now())).rejects.toThrow("Couldn't sign in to X.");
    expect(repo.getChannel('x').status).toBe('disconnected');
    expect(repo.getChannelSecret('x')).toBeNull();
    expect(adapter.close).toHaveBeenCalled();
    expect(scopes).toEqual([]);
  });

  it('get builds adapters lazily from stored secrets for connected or paused channels only', () => {
    const built: Array<[string, Record<string, string> | null]> = [];
    const factory: AdapterFactory = (ch, secret) => {
      built.push([ch, secret]);
      return stubAdapter(ch);
    };
    repo.setChannelSecret('email', { address: 'you@x.com' });
    repo.updateChannel('email', { status: 'connected', identity: 'you@x.com' });
    repo.setChannelSecret('x', { accessToken: 't' });
    repo.updateChannel('x', { status: 'paused' });
    repo.setChannelSecret('linkedin', { liAt: 'c' });
    repo.updateChannel('linkedin', { status: 'error' });
    const registry = new AdapterRegistry(repo, factory, bus);
    const email = registry.get('email');
    expect(email).not.toBeNull();
    expect(registry.get('email')).toBe(email);
    expect(registry.get('x')).not.toBeNull();
    expect(registry.get('linkedin')).toBeNull();
    expect(built).toEqual([['email', { address: 'you@x.com' }], ['x', { accessToken: 't' }]]);
  });

  it('lets an adapter save a rotated secret through the hook', () => {
    let saveSecret: ((s: Record<string, string>) => void) | undefined;
    repo.setChannelSecret('x', { accessToken: 'old' });
    repo.updateChannel('x', { status: 'connected' });
    new AdapterRegistry(repo, (ch, _secret, hooks) => {
      saveSecret = hooks?.saveSecret;
      return stubAdapter(ch);
    }, bus).get('x');
    saveSecret?.({ accessToken: 'new' });
    expect(repo.getChannelSecret('x')).toEqual({ accessToken: 'new' });
  });

  it('disconnect forgets the secret and the local session, closes the adapter and keeps the ramp start', async () => {
    const forget = vi.fn(async () => undefined);
    const adapter = stubAdapter('linkedin', { forget });
    const registry = new AdapterRegistry(repo, () => adapter, bus);
    await registry.connect('linkedin', { address: 'x' }, new Date('2026-11-02T10:00:00Z'));
    scopes.length = 0;
    const account = await registry.disconnect('linkedin');
    expect(account).toMatchObject({ status: 'disconnected', identity: null, connectedAt: '2026-11-02T10:00:00.000Z' });
    expect(repo.getChannelSecret('linkedin')).toBeNull();
    expect(forget).toHaveBeenCalled();
    expect(adapter.close).toHaveBeenCalled();
    expect(registry.get('linkedin')).toBeNull();
    expect(scopes).toContain('channels');
  });

  it('closes the cached adapter before building the one that replaces it, so two browsers never share a profile', async () => {
    const order: string[] = [];
    let n = 0;
    const factory: AdapterFactory = (ch) => {
      const id = ++n;
      order.push(`build ${id}`);
      return stubAdapter(ch, { close: vi.fn(async () => { order.push(`close ${id}`); }) });
    };
    const registry = new AdapterRegistry(repo, factory, bus);
    await registry.connect('linkedin', { address: 'a' }, clock.now());
    await registry.connect('linkedin', { address: 'b' }, clock.now());
    expect(order).toEqual(['build 1', 'close 1', 'build 2']);
  });

  it('ignores a late secret save from an adapter that was replaced or disconnected', async () => {
    const saves: Array<(s: Record<string, string>) => void> = [];
    const registry = new AdapterRegistry(repo, (ch, _secret, hooks) => {
      saves.push(hooks?.saveSecret ?? (() => undefined));
      return stubAdapter(ch);
    }, bus);
    await registry.connect('x', { address: 'first' }, clock.now());
    await registry.connect('x', { address: 'second' }, clock.now());
    saves[0]?.({ stale: 'from the replaced adapter' });
    expect(repo.getChannelSecret('x')).toEqual({ address: 'second' });
    saves[1]?.({ address: 'second', accessToken: 'rotated' });
    expect(repo.getChannelSecret('x')).toEqual({ address: 'second', accessToken: 'rotated' });
    await registry.disconnect('x');
    saves[1]?.({ stale: 'in-flight refresh finishing after disconnect' });
    expect(repo.getChannelSecret('x')).toBeNull();
  });

  it('keeps the working adapter and its saves when a new connect fails', async () => {
    let saveSecret: ((s: Record<string, string>) => void) | undefined;
    let built = 0;
    const registry = new AdapterRegistry(repo, (ch, _secret, hooks) => {
      built++;
      if (built === 1) {
        saveSecret = hooks?.saveSecret;
        return stubAdapter(ch);
      }
      return stubAdapter(ch, { connect: async () => { throw new ConnectError('nope'); } });
    }, bus);
    await registry.connect('x', { address: 'first' }, clock.now());
    await expect(registry.connect('x', { address: 'second' }, clock.now())).rejects.toThrow('nope');
    saveSecret?.({ address: 'first', accessToken: 'rotated' });
    expect(repo.getChannelSecret('x')).toEqual({ address: 'first', accessToken: 'rotated' });
  });

  it('takes the old adapter out of use while connecting, and puts it back if connecting fails', async () => {
    let built = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const old = stubAdapter('linkedin');
    const registry = new AdapterRegistry(repo, (ch) => {
      built++;
      return built === 1 ? old : stubAdapter(ch, { connect: async () => { await gate; throw new ConnectError('Sign-in did not finish.'); } });
    }, bus);
    await registry.connect('linkedin', {}, clock.now());
    expect(registry.get('linkedin')).toBe(old);

    const connecting = registry.connect('linkedin', {}, clock.now());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Sends wait: nothing is returned (and nothing rebuilt from the stored secret) while someone signs in.
    expect(registry.get('linkedin')).toBeNull();
    expect(built).toBe(2);
    release();
    await expect(connecting).rejects.toThrow('Sign-in did not finish.');
    expect(registry.get('linkedin')).toBe(old);
    expect(built).toBe(2);
  });

  it('keeps the channel unavailable until every overlapping connect has finished', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const registry = new AdapterRegistry(repo, (ch) => stubAdapter(ch, { connect: async () => { await gate; return { identity: 'who', secret: {} }; } }), bus);
    const first = registry.connect('linkedin', {}, clock.now());
    const second = registry.connect('linkedin', {}, clock.now());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.get('linkedin')).toBeNull();
    release();
    await Promise.all([first, second]);
    expect(registry.get('linkedin')).not.toBeNull();
  });

  it('closeAll closes every built adapter once', async () => {
    const adapters = new Map<string, ChannelAdapter>();
    const registry = new AdapterRegistry(repo, (ch) => {
      const a = stubAdapter(ch);
      adapters.set(ch, a);
      return a;
    }, bus);
    await registry.connect('email', { address: 'a@x.com' }, clock.now());
    await registry.connect('x', { address: 'x' }, clock.now());
    await registry.closeAll();
    for (const a of adapters.values()) expect(a.close).toHaveBeenCalledTimes(1);
    expect(registry.get('email')).not.toBeNull(); // rebuilt from the stored secret on demand
  });
});

describe('defaultFactory', () => {
  it('builds real adapters in real mode and demo adapters in demo mode', async () => {
    const real = defaultFactory({ demo: false, clock, dataDir: '/tmp/callum-test' });
    expect(real('email', null).channel).toBe('email');
    expect(real('x', null).channel).toBe('x');
    const linkedin = real('linkedin', null);
    expect(linkedin.channel).toBe('linkedin');
    await linkedin.close();
    const demo = defaultFactory({ demo: true, clock, dataDir: '/tmp/callum-test' })('x', null);
    expect((await demo.connect({})).identity).toBe('@you');
  });
});
