// Shared setup for the LinkedIn integration tests: the local LinkedIn stand-in, a signed-in adapter, and a builder
// for more adapters. Each test file that calls `useLinkedin()` gets its own fixture server and temp folders.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';
import { fixedClock } from '../../../engine/clock.js';
import { createLinkedinAdapter } from '../../linkedin.js';
import type { ChannelAdapter, OutboundMessage } from '../../types.js';
import { VALID_COOKIE, startLinkedinFixture, type LinkedinFixture } from './server.js';

// Monday 2 November 2026, 15:00 in the process time zone (the messaging list shows local clock times).
export const NOW = new Date(2026, 10, 2, 15, 0, 0);
const noSleep = async () => undefined;

export function message(slug: string | null, over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    to: { name: 'Someone', email: null, linkedinUrl: slug ? `https://www.linkedin.com/in/${slug}` : null, xHandle: null },
    kind: 'invite',
    subject: null,
    body: 'Hi, I enjoyed your talk on payments.',
    inReplyTo: null,
    ...over,
  };
}

export interface LinkedinHarness {
  readonly fixture: LinkedinFixture;
  /** An adapter already connected with a valid cookie. */
  readonly main: ChannelAdapter;
  build(secret: Record<string, string> | null, extra?: Record<string, unknown>): Promise<ChannelAdapter>;
  dataDir(): Promise<string>;
}

/** Call inside a `describe`: starts the fixture and a connected adapter before the tests and cleans up after them. */
export function useLinkedin(): LinkedinHarness {
  vi.setConfig({ testTimeout: 30_000 });
  const dirs: string[] = [];
  const adapters: ChannelAdapter[] = [];
  let fixture: LinkedinFixture | null = null;
  let main: ChannelAdapter | null = null;

  async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'callum-li-'));
    dirs.push(dir);
    return dir;
  }

  async function build(secret: Record<string, string> | null, extra: Record<string, unknown> = {}): Promise<ChannelAdapter> {
    const adapter = createLinkedinAdapter(secret, {
      dataDir: await dataDir(),
      baseUrl: (fixture as LinkedinFixture).baseUrl,
      sleep: noSleep,
      clock: fixedClock(NOW.toISOString()),
      settleMs: 800,
      actionTimeoutMs: 8000,
      ...extra,
    });
    adapters.push(adapter);
    return adapter;
  }

  beforeAll(async () => {
    fixture = await startLinkedinFixture();
    main = await build(null);
    await main.connect({ liAt: VALID_COOKIE });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(adapters.map((a) => a.close()));
    await fixture?.close();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  return {
    get fixture() {
      return fixture as LinkedinFixture;
    },
    get main() {
      return main as ChannelAdapter;
    },
    build,
    dataDir,
  };
}
