import { join } from 'node:path';
import { ClaudeCodeModel, ApiModel, type Model } from './ai/model.js';
import { ClaudeWriter } from './ai/claude.js';
import { TemplateWriter } from './ai/templates.js';
import { DEFAULT_MODEL, type Writer } from './ai/writer.js';
import { Bus } from './bus.js';
import { AdapterRegistry, defaultFactory } from './channels/registry.js';
import type { AdapterFactory } from './channels/types.js';
import type { Db } from './db/db.js';
import { Repo } from './db/repo.js';
import { systemClock, type Clock } from './engine/clock.js';
import { DemoFinder } from './demo/finder.js';
import { ModelFinder, type PeopleFinder } from './leads/finder.js';
import { Outbox } from './outbox/outbox.js';
import { recoverSending } from './runner/dispatch.js';

/** Everything the server's parts share. Built once at start-up. */
export interface Ctx {
  repo: Repo;
  clock: Clock;
  bus: Bus;
  outbox: Outbox;
  writer: Writer;
  adapters: AdapterRegistry;
  /**
   * Claude, where Callum runs it: the API when a key is set, else Claude Code on this computer (signed in with the
   * user's own Claude plan). Null when there is neither; Callum then writes from its own templates.
   */
  model: Model | null;
  /** Finds people from a description, with Claude's web search. Null without Claude (made-up people in the demo). */
  finder: PeopleFinder | null;
  /** The `claude` program on this computer, when Callum found one. */
  claudeCodePath: string | null;
  demo: boolean;
  dataDir: string;
  /** Where a problem that does not fail the user's request is reported (work that was saved, but a follow-on step failed). */
  onError: (err: unknown) => void;
  /** Where the Claude key comes from: the environment, a key saved in Your Callum, or nowhere. */
  claudeKey: 'env' | 'saved' | null;
  /**
   * Reads the Claude key again (environment first, then what is saved) and rebuilds what depends on it.
   * Called after a key is saved or removed, and after everything is deleted, so no restart is needed.
   */
  reloadKeys(): void;
  /** Looks for Claude Code again (it may have been installed since Callum started), and uses it when there is no key. */
  findClaudeCodeAgain(): void;
}

export interface CtxOptions {
  db: Db;
  clock?: Clock;
  writer?: Writer;
  factory?: AdapterFactory;
  demo?: boolean;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The `claude` program to run when there is no key. Left out, Callum does not use Claude Code (tests); the server
   * finds it at start-up.
   */
  claudeCodePath?: string | null;
  /** How to look for Claude Code again later. Left out, Callum never looks again (tests, the demo). */
  findClaudeCode?: () => string | null;
  /** Builds the writer for a Claude key (or none) and the model Callum chose. Tests replace it; a `writer` given outright is never rebuilt. */
  makeWriter?: (env: { ANTHROPIC_API_KEY?: string; CALLUM_MODEL?: string }, model: Model | null) => Writer;
  /** Builds the people finder for the model. Tests replace it. */
  makeFinder?: (model: Model | null) => PeopleFinder | null;
  onError?: (err: unknown) => void;
}

export function createCtx(opts: CtxOptions): Ctx {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? systemClock;
  const demo = opts.demo ?? false;
  const dataDir = opts.dataDir ?? (env.CALLUM_DATA_DIR?.trim() || './data');
  const repo = new Repo(opts.db, () => clock.now().toISOString());
  const bus = new Bus();
  const where = { claudeCode: opts.claudeCodePath ?? null };
  const envClaude = env.ANTHROPIC_API_KEY?.trim();
  const chosenModel = env.CALLUM_MODEL?.trim() || null;

  const pickModel = (key: string | undefined): Model | null => {
    if (key) return new ApiModel(key, chosenModel ?? DEFAULT_MODEL);
    if (where.claudeCode) return new ClaudeCodeModel(where.claudeCode, { model: chosenModel, cwd: join(dataDir, 'claude-code') });
    return null;
  };
  const makeWriter = opts.makeWriter ?? ((_env, model) => {
    const templates = new TemplateWriter(clock);
    return model ? new ClaudeWriter(model, chosenModel ?? DEFAULT_MODEL, templates, undefined, clock) : templates;
  });
  const makeFinder = opts.makeFinder ?? ((model: Model | null) => (demo ? new DemoFinder() : model ? new ModelFinder(model) : null));

  const build = (key: string | undefined) => {
    const model = pickModel(key);
    return {
      model,
      writer: opts.writer ?? makeWriter({ ...env, ANTHROPIC_API_KEY: key ?? '' }, model),
      finder: makeFinder(model),
    };
  };
  const savedClaude = repo.getChannelSecret('anthropic')?.key?.trim();
  const first = build(envClaude || savedClaude);
  const ctx: Ctx = {
    repo,
    clock,
    bus,
    outbox: new Outbox(repo, clock, bus),
    writer: opts.writer ?? first.writer,
    // The registry hands each adapter a hook that stores a rotated secret (a Microsoft refresh token) in channel_secrets.
    adapters: new AdapterRegistry(repo, opts.factory ?? defaultFactory({ demo, clock, dataDir }), bus),
    model: first.model,
    finder: first.finder,
    claudeCodePath: where.claudeCode,
    demo,
    dataDir,
    onError: opts.onError ?? ((err) => console.error(`[callum] ${err instanceof Error ? err.message : String(err)}`)),
    claudeKey: envClaude ? 'env' : savedClaude ? 'saved' : null,
    reloadKeys() {
      where.claudeCode = ctx.claudeCodePath;
      const saved = repo.getChannelSecret('anthropic')?.key?.trim();
      ctx.claudeKey = envClaude ? 'env' : saved ? 'saved' : null;
      const next = build(envClaude || saved);
      ctx.model = next.model;
      ctx.finder = next.finder;
      if (opts.writer === undefined) ctx.writer = next.writer;
    },
    findClaudeCodeAgain() {
      if (!opts.findClaudeCode) return;
      const path = opts.findClaudeCode();
      if (path === ctx.claudeCodePath) return;
      ctx.claudeCodePath = path;
      ctx.reloadKeys();
      ctx.bus.emit('settings');
    },
  };
  // A message claimed by a run that never finished may have gone out: it is failed for the user to look at, never sent again.
  recoverSending(ctx);
  return ctx;
}
