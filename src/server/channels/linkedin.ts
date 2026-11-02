import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { NewPerson } from '../../shared/types.js';
import { systemClock, type Clock } from '../engine/clock.js';
import {
  SELECTORS, clampNote, cleanName, hasWeeklyLimitText, headerNameCandidates, humanDelayMs, isBlockedStatus, isCheckpointUrl,
  isOwnSnippet, isSignInUrl, isUnavailableProfileText, normalizeText, parseListTimestamp, profileUrlFromHref, snippetMatches,
  splitHeadline,
} from './linkedin-detect.js';
import { ConnectError, type ChannelAdapter, type ChannelError, type InboundEvent, type OutboundMessage, type SendResult } from './types.js';

export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';
type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
type Selectors = readonly string[];

export interface LinkedinDeps {
  /** Callum's data folder; the signed-in browser profile lives in `linkedin-profile` inside it. */
  dataDir: string;
  /** Run the working browser without a window. Default true. Signing in always shows a window. */
  headless?: boolean;
  /** Show a window for sign-in (default true). Only tests without a display turn this off. */
  loginHeaded?: boolean;
  launch?: typeof chromium.launchPersistentContext;
  /** Which browser to run. Default: an installed Chrome or Edge, else Playwright's Chromium. */
  channel?: BrowserChannel;
  /** Default https://www.linkedin.com. Local test sites override it. */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  clock?: Clock;
  loginTimeoutMs?: number;
  /** Limit for page loads and clicks. */
  actionTimeoutMs?: number;
  /** How long to wait for a page to show what an action should have produced (a Pending button, a sent message). */
  settleMs?: number;
}

const DEFAULT_BASE = 'https://www.linkedin.com';
const PROFILE_DIR = 'linkedin-profile';
const LOOKBACK_MS = 3 * 86_400_000;
const MAX_THREADS = 10;
const MAX_SEARCH_PAGES = 5;
const MAX_CONNECTIONS = 80;

const CHECKPOINT_MESSAGE = 'LinkedIn is asking you to confirm it is you. Open LinkedIn in your browser, finish the check, then resume LinkedIn in Callum.';
const SIGNED_OUT_MESSAGE = 'LinkedIn signed Callum out. Sign in again from Your Callum.';
const WEEKLY_LIMIT_MESSAGE = "LinkedIn says you've reached the weekly invitation limit. Callum will wait before sending more invitations.";
const NO_BROWSER_MESSAGE = "Couldn't open the browser Callum uses for LinkedIn.";

// ---- choosing and launching the browser ----------------------------------------------------------

/** Playwright looks for an installed Chrome or Edge in these places, so these are the ones that work. */
function browserPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<'chrome' | 'msedge', string[]> {
  if (platform === 'darwin') {
    return {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    };
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return {
      chrome: roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      msedge: roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    };
  }
  return { chrome: ['/opt/google/chrome/chrome'], msedge: ['/opt/microsoft/msedge/msedge'] };
}

/** A real installed browser looks like the one the person signs in with, so prefer Chrome, then Edge. */
export function installedChannel(
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): 'chrome' | 'msedge' | null {
  const paths = browserPaths(platform, env);
  if (paths.chrome.some(exists)) return 'chrome';
  if (paths.msedge.some(exists)) return 'msedge';
  return null;
}

export function cleanUserAgent(userAgent: string): string {
  return userAgent.replace('HeadlessChrome', 'Chrome');
}

/** The same options for sign-in and for work, so LinkedIn sees one browser. */
export function launchOptions(opts: { headless: boolean; channel?: BrowserChannel | null; userAgent?: string }): LaunchOptions {
  const channel = opts.channel === undefined ? installedChannel() : opts.channel;
  return {
    // 'chromium' is the full browser in its new headless mode, not the stripped-down headless shell.
    channel: channel ?? 'chromium',
    headless: opts.headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
  };
}

// ---- small page helpers ---------------------------------------------------------------------------

type Fail = { ok: false; error: ChannelError };
const fail = (code: ChannelError['code'], message: string): Fail => ({ ok: false, error: { code, message } });

/** A decision made while driving a page that ends the action with a known result. */
class Stop extends Error {
  constructor(readonly result: Fail) {
    super(result.error.message);
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Only elements that are on screen: closed menus keep their items in the page. */
function shown(scope: Page | Locator, selector: string): Locator {
  return scope.locator(selector).filter({ visible: true });
}

/**
 * The first visible match, trying the alternatives in order (most specific first) and polling for up to `timeoutMs`.
 * Null when nothing shows up, so callers decide what that means.
 */
async function locate(scope: Page | Locator, alternatives: Selectors, timeoutMs = 0): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const selector of alternatives) {
      const found = shown(scope, selector).first();
      if ((await found.count().catch(() => 0)) > 0) return found;
    }
    if (Date.now() >= deadline) return null;
    await realSleep(150);
  }
}

/** The first alternative that matches any element at all (a list), unless a `stop` element shows first. */
async function locateList(page: Page, alternatives: Selectors, stop: Selectors, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const selector of alternatives) {
      const list = page.locator(selector);
      if ((await list.count().catch(() => 0)) > 0) return list;
    }
    if (stop.length > 0 && (await locate(page, stop))) return null;
    if (Date.now() >= deadline) return null;
    await realSleep(150);
  }
}

export function createLinkedinAdapter(secret: Record<string, string> | null, deps: LinkedinDeps): ChannelAdapter {
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const headless = deps.headless ?? true;
  const loginHeaded = deps.loginHeaded ?? true;
  const launch: typeof chromium.launchPersistentContext = deps.launch ?? ((dir, options) => chromium.launchPersistentContext(dir, options));
  const channel = deps.channel ?? installedChannel();
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const clock = deps.clock ?? systemClock;
  const loginTimeoutMs = deps.loginTimeoutMs ?? 5 * 60_000;
  const actionTimeoutMs = deps.actionTimeoutMs ?? 20_000;
  const settleMs = deps.settleMs ?? 10_000;
  const profileDir = join(deps.dataDir, PROFILE_DIR);

  let session: Record<string, string> | null = secret;
  let context: BrowserContext | null = null;
  let contextHeadless = headless;
  // The user agent to force, per mode, once a probe has shown the browser announces itself as headless.
  const forcedAgent = new Map<boolean, string | null>();
  let queue: Promise<unknown> = Promise.resolve();
  // Replies already reported by this adapter instance (polls overlap by design).
  const seen = new Set<string>();

  /** One browser action at a time: the profile cannot be shared and LinkedIn watches for parallel activity. */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  const pause = () => sleep(humanDelayMs(random));
  const url = (path: string) => `${baseUrl}${path}`;

  function cookieFor(value: string) {
    const host = new URL(baseUrl).hostname;
    return host === 'linkedin.com' || host.endsWith('.linkedin.com')
      ? { name: 'li_at', value, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true }
      : { name: 'li_at', value, url: baseUrl };
  }

  async function closeContext(): Promise<void> {
    const open = context;
    context = null;
    await open?.close().catch(() => undefined);
  }

  /** Opens the profile in the chosen browser; if it still says "HeadlessChrome", reopens it with a plain Chrome user agent. */
  async function openContext(wantHeadless: boolean): Promise<BrowserContext> {
    await mkdir(profileDir, { recursive: true });
    const forced = forcedAgent.get(wantHeadless);
    const opts = (userAgent?: string) => launchOptions({ headless: wantHeadless, channel, ...(userAgent ? { userAgent } : {}) });
    let opened = await launch(profileDir, opts(forced ?? undefined));
    if (forced === undefined) {
      const probe = opened.pages()[0] ?? (await opened.newPage());
      const agent = await probe.evaluate(() => navigator.userAgent).catch(() => '');
      if (agent.includes('HeadlessChrome')) {
        const plain = cleanUserAgent(agent);
        forcedAgent.set(wantHeadless, plain);
        await opened.close().catch(() => undefined);
        opened = await launch(profileDir, opts(plain));
      } else {
        forcedAgent.set(wantHeadless, null);
      }
    }
    return opened;
  }

  async function getContext(wantHeadless: boolean): Promise<BrowserContext> {
    if (context && contextHeadless !== wantHeadless) await closeContext();
    if (!context) {
      const opened = await openContext(wantHeadless);
      opened.on('close', () => {
        if (context === opened) context = null;
      });
      context = opened;
      contextHeadless = wantHeadless;
    }
    return context;
  }

  /** The browser profile keeps the session; if it lost the cookie, put the stored one back. */
  async function workingContext(): Promise<BrowserContext> {
    const ctx = await getContext(headless);
    const liAt = session?.liAt;
    if (liAt && !(await ctx.cookies(baseUrl)).some((c) => c.name === 'li_at')) await ctx.addCookies([cookieFor(liAt)]);
    return ctx;
  }

  async function withPage<T>(ctx: BrowserContext, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await ctx.newPage();
    page.setDefaultTimeout(actionTimeoutMs);
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async function open(page: Page, path: string): Promise<number> {
    const res = await page.goto(url(path), { waitUntil: 'domcontentloaded' });
    await pause();
    return res?.status() ?? 0;
  }

  async function bodyText(page: Page): Promise<string> {
    return page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  }

  /** Text of the places LinkedIn puts notices in: dialogs, toasts and alerts. Page content is never read for limits. */
  async function noticeText(page: Page): Promise<string> {
    const parts = await Promise.all(
      SELECTORS.notices.map((selector) =>
        page
          .locator(selector)
          .evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText).join('\n'))
          .catch(() => ''),
      ),
    );
    return parts.join('\n');
  }

  /** The checkpoint and weekly-limit decisions, made the same way before and after every action. */
  async function blocker(page: Page, status = 0): Promise<Fail | null> {
    if (isSignInUrl(page.url())) return fail('checkpoint', SIGNED_OUT_MESSAGE);
    if (isCheckpointUrl(page.url()) || isBlockedStatus(status)) return fail('checkpoint', CHECKPOINT_MESSAGE);
    if (hasWeeklyLimitText(await noticeText(page))) return fail('weekly_limit', WEEKLY_LIMIT_MESSAGE);
    return null;
  }

  async function dismissDialog(page: Page): Promise<void> {
    const close = await locate(page, SELECTORS.dialogDismiss);
    if (close) await close.click().catch(() => undefined);
    else await page.keyboard.press('Escape').catch(() => undefined);
  }

  async function stopIfBlocked(page: Page, status = 0): Promise<void> {
    const blocked = await blocker(page, status);
    if (blocked) {
      if (blocked.error.code === 'weekly_limit') await dismissDialog(page);
      throw new Stop(blocked);
    }
  }

  async function readName(page: Page): Promise<string | null> {
    const me = await locate(page, SELECTORS.meMenu, 5000);
    if (me) {
      await me.click().catch(() => undefined);
      const name = await locate(page, SELECTORS.meName, 3000);
      if (name) {
        const found = cleanName((await name.innerText().catch(() => '')) || '');
        await page.keyboard.press('Escape').catch(() => undefined);
        if (found) return found;
      }
    }
    const card = await locate(page, SELECTORS.feedName, 1500);
    return card ? cleanName((await card.innerText().catch(() => '')) || '') : null;
  }

  /** Types into a rich-text box, keeping line breaks as soft breaks so Enter never sends early. */
  async function typeInto(page: Page, box: Locator, text: string): Promise<void> {
    await box.click();
    const lines = text.split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (i > 0) await page.keyboard.press('Shift+Enter');
      if (line) await page.keyboard.insertText(line);
    }
  }

  function profilePath(msg: OutboundMessage): string {
    const normalized = profileUrlFromHref(msg.to.linkedinUrl ?? '');
    if (!normalized) throw new Stop(fail('invalid_recipient', `${msg.to.name} has no LinkedIn profile.`));
    return new URL(normalized).pathname;
  }

  const unexpectedPage = (what: string) => new Stop(fail('unknown', `Callum couldn't ${what} on LinkedIn. LinkedIn may have changed its page.`));

  /** Opens the profile and waits for its top card, so later clicks never land on "People also viewed". */
  async function openProfile(page: Page, msg: OutboundMessage): Promise<Locator> {
    const status = await open(page, profilePath(msg));
    await stopIfBlocked(page, status);
    const gone = new Stop(fail('invalid_recipient', `${msg.to.name}'s LinkedIn page wasn't found.`));
    if (status === 404) throw gone;
    const top = await locate(page, SELECTORS.topCard, settleMs);
    if (!top) {
      if (isUnavailableProfileText(await bodyText(page))) throw gone;
      throw unexpectedPage('open the profile');
    }
    const actions = [...SELECTORS.connectButton, ...SELECTORS.moreButton, ...SELECTORS.messageButton, ...SELECTORS.pendingMarker, ...SELECTORS.followButton];
    if (!(await locate(top, actions, settleMs))) throw unexpectedPage('find the buttons on the profile');
    return top;
  }

  async function pollUntil(page: Page, done: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + settleMs;
    for (;;) {
      if (await done()) return true;
      if (Date.now() >= deadline) return false;
      await realSleep(200);
    }
  }

  async function sendInvite(page: Page, msg: OutboundMessage, step: { name: string }): Promise<SendResult> {
    step.name = 'open the profile';
    const top = await openProfile(page, msg);
    // An invitation that is already waiting is as good as one just sent.
    if (await locate(top, SELECTORS.pendingMarker)) return { ok: true, externalId: null };

    /** Clicks Connect, in the top card or under More, and waits for the invitation dialog. */
    async function openConnect(): Promise<void> {
      step.name = 'find Connect';
      let connect = await locate(top, SELECTORS.connectButton);
      if (!connect) {
        const more = await locate(top, SELECTORS.moreButton);
        if (more) {
          await more.click();
          await pause();
          connect = await locate(page, SELECTORS.moreMenuConnect, Math.min(3000, settleMs));
          if (!connect) await page.keyboard.press('Escape').catch(() => undefined);
        }
      }
      if (!connect) {
        // Only say something about the person when the page shows why; otherwise the page is not what Callum expects.
        if (await locate(top, SELECTORS.messageButton)) throw new Stop(fail('invalid_recipient', `You're already connected to ${msg.to.name} on LinkedIn.`));
        if (await locate(top, SELECTORS.followButton)) throw new Stop(fail('invalid_recipient', `LinkedIn doesn't offer Connect for ${msg.to.name}.`));
        throw unexpectedPage('find Connect');
      }
      await connect.click();
      await pause();
      await stopIfBlocked(page);
    }

    await openConnect();
    step.name = 'write the note';
    const note = clampNote(msg.body);
    let withNote = false;
    let noteDropped = false;
    if (note) {
      const add = await locate(page, SELECTORS.addNoteButton, 5000);
      if (add) {
        await add.click();
        await pause();
        // A free account that has used its notes gets a Premium offer here instead of a text box.
        let box: Locator | null = null;
        await pollUntil(page, async () => {
          box = await locate(page, SELECTORS.noteTextarea);
          return box !== null || (await locate(page, SELECTORS.premiumUpsell)) !== null;
        });
        if (box) {
          await (box as Locator).fill(note);
          await pause();
          withNote = true;
        } else {
          step.name = 'send without the note';
          await dismissDialog(page);
          await pause();
          await openConnect();
        }
      }
      noteDropped = !withNote;
    }

    step.name = 'send the invitation';
    const send = await locate(page, withNote ? SELECTORS.sendInviteButton : SELECTORS.sendWithoutNoteButton, 5000);
    if (!send) throw unexpectedPage('find the Send button');
    await send.click();
    const closed = await pollUntil(page, async () => {
      await stopIfBlocked(page);
      return (await locate(page, SELECTORS.dialog)) === null;
    });
    await stopIfBlocked(page);
    // Success is the Pending button on the profile, not the dialog going away: an error toast also closes the dialog.
    if (!closed || !(await locate(top, SELECTORS.pendingMarker, settleMs))) {
      await stopIfBlocked(page);
      throw new Stop(fail('unknown', "LinkedIn didn't confirm the invitation. Callum will check before trying again."));
    }
    return { ok: true, externalId: null, ...(noteDropped ? { noteDropped: true as const } : {}) };
  }

  async function closeBubbles(page: Page): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const close = await locate(page, SELECTORS.bubbleClose);
      if (!close) return;
      await close.click().catch(() => undefined);
      await realSleep(200);
    }
  }

  /** The chat window opened for this person, found by the name in its header. */
  async function findBubble(page: Page, profileName: string, timeoutMs: number): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const name of headerNameCandidates(profileName)) {
        for (const bubble of SELECTORS.messageBubble) {
          for (const header of SELECTORS.bubbleHeader) {
            const match = page.locator(bubble).filter({ has: page.locator(header).filter({ hasText: name }) }).filter({ visible: true }).first();
            if ((await match.count().catch(() => 0)) > 0) return match;
          }
        }
      }
      if (Date.now() >= deadline) return null;
      await realSleep(150);
    }
  }

  async function lastMessageIn(scope: Locator): Promise<string> {
    for (const selector of SELECTORS.threadMessage) {
      const items = scope.locator(selector);
      const count = await items.count().catch(() => 0);
      if (count > 0) return normalizeText(await items.nth(count - 1).innerText().catch(() => ''));
    }
    return '';
  }

  async function sendDirectMessage(page: Page, msg: OutboundMessage, step: { name: string }): Promise<SendResult> {
    step.name = 'open the profile';
    const top = await openProfile(page, msg);
    step.name = 'find Message';
    const message = await locate(top, SELECTORS.messageButton);
    if (!message) {
      const notConnected = (await locate(top, SELECTORS.connectButton)) ?? (await locate(top, SELECTORS.pendingMarker)) ?? (await locate(top, SELECTORS.followButton));
      if (notConnected) throw new Stop(fail('invalid_recipient', `You're not connected to ${msg.to.name} on LinkedIn yet, so Callum can't message them.`));
      throw unexpectedPage('find Message');
    }
    const heading = await locate(top, SELECTORS.profileName);
    const profileName = cleanName(heading ? await heading.innerText().catch(() => '') : '') ?? msg.to.name;

    // Chat windows that LinkedIn restored from earlier would otherwise be where the text goes.
    await closeBubbles(page);
    await message.click();
    await pause();
    await stopIfBlocked(page);

    step.name = 'open the conversation';
    const bubble = await findBubble(page, profileName, settleMs);
    const composer = bubble ? await locate(bubble, SELECTORS.composer, settleMs) : null;
    if (!bubble || !composer) throw unexpectedPage(`open a conversation with ${msg.to.name}`);

    step.name = 'write the message';
    await typeInto(page, composer, msg.body);
    await pause();

    step.name = 'send the message';
    const send = await locate(bubble, SELECTORS.composerSend, 5000);
    if (!send) throw unexpectedPage('find the Send button');
    await send.click();
    // Success is the text showing up as the newest message in that conversation, not the box emptying.
    const wanted = normalizeText(msg.body);
    const delivered = await pollUntil(page, async () => (await lastMessageIn(bubble)) === wanted);
    await stopIfBlocked(page);
    if (!delivered) throw new Stop(fail('unknown', "LinkedIn didn't confirm the message. Callum will check before trying again."));
    await pause();
    const close = await locate(bubble, SELECTORS.bubbleClose);
    await close?.click().catch(() => undefined);
    return { ok: true, externalId: null };
  }

  async function collectAccepted(page: Page, at: string): Promise<InboundEvent[]> {
    const links = await locateList(page, SELECTORS.connectionLink, [], 5000);
    const hrefs = links ? await links.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? '')) : [];
    const urls = new Set<string>();
    for (const href of hrefs) {
      const profile = profileUrlFromHref(href);
      if (profile) urls.add(profile);
      if (urls.size >= MAX_CONNECTIONS) break;
    }
    return [...urls].map((linkedinUrl) => ({ type: 'accepted' as const, linkedinUrl, at }));
  }

  const threadIdOf = (address: string) => /\/messaging\/thread\/([^/?#]+)/.exec(address)?.[1] ?? null;

  async function collectReplies(page: Page, since: Date, now: Date): Promise<InboundEvent[]> {
    const list = await locateList(page, SELECTORS.conversation, [], 5000);
    if (!list) return [];
    const rows = await list.evaluateAll(
      (els, sel) => {
        const first = (el: Element, alternatives: readonly string[]) => {
          for (const alternative of alternatives) {
            const found = el.querySelector(alternative);
            if (found) return found;
          }
          return null;
        };
        return els.map((el) => ({
          href: first(el, sel.link)?.getAttribute('href') ?? '',
          name: first(el, sel.name)?.textContent ?? '',
          snippet: first(el, sel.snippet)?.textContent ?? '',
          time: first(el, sel.time)?.textContent ?? '',
        }));
      },
      { link: SELECTORS.conversationLink, name: SELECTORS.conversationName, snippet: SELECTORS.conversationSnippet, time: SELECTORS.conversationTime },
    );

    const events: InboundEvent[] = [];
    let opened = 0;
    let onList = true;
    for (const [index, row] of rows.entries()) {
      if (opened >= MAX_THREADS) break;
      if (isOwnSnippet(row.snippet)) continue;
      const stamp = parseListTimestamp(row.time, now);
      if (!stamp) continue;
      const at = new Date(Math.min(stamp.getTime(), now.getTime()));
      if (at.getTime() < since.getTime()) continue;
      opened++;

      if (row.href) {
        // Fast path: the row is a link to the thread.
        await open(page, new URL(row.href, baseUrl).pathname);
        onList = false;
      } else {
        // Rows without a link open the thread when clicked; the list has to be on screen to click one.
        if (!onList) {
          await open(page, '/messaging/');
          onList = true;
          if (!(await locateList(page, SELECTORS.conversation, [], 5000))) break;
        }
        const before = threadIdOf(page.url());
        const rowEl = list.nth(index);
        const target = (await locate(rowEl, SELECTORS.conversationLink)) ?? rowEl;
        await target.click();
        const moved = await page.waitForURL((u) => {
          const id = threadIdOf(u.toString());
          return id !== null && id !== before;
        }, { timeout: settleMs }).then(() => true, () => false);
        if (!moved) continue;
        await pause();
      }

      if (await blocker(page)) return events;
      const threadId = threadIdOf(page.url());
      const panel = (await locate(page, SELECTORS.threadPanel)) ?? page.locator('body');
      // Wait for the panel to show this conversation, so a previous one is never read by mistake.
      let text = '';
      const matched = await pollUntil(page, async () => {
        text = await lastMessageIn(panel);
        return text !== '' && snippetMatches(row.snippet, text);
      });
      if (!threadId || !matched) continue;
      const profile = await locate(page, SELECTORS.threadProfileLink, 3000);
      const linkedinUrl = profileUrlFromHref((await profile?.getAttribute('href').catch(() => null)) ?? '');
      if (!linkedinUrl) continue;
      const key = `${threadId}:${hash(text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = cleanName(row.name);
      events.push({ type: 'reply', from: { linkedinUrl, ...(name ? { name } : {}) }, text, at: at.toISOString(), externalId: key });
    }
    return events;
  }

  function searchTarget(input: string): string {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw new Error("That isn't a LinkedIn people search address.");
    }
    const host = parsed.hostname.toLowerCase();
    const ours = new URL(baseUrl).hostname;
    const linkedinHost = host === 'linkedin.com' || host.endsWith('.linkedin.com');
    if ((!linkedinHost && host !== ours) || !parsed.pathname.startsWith('/search/results/people')) {
      throw new Error("That isn't a LinkedIn people search address.");
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  return {
    channel: 'linkedin',

    connect(input) {
      return exclusive(async () => {
        const liAt = (input.liAt ?? '').trim();
        const showWindow = !liAt && loginHeaded;
        let ctx: BrowserContext;
        try {
          ctx = await getContext(showWindow ? false : headless);
        } catch {
          throw new ConnectError(NO_BROWSER_MESSAGE);
        }
        let identity: string | null;
        let stored: Record<string, string>;
        if (liAt) {
          await ctx.clearCookies({ name: 'li_at' });
          await ctx.addCookies([cookieFor(liAt)]);
          identity = await withPage(ctx, async (page) => {
            await open(page, '/feed/');
            if (isCheckpointUrl(page.url())) {
              throw new ConnectError("LinkedIn didn't accept that cookie. Copy li_at again from a browser where you're signed in.");
            }
            return readName(page);
          });
          stored = { liAt };
        } else {
          try {
            // The window's own first tab is used, so the person sees one page, not two.
            const page = ctx.pages()[0] ?? (await ctx.newPage());
            page.setDefaultTimeout(actionTimeoutMs);
            await page.goto(url('/login'), { waitUntil: 'domcontentloaded' });
            const closed = new Promise<'closed'>((resolve) => page.once('close', () => resolve('closed')));
            const arrived = page.waitForURL((u) => new URL(u).pathname.startsWith('/feed'), { timeout: loginTimeoutMs }).then(
              () => 'arrived' as const,
              () => 'gave up' as const,
            );
            const outcome = await Promise.race([closed, arrived]);
            if (outcome === 'closed' || page.isClosed()) {
              throw new ConnectError('The LinkedIn window was closed before you finished signing in.');
            }
            if (outcome === 'gave up') throw new ConnectError("LinkedIn sign-in didn't finish in 5 minutes. Connect LinkedIn again when you're ready.");
            await page.waitForLoadState('domcontentloaded').catch(() => undefined);
            identity = await readName(page);
            // Keep the session cookie in the secret so the working browser can restore it if its profile loses it.
            const cookie = (await ctx.cookies(baseUrl)).find((c) => c.name === 'li_at');
            stored = cookie ? { liAt: cookie.value } : { session: 'browser' };
          } finally {
            // The sign-in window has done its job; the next action reopens the same profile without a window.
            if (showWindow) await closeContext();
          }
        }
        session = stored;
        return { identity: identity ?? 'LinkedIn', secret: stored };
      });
    },

    send(msg) {
      return exclusive(async (): Promise<SendResult> => {
        if (!session) return fail('auth', SIGNED_OUT_MESSAGE);
        const step = { name: 'open the browser' };
        try {
          const ctx = await workingContext();
          step.name = 'open the profile';
          return await withPage(ctx, async (page) => {
            try {
              return msg.kind === 'invite' ? await sendInvite(page, msg, step) : await sendDirectMessage(page, msg, step);
            } catch (err) {
              if (err instanceof Stop) throw err;
              // A page that stopped looking right may be a check in disguise.
              const blocked = await blocker(page).catch(() => null);
              if (blocked) throw new Stop(blocked);
              throw err;
            }
          });
        } catch (err) {
          if (err instanceof Stop) return err.result;
          if (step.name === 'open the browser') return fail('temporary', `${NO_BROWSER_MESSAGE} Callum will try again.`);
          return fail('unknown', `Callum couldn't ${step.name} on LinkedIn. LinkedIn may have changed its page.`);
        }
      });
    },

    poll(since) {
      return exclusive(async () => {
        if (!session) throw new ConnectError(SIGNED_OUT_MESSAGE, 'auth');
        const now = clock.now();
        const from = since ?? new Date(now.getTime() - LOOKBACK_MS);
        const ctx = await workingContext();
        return withPage(ctx, async (page) => {
          const at = now.toISOString();
          const status = await open(page, '/mynetwork/invite-connect/connections/');
          if (await blocker(page, status)) return [{ type: 'checkpoint' as const, at }];
          const events = await collectAccepted(page, at);
          const messaging = await open(page, '/messaging/');
          if (await blocker(page, messaging)) return [...events, { type: 'checkpoint' as const, at }];
          return [...events, ...(await collectReplies(page, from, now))];
        });
      });
    },

    searchPeople(input, limit) {
      return exclusive(async () => {
        if (!session) throw new ConnectError(SIGNED_OUT_MESSAGE, 'auth');
        const target = new URL(searchTarget(input), baseUrl);
        const ctx = await workingContext();
        return withPage(ctx, async (page) => {
          const people: NewPerson[] = [];
          const known = new Set<string>();
          for (let pageNo = 1; pageNo <= MAX_SEARCH_PAGES && people.length < limit; pageNo++) {
            target.searchParams.set('page', String(pageNo));
            const status = await open(page, `${target.pathname}${target.search}`);
            const blocked = await blocker(page, status);
            if (blocked) throw new Error(blocked.error.message);
            // Either results or LinkedIn's "no results" notice ends the wait.
            const results = await locateList(page, SELECTORS.searchResult, SELECTORS.searchEmpty, 8000);
            if (!results) break;
            const rows = await results.evaluateAll(
              (els, sel) => {
                const first = (el: Element, alternatives: readonly string[]) => {
                  for (const alternative of alternatives) {
                    const found = el.querySelector(alternative);
                    if (found) return found;
                  }
                  return null;
                };
                return els.map((el) => {
                  // The first profile link is the result's own person; later ones are mutual connections and the like.
                  const linkSelector = sel.link[0] ?? 'a';
                  const own = el.querySelector(linkSelector)?.getAttribute('href') ?? '';
                  const links = [...el.querySelectorAll(linkSelector)].filter((a) => a.getAttribute('href') === own);
                  const spans = links.flatMap((a) => sel.name.flatMap((n) => [...a.querySelectorAll(n)]));
                  return {
                    href: own,
                    names: [...spans, ...links].map((n) => n.textContent ?? ''),
                    headline: first(el, sel.headline)?.textContent ?? '',
                  };
                });
              },
              { link: SELECTORS.searchLink, name: SELECTORS.searchName, headline: SELECTORS.searchHeadline },
            );
            let added = 0;
            for (const row of rows) {
              const linkedinUrl = profileUrlFromHref(row.href);
              const name = row.names.map(cleanName).find((n) => n !== null) ?? null;
              if (!linkedinUrl || !name || known.has(linkedinUrl)) continue;
              known.add(linkedinUrl);
              const { role, company } = splitHeadline(row.headline);
              people.push({ name, source: 'linkedin_search', linkedinUrl, ...(role ? { role } : {}), ...(company ? { company } : {}) });
              added++;
              if (people.length >= limit) break;
            }
            if (added === 0) break;
          }
          return people;
        });
      });
    },

    forget() {
      return exclusive(async () => {
        session = null;
        await closeContext();
        await rm(profileDir, { recursive: true, force: true });
      });
    },

    close() {
      // Not queued: shutting down must not wait behind a five minute sign-in.
      return closeContext();
    },
  };
}
