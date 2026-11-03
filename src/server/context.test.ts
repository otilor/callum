import { describe, expect, it } from 'vitest';
import { TemplateWriter } from './ai/templates.js';
import type { AdapterHooks, ChannelAdapter } from './channels/types.js';
import { createCtx } from './context.js';
import { openDb } from './db/db.js';
import { fixedClock } from './engine/clock.js';
import { ApiModel, ClaudeCodeModel } from './ai/model.js';
import { ClaudeWriter } from './ai/claude.js';
import { DemoFinder } from './demo/finder.js';
import { ModelFinder } from './leads/finder.js';

describe('createCtx', () => {
  it('wires everything to one clock and one bus', () => {
    const clock = fixedClock('2026-11-03T08:30:00Z');
    const ctx = createCtx({ db: openDb(':memory:'), clock, env: {} });
    expect(ctx.clock).toBe(clock);
    expect(ctx.demo).toBe(false);
    expect(ctx.dataDir).toBe('./data');
    expect(ctx.model).toBeNull();
    expect(ctx.finder).toBeNull();
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

  it('runs Claude through the key when there is one, else through Claude Code when Callum found it, else not at all', () => {
    const keyed = createCtx({ db: openDb(':memory:'), env: { ANTHROPIC_API_KEY: 'sk-ant-k' }, claudeCodePath: '/usr/local/bin/claude' });
    expect(keyed.model).toBeInstanceOf(ApiModel);
    expect(keyed.finder).toBeInstanceOf(ModelFinder);
    expect(keyed.writer).toBeInstanceOf(ClaudeWriter);
    const plan = createCtx({ db: openDb(':memory:'), env: {}, claudeCodePath: '/usr/local/bin/claude' });
    expect(plan.model).toBeInstanceOf(ClaudeCodeModel);
    expect((plan.model as ClaudeCodeModel).path).toBe('/usr/local/bin/claude');
    expect(plan.finder).toBeInstanceOf(ModelFinder);
    expect(plan.writer).toBeInstanceOf(ClaudeWriter);
    const none = createCtx({ db: openDb(':memory:'), env: { ANTHROPIC_API_KEY: '  ' } });
    expect(none.model).toBeNull();
    expect(none.finder).toBeNull();
    expect(none.writer).toBeInstanceOf(TemplateWriter);
  });

  it('switches between the key and Claude Code as a key is saved and removed', () => {
    const ctx = createCtx({ db: openDb(':memory:'), env: {}, claudeCodePath: '/usr/local/bin/claude' });
    ctx.repo.setChannelSecret('anthropic', { key: 'sk-ant-saved' });
    ctx.reloadKeys();
    expect(ctx.model?.engine).toBe('api');
    expect(ctx.claudeKey).toBe('saved');
    ctx.repo.setChannelSecret('anthropic', null);
    ctx.reloadKeys();
    expect(ctx.model?.engine).toBe('claude_code');
    expect(ctx.claudeKey).toBeNull();
  });

  it('looks for Claude Code again only when it was told how', () => {
    const quiet = createCtx({ db: openDb(':memory:'), env: {} });
    quiet.findClaudeCodeAgain();
    expect(quiet.model).toBeNull();
    let where: string | null = null;
    const ctx = createCtx({ db: openDb(':memory:'), env: {}, findClaudeCode: () => where });
    const seen: string[] = [];
    ctx.bus.on((s) => seen.push(s));
    ctx.findClaudeCodeAgain();
    expect(ctx.model).toBeNull();
    expect(seen).toEqual([]);
    where = '/opt/homebrew/bin/claude';
    ctx.findClaudeCodeAgain();
    expect(ctx.model?.engine).toBe('claude_code');
    expect(ctx.finder).toBeInstanceOf(ModelFinder);
    expect(seen).toEqual(['settings']);
  });

  it('finds made-up people in the demo, never with Claude', () => {
    const ctx = createCtx({ db: openDb(':memory:'), env: {}, demo: true });
    expect(ctx.finder).toBeInstanceOf(DemoFinder);
    expect(ctx.model).toBeNull();
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
