import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { NewPerson } from '../../shared/types.js';
import { systemClock, type Clock } from '../engine/clock.js';
import {
  SELECTORS, clampNote, cleanName, hasWeeklyLimitText, humanDelayMs, isBlockedStatus, isCheckpointUrl, isOwnSnippet,
  isSignInUrl, parseListTimestamp, profileUrlFromHref, splitHeadline,
} from './linkedin-detect.js';
import { ConnectError, type ChannelAdapter, type ChannelError, type InboundEvent, type OutboundMessage, type SendResult } from './types.js';

export interface LinkedinDeps {
  /** Callum's data folder; the signed-in browser profile lives in `linkedin-profile` inside it. */
  dataDir: string;
  /** Run the working browser without a window. Default true. Signing in always shows a window. */
  headless?: boolean;
  /** Show a window for sign-in (default true). Only tests without a display turn this off. */
  loginHeaded?: boolean;
  launch?: typeof chromium.launchPersistentContext;
  /** Default https://www.linkedin.com. Local test sites override it. */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  clock?: Clock;
  loginTimeoutMs?: number;
  actionTimeoutMs?: number;
}

const DEFAULT_BASE = 'https://www.linkedin.com';
const PROFILE_DIR = 'linkedin-profile';
const LOOKBACK_MS = 3 * 86_400_000;
const MAX_THREADS = 10;
const MAX_SEARCH_PAGES = 5;
const MAX_CONNECTIONS = 80;
const OUTCOME_WAIT_MS = 10_000;

const CHECKPOINT_MESSAGE = 'LinkedIn is asking you to confirm it is you. Open LinkedIn in your browser, finish the check, then resume LinkedIn in Callum.';
const SIGNED_OUT_MESSAGE = 'LinkedIn signed Callum out. Connect LinkedIn again in settings.';
const WEEKLY_LIMIT_MESSAGE = "LinkedIn says you've reached the weekly invitation limit. Callum will wait before sending more invitations.";

type Fail = { ok: false; error: ChannelError };
const fail = (code: ChannelError['code'], message: string): Fail => ({ ok: false, error: { code, message } });

/** A decision made while driving a page that ends the action with a known result. */
class Stop extends Error {
  constructor(readonly result: Fail) {
    super(result.error.message);
  }
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Only elements that are on screen: closed menus keep their items in the page. */
function shown(scope: Page | Locator, selector: string): Locator {
  return scope.locator(selector).filter({ visible: true });
}

async function visible(locator: Locator, timeout: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout }).then(
    () => true,
    () => false,
  );
}

export function createLinkedinAdapter(secret: Record<string, string> | null, deps: LinkedinDeps): ChannelAdapter {
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const headless = deps.headless ?? true;
  const loginHeaded = deps.loginHeaded ?? true;
  const launch: typeof chromium.launchPersistentContext = deps.launch ?? ((dir, options) => chromium.launchPersistentContext(dir, options));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const clock = deps.clock ?? systemClock;
  const loginTimeoutMs = deps.loginTimeoutMs ?? 5 * 60_000;
  const actionTimeoutMs = deps.actionTimeoutMs ?? 20_000;
  const profileDir = join(deps.dataDir, PROFILE_DIR);

  let session: Record<string, string> | null = secret;
  let context: BrowserContext | null = null;
  let contextHeadless = headless;
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

  async function getContext(wantHeadless: boolean): Promise<BrowserContext> {
    if (context && contextHeadless !== wantHeadless) await closeContext();
    if (!context) {
      await mkdir(profileDir, { recursive: true });
      const opened = await launch(profileDir, { headless: wantHeadless, viewport: { width: 1280, height: 900 }, locale: 'en-US' });
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

  /** The checkpoint and weekly-limit decisions, made the same way before and after every action. */
  async function blocker(page: Page, status = 0): Promise<Fail | null> {
    if (isSignInUrl(page.url())) return fail('checkpoint', SIGNED_OUT_MESSAGE);
    if (isCheckpointUrl(page.url()) || isBlockedStatus(status)) return fail('checkpoint', CHECKPOINT_MESSAGE);
    if (hasWeeklyLimitText(await bodyText(page))) return fail('weekly_limit', WEEKLY_LIMIT_MESSAGE);
    return null;
  }

  async function dismissDialog(page: Page): Promise<void> {
    const close = page.locator(SELECTORS.dialogDismiss).first();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => undefined);
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
    const me = page.locator(SELECTORS.meMenu).first();
    if (await visible(me, 5000)) {
      await me.click().catch(() => undefined);
      const name = page.locator(SELECTORS.meName).first();
      if (await visible(name, 3000)) {
        const found = cleanName((await name.innerText().catch(() => '')) || '');
        await page.keyboard.press('Escape').catch(() => undefined);
        if (found) return found;
      }
    }
    const card = page.locator(SELECTORS.feedName).first();
    return (await visible(card, 1500)) ? cleanName((await card.innerText().catch(() => '')) || '') : null;
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

  /** Opens the profile and waits for its top card, so later clicks never land on "People also viewed". */
  async function openProfile(page: Page, msg: OutboundMessage): Promise<Locator> {
    const status = await open(page, profilePath(msg));
    await stopIfBlocked(page, status);
    if (status === 404) throw new Stop(fail('invalid_recipient', `${msg.to.name}'s LinkedIn page wasn't found.`));
    const top = page.locator(SELECTORS.topCard).first();
    const actions = [SELECTORS.connectButton, SELECTORS.moreButton, SELECTORS.messageButton, SELECTORS.pendingMarker].join(', ');
    await top.locator(actions).first().waitFor({ state: 'visible' });
    return top;
  }

  async function waitForInviteOutcome(page: Page): Promise<void> {
    const dialog = page.locator(SELECTORS.dialog).first();
    const deadline = Date.now() + OUTCOME_WAIT_MS;
    while (Date.now() < deadline) {
      if (!(await dialog.isVisible().catch(() => false))) return;
      await stopIfBlocked(page);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await stopIfBlocked(page);
    throw new Stop(fail('temporary', "LinkedIn didn't confirm the invitation. Callum will try again."));
  }

  async function sendInvite(page: Page, msg: OutboundMessage, step: { name: string }): Promise<SendResult> {
    step.name = 'open the profile';
    const top = await openProfile(page, msg);
    // An invitation that is already waiting is as good as one just sent.
    if ((await shown(top, SELECTORS.pendingMarker).count()) > 0) return { ok: true, externalId: null };

    step.name = 'find Connect';
    let connect = shown(top, SELECTORS.connectButton).first();
    if ((await connect.count()) === 0) {
      const more = shown(top, SELECTORS.moreButton).first();
      if ((await more.count()) > 0) {
        await more.click();
        await pause();
        connect = shown(page, SELECTORS.moreMenuConnect).first();
        if (!(await visible(connect, 3000))) await page.keyboard.press('Escape').catch(() => undefined);
      }
    }
    if ((await connect.count()) === 0) {
      const connected = (await shown(top, SELECTORS.messageButton).count()) > 0;
      throw new Stop(
        fail('invalid_recipient', connected ? `You're already connected to ${msg.to.name} on LinkedIn.` : `LinkedIn doesn't offer Connect for ${msg.to.name}.`),
      );
    }
    await connect.click();
    await pause();
    await stopIfBlocked(page);

    step.name = 'write the note';
    const note = clampNote(msg.body);
    const addNote = page.locator(SELECTORS.addNoteButton).first();
    let withNote = false;
    // A free account can run out of personalised notes; the invitation still goes without one.
    if (note && (await visible(addNote, 5000))) {
      await addNote.click();
      await pause();
      const box = page.locator(SELECTORS.noteTextarea).first();
      if (await visible(box, 5000)) {
        await box.fill(note);
        await pause();
        withNote = true;
      }
    }

    step.name = 'send the invitation';
    await page.locator(withNote ? SELECTORS.sendInviteButton : SELECTORS.sendWithoutNoteButton).first().click();
    await waitForInviteOutcome(page);
    await pause();
    await stopIfBlocked(page);
    return { ok: true, externalId: null };
  }

  async function sendDirectMessage(page: Page, msg: OutboundMessage, step: { name: string }): Promise<SendResult> {
    step.name = 'open the profile';
    const top = await openProfile(page, msg);
    step.name = 'find Message';
    const message = shown(top, SELECTORS.messageButton).first();
    if ((await message.count()) === 0) {
      throw new Stop(fail('invalid_recipient', `You're not connected to ${msg.to.name} on LinkedIn yet, so Callum can't message them.`));
    }
    await message.click();
    await pause();
    await stopIfBlocked(page);

    step.name = 'write the message';
    const composer = page.locator(SELECTORS.composer).first();
    if (!(await visible(composer, 10_000))) {
      throw new Stop(fail('invalid_recipient', `LinkedIn won't let you message ${msg.to.name} directly.`));
    }
    await typeInto(page, composer, msg.body);
    await pause();

    step.name = 'send the message';
    await page.locator(SELECTORS.composerSend).first().click();
    const deadline = Date.now() + OUTCOME_WAIT_MS;
    while ((await composer.innerText().catch(() => '')).trim() !== '') {
      if (Date.now() > deadline) throw new Stop(fail('temporary', "LinkedIn didn't confirm the message. Callum will try again."));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await pause();
    await stopIfBlocked(page);
    return { ok: true, externalId: null };
  }

  async function collectAccepted(page: Page, at: string): Promise<InboundEvent[]> {
    await page.locator(SELECTORS.connectionLink).first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => undefined);
    const hrefs = await page.locator(SELECTORS.connectionLink).evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    const urls = new Set<string>();
    for (const href of hrefs) {
      const profile = profileUrlFromHref(href);
      if (profile) urls.add(profile);
      if (urls.size >= MAX_CONNECTIONS) break;
    }
    return [...urls].map((linkedinUrl) => ({ type: 'accepted' as const, linkedinUrl, at }));
  }

  async function collectReplies(page: Page, since: Date, now: Date): Promise<InboundEvent[]> {
    await page.locator(SELECTORS.conversation).first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => undefined);
    const rows = await page.locator(SELECTORS.conversation).evaluateAll(
      (els, sel) =>
        els.map((el) => ({
          href: el.querySelector(sel.link)?.getAttribute('href') ?? '',
          name: el.querySelector(sel.name)?.textContent ?? '',
          snippet: el.querySelector(sel.snippet)?.textContent ?? '',
          time: el.querySelector(sel.time)?.textContent ?? '',
        })),
      { link: SELECTORS.conversationLink, name: SELECTORS.conversationName, snippet: SELECTORS.conversationSnippet, time: SELECTORS.conversationTime },
    );
    const events: InboundEvent[] = [];
    let opened = 0;
    for (const row of rows) {
      if (opened >= MAX_THREADS) break;
      if (!row.href || isOwnSnippet(row.snippet)) continue;
      const stamp = parseListTimestamp(row.time, now);
      if (!stamp) continue;
      const at = new Date(Math.min(stamp.getTime(), now.getTime()));
      if (at.getTime() < since.getTime()) continue;

      opened++;
      const threadPath = new URL(row.href, baseUrl).pathname;
      await open(page, threadPath);
      const blocked = await blocker(page);
      if (blocked) return events;
      const profile = page.locator(SELECTORS.threadProfileLink).first();
      await profile.waitFor({ state: 'attached', timeout: 5000 }).catch(() => undefined);
      const linkedinUrl = profileUrlFromHref((await profile.getAttribute('href').catch(() => null)) ?? '');
      const texts = await page.locator(SELECTORS.threadMessage).evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
      const text = texts.filter(Boolean).at(-1) ?? row.snippet.trim();
      if (!linkedinUrl || !text) continue;
      const key = `${threadPath}:${hash(text)}`;
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
          throw new ConnectError("Couldn't open the browser Callum uses for LinkedIn.");
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
          identity = await withPage(ctx, async (page) => {
            await page.goto(url('/login'), { waitUntil: 'domcontentloaded' });
            try {
              await page.waitForURL((u) => new URL(u).pathname.startsWith('/feed'), { timeout: loginTimeoutMs });
            } catch {
              throw new ConnectError("LinkedIn sign-in didn't finish in 5 minutes. Connect LinkedIn again when you're ready.");
            }
            await page.waitForLoadState('domcontentloaded').catch(() => undefined);
            return readName(page);
          });
          // Keep the session cookie in the secret so the working browser can restore it if its profile loses it.
          const cookie = (await ctx.cookies(baseUrl)).find((c) => c.name === 'li_at');
          stored = cookie ? { liAt: cookie.value } : { session: 'browser' };
          // The sign-in window has done its job; the next action reopens the same profile without a window.
          if (showWindow) await closeContext();
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
          if (step.name === 'open the browser') return fail('temporary', "Couldn't open the browser Callum uses for LinkedIn. Callum will try again.");
          const reason = err instanceof Error ? (err.message.split('\n')[0] ?? '') : '';
          return fail('unknown', `Callum couldn't ${step.name} on LinkedIn. LinkedIn may have changed its page. ${reason}`.trim());
        }
      });
    },

    poll(since) {
      return exclusive(async () => {
        if (!session) throw new ConnectError('auth');
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
        if (!session) throw new ConnectError('auth');
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
            const settled = page.locator(`${SELECTORS.searchResult}, ${SELECTORS.searchEmpty}`).first();
            if (!(await visible(settled, 8000))) break;
            const rows = await page.locator(SELECTORS.searchResult).evaluateAll(
              (els, sel) =>
                els.map((el) => {
                  // The first profile link is the result's own person; later ones are mutual connections and the like.
                  const own = el.querySelector(sel.link)?.getAttribute('href') ?? '';
                  const links = [...el.querySelectorAll(sel.link)].filter((a) => a.getAttribute('href') === own);
                  return {
                    href: own,
                    names: [...links.flatMap((a) => [...a.querySelectorAll(sel.name)]), ...links].map((n) => n.textContent ?? ''),
                    headline: el.querySelector(sel.headline)?.textContent ?? '',
                  };
                }),
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
