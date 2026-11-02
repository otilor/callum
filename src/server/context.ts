import { createWriter, type Writer } from './ai/writer.js';
import { Bus } from './bus.js';
import { AdapterRegistry, defaultFactory } from './channels/registry.js';
import type { AdapterFactory } from './channels/types.js';
import type { Db } from './db/db.js';
import { Repo } from './db/repo.js';
import { systemClock, type Clock } from './engine/clock.js';
import { ApolloSource } from './leads/apollo.js';
import { Outbox } from './outbox/outbox.js';

/** Everything the server's parts share. Built once at start-up. */
export interface Ctx {
  repo: Repo;
  clock: Clock;
  bus: Bus;
  outbox: Outbox;
  writer: Writer;
  adapters: AdapterRegistry;
  /** Set when APOLLO_API_KEY is. */
  apollo: ApolloSource | null;
  demo: boolean;
  dataDir: string;
  /** Where a problem that does not fail the user's request is reported (work that was saved, but a follow-on step failed). */
  onError: (err: unknown) => void;
}

export interface CtxOptions {
  db: Db;
  clock?: Clock;
  writer?: Writer;
  factory?: AdapterFactory;
  demo?: boolean;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  onError?: (err: unknown) => void;
}

export function createCtx(opts: CtxOptions): Ctx {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? systemClock;
  const demo = opts.demo ?? false;
  const dataDir = opts.dataDir ?? (env.CALLUM_DATA_DIR?.trim() || './data');
  const repo = new Repo(opts.db, () => clock.now().toISOString());
  const bus = new Bus();
  const apolloKey = env.APOLLO_API_KEY?.trim();
  return {
    repo,
    clock,
    bus,
    outbox: new Outbox(repo, clock, bus),
    writer: opts.writer ?? createWriter(env),
    // The registry hands each adapter a hook that stores a rotated secret (a Microsoft refresh token) in channel_secrets.
    adapters: new AdapterRegistry(repo, opts.factory ?? defaultFactory({ demo, clock, dataDir }), bus),
    apollo: apolloKey ? new ApolloSource(apolloKey) : null,
    demo,
    dataDir,
    onError: opts.onError ?? ((err) => console.error(`[callum] ${err instanceof Error ? err.message : String(err)}`)),
  };
}
