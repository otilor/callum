import type { Channel, ChannelAccount } from '../../shared/types.js';
import type { Bus } from '../bus.js';
import type { Repo } from '../db/repo.js';
import type { Clock } from '../engine/clock.js';
import { createDemoAdapter } from './demo.js';
import { createEmailAdapter } from './email.js';
import { createLinkedinAdapter } from './linkedin.js';
import type { AdapterFactory, AdapterHooks, ChannelAdapter } from './types.js';
import { createXAdapter } from './x.js';

export function defaultFactory(opts: { demo: boolean; clock: Clock; dataDir: string }): AdapterFactory {
  return (channel, secret, hooks) => {
    if (opts.demo) return createDemoAdapter(channel, opts.clock);
    switch (channel) {
      case 'email':
        return createEmailAdapter(secret, { clock: opts.clock, ...(hooks ? { onSecretChange: hooks.saveSecret } : {}) });
      case 'x':
        return createXAdapter(secret, { clock: opts.clock, ...(hooks ? { onSecretChange: hooks.saveSecret } : {}) });
      case 'linkedin':
        return createLinkedinAdapter(secret, { dataDir: opts.dataDir, clock: opts.clock });
    }
  };
}

/** Owns one adapter per channel and keeps the channel's stored state in step with it. */
export class AdapterRegistry {
  private readonly adapters = new Map<Channel, ChannelAdapter>();

  constructor(
    private readonly repo: Repo,
    private readonly factory: AdapterFactory,
    private readonly bus: Bus,
  ) {}

  // Bumped whenever a channel's adapter is replaced or the channel is disconnected, so that a
  // late save from an adapter that no longer owns the secret (an in-flight token refresh) is dropped.
  private readonly generation = new Map<Channel, number>();

  private generationOf(ch: Channel): number {
    return this.generation.get(ch) ?? 0;
  }

  private hooks(ch: Channel, generation: number): AdapterHooks {
    return {
      saveSecret: (secret) => {
        if (this.generationOf(ch) === generation) this.repo.setChannelSecret(ch, secret);
      },
    };
  }

  /** The adapter for a connected or paused channel, built from its stored secret on first use. */
  get(ch: Channel): ChannelAdapter | null {
    const cached = this.adapters.get(ch);
    if (cached) return cached;
    const status = this.repo.getChannel(ch).status;
    if (status !== 'connected' && status !== 'paused') return null;
    const adapter = this.factory(ch, this.repo.getChannelSecret(ch), this.hooks(ch, this.generationOf(ch)));
    this.adapters.set(ch, adapter);
    return adapter;
  }

  async connect(ch: Channel, input: Record<string, string>, now: Date): Promise<ChannelAccount> {
    // Close the old adapter first: two browsers must never open one LinkedIn profile folder. If connecting
    // fails it stays cached; every adapter reopens what it needs on its next use.
    const previous = this.adapters.get(ch);
    await previous?.close().catch(() => undefined);
    const next = this.generationOf(ch) + 1;
    const adapter = this.factory(ch, null, this.hooks(ch, next));
    let connected: { identity: string; secret: Record<string, string> };
    try {
      connected = await adapter.connect(input);
    } catch (err) {
      await adapter.close().catch(() => undefined);
      throw err;
    }
    this.generation.set(ch, next);
    this.adapters.set(ch, adapter);

    this.repo.setChannelSecret(ch, connected.secret);
    const account = this.repo.updateChannel(ch, {
      status: 'connected',
      identity: connected.identity,
      // The first connection starts the pace ramp; reconnecting must not restart it.
      connectedAt: this.repo.getChannel(ch).connectedAt ?? now.toISOString(),
    });
    let resolvedIncident = false;
    if (ch === 'email') {
      for (const incident of this.repo.listIncidents({ open: true })) {
        if (incident.channel === 'email' && incident.kind === 'mailbox_signed_out') {
          this.repo.updateIncident(incident.id, { state: 'resolved', resolvedAt: now.toISOString() });
          resolvedIncident = true;
        }
      }
    }
    this.bus.emit('channels');
    if (resolvedIncident) this.bus.emit('incidents');
    return account;
  }

  async disconnect(ch: Channel): Promise<ChannelAccount> {
    // Build one even for a channel in an error state, so a saved browser session is still cleared.
    const adapter = this.adapters.get(ch) ?? this.factory(ch, this.repo.getChannelSecret(ch), this.hooks(ch, this.generationOf(ch)));
    this.generation.set(ch, this.generationOf(ch) + 1);
    this.adapters.delete(ch);
    await adapter.forget?.().catch(() => undefined);
    await adapter.close().catch(() => undefined);
    this.repo.setChannelSecret(ch, null);
    // connectedAt stays so that connecting again later continues the same ramp.
    const account = this.repo.updateChannel(ch, { status: 'disconnected', identity: null });
    this.bus.emit('channels');
    return account;
  }

  async closeAll(): Promise<void> {
    const open = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.all(open.map((a) => a.close().catch(() => undefined)));
  }
}
