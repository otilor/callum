import type { Channel, ChannelAccount } from '../../shared/types.js';
import type { Bus } from '../bus.js';
import type { Repo } from '../db/repo.js';
import type { Clock } from '../engine/clock.js';
import { createDemoAdapter } from './demo.js';
import { createEmailAdapter } from './email.js';
import { createLinkedinAdapter } from './linkedin.js';
import type { AdapterFactory, AdapterHooks, ChannelAdapter } from './types.js';
import { createXAdapter } from './x.js';

/** The notice that goes with a channel the account signed out of; connecting again settles it. */
const SIGNED_OUT_KIND = { email: 'mailbox_signed_out', linkedin: 'linkedin_signed_out', x: 'x_signed_out' } as const;

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
  // Channels with a connect in progress: nothing may use (or rebuild) their adapter until it finishes.
  private readonly connecting = new Map<Channel, number>();

  constructor(
    private readonly repo: Repo,
    private readonly factory: AdapterFactory,
    private readonly bus: Bus,
  ) {}

  // Bumped whenever a channel's adapter is replaced or the channel is disconnected, so that a
  // late save from an adapter that no longer owns the secret (an in-flight token refresh) is dropped.
  private readonly generation = new Map<Channel, number>();

  private endConnecting(ch: Channel): void {
    const left = (this.connecting.get(ch) ?? 1) - 1;
    if (left > 0) this.connecting.set(ch, left);
    else this.connecting.delete(ch);
  }

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
    if ((this.connecting.get(ch) ?? 0) > 0) return null;
    const cached = this.adapters.get(ch);
    if (cached) return cached;
    const status = this.repo.getChannel(ch).status;
    if (status !== 'connected' && status !== 'paused') return null;
    const adapter = this.factory(ch, this.repo.getChannelSecret(ch), this.hooks(ch, this.generationOf(ch)));
    this.adapters.set(ch, adapter);
    return adapter;
  }

  async connect(ch: Channel, input: Record<string, string>, now: Date): Promise<ChannelAccount> {
    // Take the old adapter out of use and close it first: two browsers must never open one LinkedIn profile
    // folder, and while someone signs in nothing may send through the old one. If connecting fails it comes back;
    // every adapter reopens what it needs on its next use.
    const previous = this.adapters.get(ch);
    this.adapters.delete(ch);
    this.connecting.set(ch, (this.connecting.get(ch) ?? 0) + 1);
    await previous?.close().catch(() => undefined);
    const next = this.generationOf(ch) + 1;
    let adapter: ChannelAdapter | null = null;
    let connected: { identity: string; secret: Record<string, string> };
    try {
      adapter = this.factory(ch, null, this.hooks(ch, next));
      connected = await adapter.connect(input);
    } catch (err) {
      await adapter?.close().catch(() => undefined);
      if (previous) this.adapters.set(ch, previous);
      this.endConnecting(ch);
      throw err;
    }
    this.generation.set(ch, next);
    this.adapters.set(ch, adapter);
    this.endConnecting(ch);

    this.repo.setChannelSecret(ch, connected.secret);
    const before = this.repo.getChannel(ch);
    // The pace ramp belongs to the mailbox, not to Callum: signing in again as the same one carries on, but a different
    // address is a new sender with no history and starts at the bottom. (An account from before Callum kept the address
    // has none on file, and is given the benefit of the doubt.)
    const sameSender = before.connectedAt !== null
      && (before.rampIdentity == null || before.rampIdentity.trim().toLowerCase() === connected.identity.trim().toLowerCase());
    const account = this.repo.updateChannel(ch, {
      status: 'connected',
      identity: connected.identity,
      connectedAt: sameSender ? before.connectedAt : now.toISOString(),
      rampIdentity: connected.identity,
    });
    let resolvedIncident = false;
    const signedOut = SIGNED_OUT_KIND[ch];
    for (const incident of this.repo.listIncidents({ open: true })) {
      if (incident.channel === ch && incident.kind === signedOut) {
        this.repo.updateIncident(incident.id, { state: 'resolved', resolvedAt: now.toISOString() });
        resolvedIncident = true;
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
    // connectedAt and rampIdentity stay, so connecting the same mailbox again later continues its ramp.
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
