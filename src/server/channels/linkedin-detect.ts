import { normalizeLinkedinUrl } from '../db/handles.js';

/** Where LinkedIn sends a browser that must prove who it is, or that is not signed in. */
export function isCheckpointUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return /^\/(?:checkpoint\/|authwall|uas\/login|login(?:\/|$))/.test(path) || /(?:^|\/)challenge(?:\/|$)/.test(path);
}

/** LinkedIn's status for "we think you are a bot". */
export function isBlockedStatus(status: number): boolean {
  return status === 999;
}

/** The page LinkedIn shows when the session has ended, as opposed to a check it wants the user to pass. */
export function isSignInUrl(url: string): boolean {
  try {
    return /^\/(?:authwall|uas\/login|login(?:\/|$))/.test(new URL(url).pathname.toLowerCase());
  } catch {
    return false;
  }
}

export function hasWeeklyLimitText(text: string): boolean {
  return /weekly\s+invitation\s+limit|reached\s+the\s+weekly\s+limit/i.test(text);
}

const NOTE_MAX = 280;

/** Cuts a connection note to LinkedIn's limit at a sentence end when that keeps most of it, else at a word end. */
export function clampNote(text: string): string {
  const note = text.trim();
  if (note.length <= NOTE_MAX) return note;
  const head = note.slice(0, NOTE_MAX);
  const fits = /\s/.test(note.charAt(NOTE_MAX));
  let sentenceEnd = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) sentenceEnd = m.index + 1;
  if (sentenceEnd >= NOTE_MAX / 2) return head.slice(0, sentenceEnd);
  const lastSpace = head.search(/\s\S*$/);
  const cut = fits || lastSpace <= 0 ? head : head.slice(0, lastSpace);
  return cut.replace(/[\s,;:\-–—]+$/, '');
}

/** Text of a page that LinkedIn shows for a profile that is gone or hidden. */
export function isUnavailableProfileText(text: string): boolean {
  return /this page doesn['\u2019]t exist|profile (?:is )?(?:not available|unavailable)|this profile is not available/i.test(text);
}

/** The names a chat window header may show for a profile: the full name, then without credentials such as ", MBA". */
export function headerNameCandidates(profileName: string): string[] {
  const full = normalizeText(profileName);
  const short = normalizeText(full.split(/[,(|]/)[0] ?? '');
  return [...new Set([full, short].filter(Boolean))];
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A thread preview is shortened with an ellipsis, so it matches when it is the start of the open thread's last message. */
export function snippetMatches(snippet: string, lastMessage: string): boolean {
  const preview = normalizeText(snippet.replace(/^\s*you\s*:/i, '')).replace(/(?:\u2026|\.{3})$/, '').trim();
  if (!preview) return true;
  return normalizeText(lastMessage).toLowerCase().startsWith(preview.toLowerCase());
}

export function humanDelayMs(random: () => number): number {
  return 4000 + Math.floor(random() * 7000);
}

/** A profile link as LinkedIn shows it (relative or absolute) in Callum's canonical form. */
export function profileUrlFromHref(href: string): string | null {
  try {
    return normalizeLinkedinUrl(new URL(href, 'https://www.linkedin.com').pathname);
  } catch {
    return null;
  }
}

/** "Head of Payments at Okopay" -> role and company; a headline with no company stays whole as the role. */
export function splitHeadline(headline: string): { role: string | null; company: string | null } {
  const text = headline.replace(/\s+/g, ' ').trim();
  if (!text) return { role: null, company: null };
  const at = Math.max(text.lastIndexOf(' at '), text.lastIndexOf(' @ '));
  if (at > 0) {
    const role = text.slice(0, at).trim();
    const company = text.slice(at + 3).trim();
    if (role && company) return { role, company };
  }
  return { role: text, company: null };
}

/** A name from search or a thread, without degree badges ("• 2nd") or presence text. Null when LinkedIn hides it. */
export function cleanName(raw: string): string | null {
  const name = raw
    .split('\n')[0]
    ?.replace(/^\s*status is \w+\s*/i, '')
    .replace(/\s*•.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A link's text repeats the name once for sighted users and once for screen readers.
    .replace(/^(.{2,}?)\s?\1$/, '$1');
  if (!name || /^linkedin member$/i.test(name) || /^\d+(?:st|nd|rd|th)\+?$/i.test(name)) return null;
  return name;
}

/** In the messaging list the preview starts with "You:" when the user wrote the last message. */
export function isOwnSnippet(snippet: string): boolean {
  return /^\s*you\s*:/i.test(snippet);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The messaging list shows "10:32 AM" today, "Sun" within the week, "Oct 28" or "Oct 28, 2025" otherwise.
 * Dates are read in the browser's local time, which is the process time zone. Only the clock form is
 * exact; a day-only label means "some time that day", so it is placed at the end of that day. Callers
 * cap it at the present and treat it as "not earlier than".
 */
export function parseListTimestamp(text: string, now: Date): Date | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 23, 59, 59);

  const clock = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(t);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[3]) hour = (hour % 12) + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, Number(clock[2]));
  }
  if (/^today$/i.test(t)) return day(0);
  if (/^yesterday$/i.test(t)) return day(1);

  const weekday = WEEKDAYS.indexOf(t.slice(0, 3).toLowerCase());
  if (weekday >= 0 && /^[a-z]+\.?$/i.test(t)) {
    const back = ((now.getDay() - weekday + 6) % 7) + 1;
    return day(back);
  }

  const date = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(t);
  const month = date ? MONTHS.indexOf((date[1] ?? '').toLowerCase()) : -1;
  if (date && month >= 0) {
    const explicit = date[3] ? Number(date[3]) : null;
    let result = new Date(explicit ?? now.getFullYear(), month, Number(date[2]), 23, 59, 59);
    if (explicit === null && result.getTime() > now.getTime()) result = new Date(now.getFullYear() - 1, month, Number(date[2]), 23, 59, 59);
    return result;
  }
  return null;
}

/**
 * Every selector the LinkedIn adapter uses, in one place, so a markup change is fixed here.
 * Each entry is a list of alternatives, tried in order, most specific first: the first one that
 * finds something visible wins. (A CSS comma list would be a union in page order, and a broad
 * alternative could win over the specific one.) Prefer aria-labels; class names are older markup.
 */
export const SELECTORS = {
  // Signed-in header and the "Me" menu that holds the user's name.
  meMenu: ['button.global-nav__primary-link-me-menu-trigger', 'button[aria-label^="Me" i]', '.global-nav__me button'],
  meName: ['.global-nav__me-content .t-bold', '.global-nav__me-content h3', '.artdeco-dropdown__content .t-16.t-bold'],
  feedName: ['.feed-identity-module__actor-meta .t-16', '.profile-card-member-details h3', '[data-view-name="profile-card-name"]'],

  // Profile page. Everything is scoped to the top card so "People also viewed" is never clicked.
  topCard: ['main section:has(h1)', 'section:has(h1)'],
  profileName: ['h1'],
  connectButton: ['[aria-label^="Invite"][aria-label$="to connect"]', 'button:text-is("Connect")', 'a:text-is("Connect")'],
  moreButton: ['button[aria-label="More actions"]', 'button[aria-label^="More actions" i]', 'button[id$="profile-overflow-action"]'],
  moreMenuConnect: ['[role="menu"] [aria-label^="Invite"][aria-label$="to connect"]', '.artdeco-dropdown__content [aria-label^="Invite"][aria-label$="to connect"]'],
  pendingMarker: ['[aria-label^="Pending"]', 'button:text-is("Pending")'],
  followButton: ['[aria-label^="Follow"]', 'button:text-is("Follow")'],
  messageButton: ['[aria-label^="Message"]', 'a:text-is("Message")', 'button:text-is("Message")'],

  // Invitation dialog.
  dialog: ['[role="dialog"]', '.artdeco-modal'],
  addNoteButton: ['[role="dialog"] button[aria-label="Add a note"]', '[role="dialog"] button:text-is("Add a note")'],
  noteTextarea: ['[role="dialog"] textarea#custom-message', '[role="dialog"] textarea[name="message"]', '[role="dialog"] textarea'],
  sendInviteButton: ['[role="dialog"] button[aria-label="Send invitation"]', '[role="dialog"] button[aria-label="Send now"]', '[role="dialog"] button:text-is("Send")'],
  sendWithoutNoteButton: ['[role="dialog"] button[aria-label="Send without a note"]', '[role="dialog"] button[aria-label="Send now"]', '[role="dialog"] button:text-is("Send without a note")'],
  dialogDismiss: ['[role="dialog"] button[aria-label="Dismiss"]', '[role="dialog"] button:text-is("Got it")', '[role="dialog"] button:text-is("Close")'],
  premiumUpsell: ['[role="dialog"]:has-text("Premium")'],
  // Where LinkedIn shows notices such as the weekly limit. Only these are read for limit text.
  notices: ['[role="dialog"]', '[role="alert"]', '.artdeco-toast-item'],

  // Message bubbles (the chat windows at the bottom of the page) and their composer.
  messageBubble: ['.msg-overlay-conversation-bubble'],
  bubbleHeader: ['.msg-overlay-bubble-header', 'header'],
  bubbleClose: ['button[aria-label^="Close your conversation"]', '.msg-overlay-bubble-header__control--close-btn'],
  composer: ['div.msg-form__contenteditable[contenteditable="true"]', '[role="textbox"][aria-label^="Write a message"]'],
  composerSend: ['button.msg-form__send-button', 'button[type="submit"]:text-is("Send")'],

  // Connections page.
  connectionLink: ['.mn-connection-card__link', 'main li a[href*="/in/"]'],

  // Messaging list and an open thread. A row's link may be an anchor or a div that opens the thread on click.
  conversation: ['li.msg-conversation-listitem', 'li.msg-conversations-container__convo-item'],
  conversationLink: ['.msg-conversation-listitem__link', 'a[href*="/messaging/thread/"]'],
  conversationName: ['.msg-conversation-card__participant-names', 'h3'],
  conversationSnippet: ['.msg-conversation-card__message-snippet', '.msg-conversation-card__message-snippet-body'],
  conversationTime: ['time', '.msg-conversation-listitem__time-stamp'],
  threadPanel: ['.msg-s-message-list-container', '.msg-thread', 'main'],
  threadProfileLink: ['a.msg-thread__link-to-profile', '.msg-entity-lockup a[href*="/in/"]', '.msg-title-bar a[href*="/in/"]'],
  threadMessage: ['.msg-s-event-listitem__body'],

  // People search results.
  searchResult: ['li.reusable-search__result-container', '[data-view-name="search-entity-result-universal-template"]', 'main ul[role="list"] > li:has(a[href*="/in/"])'],
  searchEmpty: ['.search-reusable-search-no-results', '[data-view-name="search-no-results"]'],
  searchLink: ['a[href*="/in/"]'],
  searchName: ['span[aria-hidden="true"]'], // inside the result's own profile link, never a "mutual connection" link
  searchHeadline: ['.entity-result__primary-subtitle', 'div.t-14.t-black.t-normal'],
} as const satisfies Record<string, readonly string[]>;
