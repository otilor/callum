import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { PersonLead } from '../../shared/types.js';
import { findBrowser as findInstalledBrowser, installedChannel, type BrowserChoice } from './browser.js';
import { systemClock, type Clock } from '../engine/clock.js';
import {
  SELECTORS, clampNote, cleanName, hasWeeklyLimitText, headerNameCandidates, humanDelayMs, isBlockedStatus, isCheckpointUrl,
  hasSendFailureText, isOwnSnippet, lastSender, isSignInUrl, isUnavailableProfileText, memberIdFromHref, normalizeText, parseListTimestamp, profileUrlFromHref, replyProfile,
  sameParticipant, snippetMatches, splitHeadline,
} from './linkedin-detect.js';
import { ConnectError, type ChannelAdapter, type ChannelError, type InboundEvent, type OutboundMessage, type SendResult } from './types.js';

export { installedChannel };
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
  /** Which browser to run. Default: an installed Chrome or Edge, else Playwright's Chromium (see browser.ts). */
  findBrowser?: () => Promise<BrowserChoice | null>;
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
  /** How long a sent message is watched for a "failed to send" mark before it counts as sent. */
  watchMs?: number;
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
const NO_BROWSER_MESSAGE = 'LinkedIn needs Google Chrome or Microsoft Edge on this computer. Install one, then try again.';
const BROWSER_WOULD_NOT_OPEN_MESSAGE = "Couldn't open the browser Callum uses for LinkedIn.";
const OFFLINE_MESSAGE = "Couldn't open LinkedIn. Check your internet connection and try again.";
const WINDOW_CLOSED_MESSAGE = 'The LinkedIn window was closed before you finished signing in.';

// ---- choosing and launching the browser ----------------------------------------------------------

export function cleanUserAgent(userAgent: string): string {
  return userAgent.replace('HeadlessChrome', 'Chrome');
}

/** The same options for sign-in and for work, so LinkedIn sees one browser. */
export function launchOptions(opts: { headless: boolean; browser: BrowserChoice; userAgent?: string }): LaunchOptions {
  return {
    // A channel means the installed Chrome or Edge; a path is Playwright's own full Chromium (never the headless shell).
    ...(opts.browser.channel ? { channel: opts.browser.channel } : {}),
    ...(opts.browser.executablePath ? { executablePath: opts.browser.executablePath } : {}),
    headless: opts.headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    // --test-type hides Chrome's "unsupported command-line flag" bar, which the other flag would otherwise show.
    args: ['--disable-blink-features=AutomationControlled', '--test-type'],
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
  const chooseBrowser = deps.findBrowser ?? (() => findInstalledBrowser());
  let browser: BrowserChoice | null = null;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const clock = deps.clock ?? systemClock;
  const loginTimeoutMs = deps.loginTimeoutMs ?? 5 * 60_000;
  const actionTimeoutMs = deps.actionTimeoutMs ?? 20_000;
  const settleMs = deps.settleMs ?? 10_000;
  const watchMs = deps.watchMs ?? 2000;
  const profileDir = join(deps.dataDir, PROFILE_DIR);

  let session: Record<string, string> | null = secret;
  // Who the signed-in user is, to tell their messages from the other person's. Read at connect, or at the first poll.
  let self: { name: string | null; url: string | null } | null = null;
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
    browser ??= await chooseBrowser();
    if (!browser) throw new ConnectError(NO_BROWSER_MESSAGE);
    const chosen = browser;
    const opts = (userAgent?: string) => launchOptions({ headless: wantHeadless, browser: chosen, ...(userAgent ? { userAgent } : {}) });
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

  /** The signed-in user's name and profile address, from the "Me" menu on a LinkedIn page that has the header. */
  async function readSelf(page: Page): Promise<{ name: string | null; url: string | null }> {
    let name: string | null = null;
    let profile: string | null = null;
    const me = await locate(page, SELECTORS.meMenu, 5000);
    if (me) {
      await me.click().catch(() => undefined);
      const label = await locate(page, SELECTORS.meName, 3000);
      if (label) name = cleanName((await label.innerText().catch(() => '')) || '');
      const link = await locate(page, SELECTORS.meProfileLink);
      profile = profileUrlFromHref((await link?.getAttribute('href').catch(() => null)) ?? '');
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    if (!name) {
      const card = await locate(page, SELECTORS.feedName, 1500);
      name = card ? cleanName((await card.innerText().catch(() => '')) || '') : null;
    }
    return { name, url: profile };
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

  async function pollUntil(page: Page, done: () => Promise<boolean>, withinMs = settleMs): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    for (;;) {
      if (await done()) return true;
      if (Date.now() >= deadline) return false;
      await realSleep(200);
    }
  }

  async function sendInvite(page: Page, msg: OutboundMessage, step: { name: string }): Promise<SendResult> {
    step.name = 'open the profile';
    const top = await openProfile(page, msg);
    if (await locate(top, SELECTORS.pendingMarker)) return { ok: true, externalId: null };

    /** Whether the invitation is already waiting: a Pending button in the top card or, once opened, in the More menu. */
    const pendingInMoreMenu = async (): Promise<boolean> => {
      const more = await locate(top, SELECTORS.moreButton);
      if (!more) return false;
      await more.click().catch(() => undefined);
      const found = await locate(page, SELECTORS.moreMenuPending, Math.min(800, settleMs));
      await page.keyboard.press('Escape').catch(() => undefined);
      return found !== null;
    };

    /** Clicks Connect, in the top card or under More, and waits for the invitation dialog. 'pending' means there was nothing to do. */
    async function openConnect(): Promise<'opened' | 'pending'> {
      step.name = 'find Connect';
      let connect = await locate(top, SELECTORS.connectButton);
      if (!connect) {
        const more = await locate(top, SELECTORS.moreButton);
        if (more) {
          await more.click();
          await pause();
          if (await locate(page, SELECTORS.moreMenuPending)) {
            await page.keyboard.press('Escape').catch(() => undefined);
            return 'pending';
          }
          connect = await locate(page, SELECTORS.moreMenuConnect, Math.min(3000, settleMs));
          if (!connect) await page.keyboard.press('Escape').catch(() => undefined);
        }
      }
      if (!connect) {
        // Only say something about the person when the page shows why; otherwise the page is not what Callum expects.
        if (await locate(top, SELECTORS.messageButton)) throw new Stop(fail('already_connected', `You're already connected to ${msg.to.name} on LinkedIn.`));
        if (await locate(top, SELECTORS.followButton)) throw new Stop(fail('invalid_recipient', `LinkedIn doesn't offer Connect for ${msg.to.name}.`));
        throw unexpectedPage('find Connect');
      }
      await connect.click();
      await pause();
      await stopIfBlocked(page);
      return 'opened';
    }

    // An invitation that is already waiting is as good as one just sent.
    if ((await openConnect()) === 'pending') return { ok: true, externalId: null };
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
          if ((await openConnect()) === 'pending') return { ok: true, externalId: null };
        }
      }
      noteDropped = !withNote;
    }

    step.name = 'send the invitation';
    const send = await locate(page, withNote ? SELECTORS.sendInviteButton : SELECTORS.sendWithoutNoteButton, 5000);
    if (!send) throw unexpectedPage('find the Send button');
    await send.click();
    // Success is a Pending button on the profile, whatever dialogs are still open: an error toast closes the dialog too.
    // The top card first. If it never shows Pending, look in the More menu once, after a pause like a person's.
    let confirmedIn: 'card' | 'menu' | null = null;
    const inCard = async () => (await locate(top, SELECTORS.pendingMarker)) !== null;
    const confirmed = await pollUntil(
      page,
      async () => {
        await stopIfBlocked(page);
        return inCard();
      },
      Math.min(settleMs, 3000),
    );
    if (confirmed) confirmedIn = 'card';
    else {
      await stopIfBlocked(page);
      await pause();
      if (await pendingInMoreMenu()) confirmedIn = 'menu';
    }
    await stopIfBlocked(page);
    if (!confirmedIn) throw new Stop(fail('unknown', "LinkedIn didn't confirm the invitation. Callum will check before trying again."));
    // A Pending button can show for a moment and then go: LinkedIn takes the invitation back when it cannot keep it.
    // After a pause like a person's, look once more before calling it sent.
    await pause();
    await stopIfBlocked(page);
    const stillPending = confirmedIn === 'card' ? await inCard() : await pendingInMoreMenu();
    if (!stillPending) throw new Stop(fail('unknown', "LinkedIn showed the invitation as sent, then took it back. Callum didn't count it as sent and will check before trying again."));
    if (await locate(page, SELECTORS.dialog)) await dismissDialog(page);
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

  async function countMessagesIn(scope: Locator): Promise<number> {
    for (const selector of SELECTORS.threadMessage) {
      const count = await scope.locator(selector).count().catch(() => 0);
      if (count > 0) return count;
    }
    return 0;
  }

  /** The newest message's text element in a conversation. */
  async function newestBody(scope: Locator): Promise<Locator | null> {
    for (const selector of SELECTORS.threadMessage) {
      const items = scope.locator(selector);
      const count = await items.count().catch(() => 0);
      if (count > 0) return items.nth(count - 1);
    }
    return null;
  }

  /**
   * Whether LinkedIn marks the newest message as failed. Only failure UI counts: an error element or flag next to the
   * message text, a Retry button, or a toast. The words of the message itself are never read for this.
   */
  async function newestMessageFailed(page: Page, scope: Locator): Promise<boolean> {
    const body = await newestBody(scope);
    if (body) {
      const flagged = await body
        .evaluate(
          (node, a) => {
            const item = node.closest(a.container) ?? node.parentElement;
            if (!item) return false;
            const hit = (el: Element) => a.failure.some((selector) => el.matches(selector));
            return hit(item) || [...item.querySelectorAll('*')].some((el) => el !== node && !node.contains(el) && hit(el));
          },
          { container: SELECTORS.messageItem.join(', '), failure: SELECTORS.messageFailure },
        )
        .catch(() => false);
      if (flagged) return true;
      const item = body.locator('xpath=ancestor::li[1]');
      if (await locate(item, SELECTORS.retryButton)) return true;
    }
    const toasts = await Promise.all(
      SELECTORS.toasts.map((selector) =>
        page
          .locator(selector)
          .evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText).join('\n'))
          .catch(() => ''),
      ),
    );
    return hasSendFailureText(toasts.join('\n'));
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
    const before = await countMessagesIn(bubble);
    await send.click();
    // Success is a new message with this text at the end of that conversation. An identical earlier message
    // does not count, and neither does the box emptying.
    const wanted = normalizeText(msg.body);
    const arrived = async () => (await countMessagesIn(bubble)) > before && (await lastMessageIn(bubble)) === wanted;
    const delivered = await pollUntil(page, arrived);
    await stopIfBlocked(page);
    if (!delivered) throw new Stop(fail('unknown', "LinkedIn didn't confirm the message. Callum will check before trying again."));
    // LinkedIn shows a message at once and may mark it "failed to send" a moment later, so watch it for a while.
    const failed = new Stop(fail('unknown', "LinkedIn couldn't send the message. Callum will check before trying again."));
    const watchEnd = Date.now() + watchMs;
    for (;;) {
      if (await newestMessageFailed(page, bubble)) throw failed;
      if (Date.now() >= watchEnd) break;
      await realSleep(100);
    }
    // The watch found no failure mark. The message is still in the conversation if the count is above what it was;
    // its last line may have changed since (a reply came in, a link preview was added). A duplicate message is worse
    // than a failure that went unseen, so only a message that has gone from the conversation counts as failed.
    if ((await countMessagesIn(bubble)) <= before) throw failed;
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
    const checkpoint = (): InboundEvent => ({ type: 'checkpoint', at: now.toISOString() });
    // Member-id addresses already looked up in this run.
    const vanityOf = new Map<string, string | null>();
    /** The open conversation's other person and newest message. */
    const readPanel = async () => {
      const panel = (await locate(page, SELECTORS.threadPanel)) ?? page.locator('body');
      const link = await locate(page, SELECTORS.threadProfileLink);
      return { panel, text: await lastMessageIn(panel), name: link ? await link.innerText().catch(() => '') : '' };
    };
    const readSenderMarks = async (panel: Locator) => {
      const body = await newestBody(panel);
      const marks = await body
        ?.evaluate(
          (node, a) => {
            const item = node.closest(a.event.join(', '));
            const group = node.closest(a.group.join(', '));
            const nameEl = group ? a.name.map((s) => group.querySelector(s)).find((el) => el) : null;
            return {
              itemClass: item ? item.className : null,
              groupName: nameEl?.textContent ?? null,
              groupHref: group?.querySelector('a[href*="/in/"]')?.getAttribute('href') ?? null,
            };
          },
          { event: [...SELECTORS.messageEvent], group: [...SELECTORS.messageGroup], name: [...SELECTORS.messageGroupName] },
        )
        .catch(() => null);
      return marks ?? { itemClass: null, groupName: null, groupHref: null };
    };
    const panelShows = async (row: { name: string; snippet: string }) => {
      const open = await readPanel();
      return open.text !== '' && sameParticipant(row.name, open.name) && snippetMatches(row.snippet, open.text);
    };
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
          if (await blocker(page)) return [...events, checkpoint()];
          onList = true;
          if (!(await locateList(page, SELECTORS.conversation, [], 5000))) break;
        }
        const before = threadIdOf(page.url());
        const rowEl = list.nth(index);
        const target = (await locate(rowEl, SELECTORS.conversationLink)) ?? rowEl;
        await target.click();
        // The address moves to the clicked thread. LinkedIn also opens the newest conversation by itself, so
        // clicking that row changes nothing: then the panel already showing this person and message is enough.
        const reached = await pollUntil(page, async () => {
          const id = threadIdOf(page.url());
          if (id !== null && id !== before) return true;
          return id !== null && (await panelShows(row));
        });
        if (!reached) {
          if (await blocker(page)) return [...events, checkpoint()];
          continue;
        }
        await pause();
      }

      if (await blocker(page)) return [...events, checkpoint()];
      const threadId = threadIdOf(page.url());
      // Wait for the panel to show this conversation, so a previous one is never read by mistake.
      let text = '';
      const matched = await pollUntil(page, async () => {
        if (!(await panelShows(row))) return false;
        text = (await readPanel()).text;
        return true;
      });
      if (!threadId || !matched) continue;
      // Who wrote the newest message comes from the thread's own markers, never from the preview text. When the
      // page does not say, the thread is skipped (and not marked as seen), so the next poll looks at it again.
      const current = await readPanel();
      const sender = lastSender(await readSenderMarks(current.panel), {
        participantName: current.name || row.name,
        selfName: self?.name ?? null,
        selfUrl: self?.url ?? null,
      });
      if (sender !== 'other') continue;
      const profile = await locate(page, SELECTORS.threadProfileLink, 3000);
      // A thread header can link to the member-id address (/in/ACo...). Stored people have the vanity one, so look it up.
      let checkAgain = false;
      const who = await replyProfile((await profile?.getAttribute('href').catch(() => null)) ?? '', async (memberId) => {
        if (vanityOf.has(memberId)) return vanityOf.get(memberId) ?? null;
        await open(page, `/in/${memberId}/`);
        onList = false;
        if (await blocker(page)) {
          checkAgain = true;
          return null;
        }
        const landed = page.url();
        const vanity = profileUrlFromHref(landed) && !memberIdFromHref(landed) ? landed : null;
        vanityOf.set(memberId, vanity);
        return vanity;
      });
      if (checkAgain) return [...events, checkpoint()];
      if (!who) continue;
      const key = `${threadId}:${hash(text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = cleanName(row.name);
      events.push({
        type: 'reply', from: { linkedinUrl: who.url, ...(who.alt ? { linkedinAltUrl: who.alt } : {}), ...(name ? { name } : {}) },
        text, at: at.toISOString(), externalId: key,
      });
    }
    return events;
  }

  function searchTarget(input: string): string {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw new ConnectError("That isn't a LinkedIn people search address.");
    }
    const host = parsed.hostname.toLowerCase();
    const ours = new URL(baseUrl).hostname;
    const linkedinHost = host === 'linkedin.com' || host.endsWith('.linkedin.com');
    if ((!linkedinHost && host !== ours) || !parsed.pathname.startsWith('/search/results/people')) {
      throw new ConnectError("That isn't a LinkedIn people search address.");
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
        } catch (err) {
          throw err instanceof ConnectError ? err : new ConnectError(BROWSER_WOULD_NOT_OPEN_MESSAGE);
        }
        const offline = (err: unknown) => (err instanceof ConnectError ? err : new ConnectError(OFFLINE_MESSAGE, 'temporary'));
        const finishFailure = (err: unknown) =>
          err instanceof ConnectError ? err : new ConnectError("Couldn't finish connecting to LinkedIn. Try connecting again.", 'temporary');
        let identity: { name: string | null; url: string | null };
        let stored: Record<string, string>;
        if (liAt) {
          await ctx.clearCookies({ name: 'li_at' });
          await ctx.addCookies([cookieFor(liAt)]);
          identity = await withPage(ctx, async (page) => {
            try {
              await open(page, '/feed/');
            } catch (err) {
              throw offline(err);
            }
            if (isCheckpointUrl(page.url())) {
              throw new ConnectError("LinkedIn didn't accept that cookie. Copy li_at again from a browser where you're signed in.");
            }
            try {
              return await readSelf(page);
            } catch (err) {
              throw finishFailure(err);
            }
          });
          stored = { liAt };
        } else {
          try {
            // The window's own first tab is used, so the person sees one page, not two.
            const page = ctx.pages()[0] ?? (await ctx.newPage());
            page.setDefaultTimeout(actionTimeoutMs);
            try {
              await page.goto(url('/login'), { waitUntil: 'domcontentloaded' });
            } catch (err) {
              throw page.isClosed() ? new ConnectError(WINDOW_CLOSED_MESSAGE) : offline(err);
            }
            const closed = new Promise<'closed'>((resolve) => page.once('close', () => resolve('closed')));
            const arrived = page.waitForURL((u) => new URL(u).pathname.startsWith('/feed'), { timeout: loginTimeoutMs }).then(
              () => 'arrived' as const,
              () => 'gave up' as const,
            );
            const outcome = await Promise.race([closed, arrived]);
            if (outcome === 'closed' || page.isClosed()) {
              throw new ConnectError(WINDOW_CLOSED_MESSAGE);
            }
            if (outcome === 'gave up') throw new ConnectError("LinkedIn sign-in didn't finish in 5 minutes. Connect LinkedIn again when you're ready.");
            try {
              await page.waitForLoadState('domcontentloaded').catch(() => undefined);
              identity = await readSelf(page);
              // Keep the session cookie in the secret so the working browser can restore it if its profile loses it.
              const cookie = (await ctx.cookies(baseUrl)).find((c) => c.name === 'li_at');
              stored = cookie ? { liAt: cookie.value } : { session: 'browser' };
            } catch (err) {
              throw finishFailure(err);
            }
          } finally {
            // The sign-in window has done its job; the next action reopens the same profile without a window.
            if (showWindow) await closeContext();
          }
        }
        session = stored;
        self = identity;
        return { identity: identity.name ?? 'LinkedIn', secret: stored };
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
          if (step.name === 'open the browser') {
            return fail('temporary', err instanceof ConnectError ? err.message : `${BROWSER_WOULD_NOT_OPEN_MESSAGE} Callum will try again.`);
          }
          return fail('unknown', `Callum couldn't ${step.name} on LinkedIn. LinkedIn may have changed its page.`);
        }
      });
    },

    poll(since) {
      return exclusive(async () => {
        if (!session) throw new ConnectError(SIGNED_OUT_MESSAGE, 'auth');
        const now = clock.now();
        const from = since ?? new Date(now.getTime() - LOOKBACK_MS);
        try {
          const ctx = await workingContext();
          return await withPage(ctx, async (page) => {
            const at = now.toISOString();
            const status = await open(page, '/mynetwork/invite-connect/connections/');
            if (await blocker(page, status)) return [{ type: 'checkpoint' as const, at }];
            const events = await collectAccepted(page, at);
            if (!self) {
              // Needed to tell the user's own messages from the other person's; the header is on the feed.
              await open(page, '/feed/');
              if (await blocker(page)) return [...events, { type: 'checkpoint' as const, at }];
              self = await readSelf(page);
            }
            const messaging = await open(page, '/messaging/');
            if (await blocker(page, messaging)) return [...events, { type: 'checkpoint' as const, at }];
            return [...events, ...(await collectReplies(page, from, now))];
          });
        } catch (err) {
          throw err instanceof ConnectError ? err : new ConnectError("Couldn't check LinkedIn for replies. Callum will try again.", 'temporary');
        }
      });
    },

    searchPeople(input, limit) {
      return exclusive(async () => {
        if (!session) throw new ConnectError(SIGNED_OUT_MESSAGE, 'auth');
        const target = new URL(searchTarget(input), baseUrl);
        const ctx = await workingContext();
        return withPage(ctx, async (page) => {
          const people: PersonLead[] = [];
          const known = new Set<string>();
          for (let pageNo = 1; pageNo <= MAX_SEARCH_PAGES && people.length < limit; pageNo++) {
            target.searchParams.set('page', String(pageNo));
            const status = await open(page, `${target.pathname}${target.search}`);
            const blocked = await blocker(page, status);
            if (blocked) throw new ConnectError(blocked.error.message, blocked.error.code);
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
      }).catch((err: unknown) => {
        // Whatever went wrong while loading pages reaches the person as plain words, never as browser text.
        throw err instanceof ConnectError ? err : new ConnectError("Couldn't search LinkedIn right now. Callum will try again.", 'temporary');
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
