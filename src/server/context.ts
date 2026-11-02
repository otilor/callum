import { createWriter, type Writer } from './ai/writer.js';
import { Bus } from './bus.js';
import { AdapterRegistry, defaultFactory } from './channels/registry.js';
import type { AdapterFactory } from './channels/types.js';
import type { Db } from './db/db.js';
import { Repo } from './db/repo.js';
import { systemClock, type Clock } from './engine/clock.js';
import { ApolloSource } from './leads/apollo.js';
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
  /** Set when APOLLO_API_KEY is, or when a key was stored in Your Callum. */
  apollo: ApolloSource | null;
  demo: boolean;
  dataDir: string;
  /** Where a problem that does not fail the user's request is reported (work that was saved, but a follow-on step failed). */
  onError: (err: unknown) => void;
  /** Where the Claude key comes from: the environment, a key saved in Your Callum, or nowhere (Callum uses its own templates). */
  claudeKey: 'env' | 'saved' | null;
  /**
   * Reads the Apollo and Claude keys again (environment first, then what is saved) and rebuilds what depends on them.
   * Called after a key is saved or removed, and after everything is deleted, so no restart is needed.
   */
  reloadKeys(): void;
}

export interface CtxOptions {
  db: Db;
  clock?: Clock;
  writer?: Writer;
  factory?: AdapterFactory;
  demo?: boolean;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Builds the writer for a Claude key (or none). Tests replace it; a `writer` given outright is never rebuilt. */
  makeWriter?: (env: { ANTHROPIC_API_KEY?: string; CALLUM_MODEL?: string }) => Writer;
  onError?: (err: unknown) => void;
}

export function createCtx(opts: CtxOptions): Ctx {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? systemClock;
  const demo = opts.demo ?? false;
  const dataDir = opts.dataDir ?? (env.CALLUM_DATA_DIR?.trim() || './data');
  const repo = new Repo(opts.db, () => clock.now().toISOString());
  const bus = new Bus();
  const makeWriter = opts.makeWriter ?? createWriter;
  const envClaude = env.ANTHROPIC_API_KEY?.trim();
  const savedClaude = repo.getChannelSecret('anthropic')?.key?.trim();
  const apolloKey = env.APOLLO_API_KEY?.trim() || repo.getChannelSecret('apollo')?.key?.trim();
  const ctx: Ctx = {
    repo,
    clock,
    bus,
    outbox: new Outbox(repo, clock, bus),
    writer: opts.writer ?? makeWriter({ ...env, ANTHROPIC_API_KEY: envClaude || savedClaude || '' }),
    // The registry hands each adapter a hook that stores a rotated secret (a Microsoft refresh token) in channel_secrets.
    adapters: new AdapterRegistry(repo, opts.factory ?? defaultFactory({ demo, clock, dataDir }), bus),
    apollo: apolloKey ? new ApolloSource(apolloKey) : null,
    demo,
    dataDir,
    onError: opts.onError ?? ((err) => console.error(`[callum] ${err instanceof Error ? err.message : String(err)}`)),
    claudeKey: envClaude ? 'env' : savedClaude ? 'saved' : null,
    reloadKeys() {
      const saved = repo.getChannelSecret('anthropic')?.key?.trim();
      ctx.claudeKey = envClaude ? 'env' : saved ? 'saved' : null;
      if (opts.writer === undefined) ctx.writer = makeWriter({ ...env, ANTHROPIC_API_KEY: envClaude || saved || '' });
      const apollo = env.APOLLO_API_KEY?.trim() || repo.getChannelSecret('apollo')?.key?.trim();
      ctx.apollo = apollo ? new ApolloSource(apollo) : null;
    },
  };
  // A message claimed by a run that never finished may have gone out: it is failed for the user to look at, never sent again.
  recoverSending(ctx);
  return ctx;
}
