import type { Channel, OutKind, ReplyKind, SuggestedAction, Tone } from '../../shared/types.js';
import { type Clock, systemClock } from '../engine/clock.js';
import { clampNote } from '../channels/linkedin-detect.js';
import type { AskIntent, Classification, Writer, WriteContext } from './writer.js';

export const OFFER_PLACEHOLDER = '[WHAT YOU OFFER]';
export const CALENDAR_PLACEHOLDER = '[YOUR CALENDAR LINK]';

/** The offer as the user wrote it ("You help ..."), turned into the sender's own voice for a message body. */
export function offerSentence(offer: string | null | undefined): string {
  const raw = (offer ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').replace(/!/g, '.').trim();
  if (!raw) return `${OFFER_PLACEHOLDER}.`;
  const firstPerson = raw.replace(/(^|[.?]\s+)(You|Your)(?:('re| are|'ll|'ve|'d))?(?=\s|$)/g, (_m, lead: string, word: string, suffix?: string) => {
    if (word === 'Your') return `${lead}My`;
    const mapped = suffix === "'re" ? "'m" : suffix === ' are' ? ' am' : (suffix ?? '');
    return `${lead}I${mapped}`;
  });
  return /[.?]$/.test(firstPerson) ? firstPerson : `${firstPerson}.`;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_MS = 86_400_000;

function monthIndex(word: string): number {
  const key = word.toLowerCase().slice(0, 3);
  return MONTH_NAMES.findIndex((m) => m.startsWith(key));
}

function utcDay(y: number, m: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m && date.getUTCDate() === d ? date : null;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The first explicit date in the text: `2026-11-20`, `November 20` or `20 November` (optionally with a year).
 * Without a year it is the next such date on or after `today`.
 */
export function findDate(text: string, today: Date): string | null {
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const candidates: { index: number; y: number | null; m: number; d: number }[] = [];
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  const monthDayRe = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi');
  const dayMonthRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi');
  for (const m of text.matchAll(isoRe)) candidates.push({ index: m.index, y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) });
  for (const m of text.matchAll(monthDayRe)) candidates.push({ index: m.index, y: m[3] ? Number(m[3]) : null, m: monthIndex(m[1] ?? ''), d: Number(m[2]) });
  for (const m of text.matchAll(dayMonthRe)) candidates.push({ index: m.index, y: m[3] ? Number(m[3]) : null, m: monthIndex(m[2] ?? ''), d: Number(m[1]) });
  candidates.sort((a, b) => a.index - b.index);
  for (const c of candidates) {
    if (c.m < 0) continue;
    if (c.y !== null) {
      const date = utcDay(c.y, c.m, c.d);
      if (date) return iso(date);
      continue;
    }
    const thisYear = utcDay(today.getUTCFullYear(), c.m, c.d);
    if (thisYear && thisYear.getTime() >= t0) return iso(thisYear);
    const nextYear = utcDay(today.getUTCFullYear() + 1, c.m, c.d);
    if (nextYear) return iso(nextYear);
  }
  return null;
}

/** "back on Monday", "until Thursday", "back next week": the first such day after today. */
function findRelativeReturn(text: string, today: Date): string | null {
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const weekday = new RegExp(`\\b(?:until|till|back(?:\\s+(?:on|by|in the office on|at work on))?|return(?:ing|s)?(?:\\s+on)?)\\s+(?:next\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i').exec(text);
  const nextWeek = /\b(?:back|until|till|return(?:ing)?)\s+(?:the\s+)?(?:start of\s+|beginning of\s+)?next week\b/i.exec(text);
  const dayWord = weekday?.[1];
  if (dayWord && (!nextWeek || weekday.index < nextWeek.index)) {
    const target = WEEKDAYS.indexOf(dayWord.toLowerCase());
    const diff = ((target - today.getUTCDay() + 6) % 7) + 1; // strictly after today
    return iso(new Date(t0 + diff * DAY_MS));
  }
  if (nextWeek) {
    const diff = ((1 - today.getUTCDay() + 6) % 7) + 1; // next Monday
    return iso(new Date(t0 + diff * DAY_MS));
  }
  return null;
}

const OPT_OUT_QUOTE = /if this isn['’]t for you, just reply stop and i won['’]t write again\.?/gi;

/** Drops quoted history and our own opt-out line, so only what the person wrote is classified. */
export function stripQuoted(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*on .{5,200}\bwrote:\s*$/i.test(line) || /^\s*-{2,}\s*original message\s*-{2,}/i.test(line) || /^\s*_{5,}\s*$/.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').replace(OPT_OUT_QUOTE, ' ').replace(/[‘’]/g, "'").trim();
}

const STOP_RE = /\b(?:unsubscribe|opt(?:ing)?[ -]?out|remove me|take me off|do not (?:contact|email|e-mail|message|write)|don'?t (?:contact|email|e-mail|message|write)|stop (?:emailing|e-mailing|messaging|writing|contacting|sending|following up))\b/i;
/** A bare "stop" is a request to stop, unless it is "stop by" / "stop in". */
const STOP_WORD_RE = /\bstop\b(?!\s+(?:by|in|over|off|at)\b)/i;
const HOSTILE_RE = /\b(?:spam(?:mer|ming)?|scam(?:mer|ming)?|go away|leave me alone|harass(?:ing|ment)?|report(?:ing|ed)? you|fuck\w*|shit\w*|bullshit|asshole|bastard|idiot|moron|piss(?:ed)? off|f\*+k|wtf|stupid)\b/i;
const OOO_RE = new RegExp(
  [
    '\\booo\\b', 'out of (?:the )?office', 'out-of-office',
    'on (?:annual |maternity |paternity |parental |medical |sick |extended )?leave',
    'on (?:vacation|holiday|sabbatical|a break)', 'currently (?:out|away|travell?ing)',
    'away (?:until|till|from|on)', 'auto-?\\s?reply', 'automatic reply', 'automated (?:reply|response)',
    'back (?:in the office|at work|at my desk)', 'back (?:on|by) (?:\\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|' + MONTH_RE + ')',
    'back next week', 'returning (?:on|to the office)',
  ].join('|'),
  'i',
);
const NOT_INTERESTED_RE = /\b(?:not interested|no,? thank(?:s| you)|not (?:a )?(?:good )?fit|no need|not (?:looking|in the market)|not for (?:us|me)|we(?:'re| are) (?:all )?set|already (?:have|use|work with)|not a priority|(?:don'?t|do not|no) (?:have )?(?:the )?time for|not relevant|no interest|i'?ll pass|we'?ll pass|pass on this)\b/i;
const NOT_NOW_RE = /\b(?:not (?:right |just )?now|not (?:at the moment|this (?:week|month|quarter|year))|not until|bad timing|next (?:month|quarter|year|week)|circle back|(?:reach|get|come|check) back (?:to me |in )|later this|in (?:a |a few |a couple of |few |couple of |\d+ )?(?:weeks?|months?)|after (?:the )?(?:holidays?|summer|new year|q[1-4]|our (?:launch|audit|fundraise)|christmas)|try (?:me )?again|ping me (?:in|again|next)|touch base (?:in|next)|busy (?:right now|at the moment|with))\b/i;
const BOOK_RE = /\b(?:calls?|chat|meet(?:ing)?|time|calendar|demo|catch up|zoom|google meet|schedule|let'?s (?:talk|speak|connect)|(?:talk|speak) (?:soon|more|then)|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
const QUESTION_RE = /(?:\?|(?:^|[.!]\s+|\n)(?:how|what|what'?s|why|who|which|when|where|can you|could you|do you|does it|does this|is it|is this|are you|are there|would you|tell me (?:more|about)|i'?d like to know|send me (?:the )?(?:pricing|price|details|more info|info))\b)/i;
const NOT_NAMES = new Set([
  'I', 'We', 'You', 'The', 'Our', 'My', 'Your', 'Us', 'Me', 'Him', 'Her', 'Them', 'This', 'That', 'It', 'If', 'Please', 'Thanks', 'Thank', 'Hi', 'Hello', 'Hey',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Head', 'Director', 'Manager', 'Team', 'CEO', 'CFO', 'CTO', 'COO',
  'Finance', 'Support', 'Sales', 'Someone', 'Anyone', 'Marketing', 'Operations', 'Ops', 'Admin', 'Info', 'Sir', 'Madam', 'Best', 'Regards', 'Kind',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Mr', 'Mrs', 'Ms', 'Dr',
]);
const REFERRAL_VERB_RE = /\b(?:talk(?:ing)? to|speak(?:ing)? (?:to|with)|reach(?:ing)? out to|get in touch with|(?:please )?contact|loop(?:ed|ing)? in|cc'?(?:ing|d)|introduc(?:e|ing) you to|point(?:ing)? you to|connect(?:ing)? you (?:with|to)|forward(?:ed|ing)? (?:this |it |your (?:note|email|message) )?to|pass(?:ed|ing)? (?:this |it )?(?:on )?to|(?:right|best) person (?:is|would be|to (?:talk|speak) to is)|try(?:ing)?|ask(?:ing)?|e-?mail(?:ing)?|write to)\b/gi;
const NAME_RE = /^[ \t,:-]*((?:[A-Z][a-z]+(?:['-][A-Za-z]+)*)(?:[ \t]+[A-Z][a-z]+(?:['-][A-Za-z]+)*){0,2})/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function titleCase(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word;
}

function sentenceAround(text: string, index: number): string {
  const boundary = /[.?!](?=\s|$)|\n/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    if (m.index < index) start = m.index + 1;
    else {
      end = m.index + m[0].length;
      break;
    }
  }
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function findReferral(text: string, ownEmail: string | null): Classification['referral'] {
  const ignore = (email: string): boolean => email.toLowerCase() === (ownEmail ?? '').toLowerCase() || /^(?:no-?reply|donotreply)@/i.test(email);
  for (const verb of text.matchAll(REFERRAL_VERB_RE)) {
    const from = verb.index + verb[0].length;
    const rest = text.slice(from);
    const nameWords = NAME_RE.exec(rest)?.[1]?.split(/[ \t]+/) ?? [];
    const clean: string[] = [];
    for (const w of nameWords) {
      if (NOT_NAMES.has(w)) break;
      clean.push(w);
    }
    if (clean.length > 0) {
      const name = clean.join(' ');
      const after = rest.slice((NAME_RE.exec(rest)?.[0] ?? '').length);
      const near = EMAIL_RE.exec(after.slice(0, 80))?.[0] ?? EMAIL_RE.exec(text)?.[0] ?? null;
      return { name, email: near && !ignore(near) ? near : null, context: sentenceAround(text, verb.index) };
    }
    const direct = /^[\s,:]*[<(]?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(rest)?.[1];
    if (direct && !ignore(direct)) {
      const local = direct.split('@')[0] ?? direct;
      const name = local.split(/[._+-]+/).filter((p) => /^[a-z]{2,}$/i.test(p)).slice(0, 2).map(titleCase).join(' ');
      if (name) return { name, email: direct, context: sentenceAround(text, verb.index) };
    }
  }
  return null;
}

const suggestedFor: Record<ReplyKind, SuggestedAction> = {
  stop: 'close', hostile: 'close', out_of_office: 'snooze', referral: 'reply', not_interested: 'close', not_now: 'snooze', question: 'reply', interested: 'reply',
};

function result(kind: ReplyKind, extra: Partial<Classification> = {}, suggested: SuggestedAction = suggestedFor[kind]): Classification {
  return { kind, suggested, returnDate: null, referral: null, language: 'en', ...extra };
}

/** Deterministic reply reading: ordered phrase rules, the same ones every time. */
export function classifyReply(rawText: string, today: Date, ownEmail: string | null = null): Classification {
  const text = stripQuoted(rawText);
  // "it went to my spam folder" is not a complaint
  const hostileText = text.replace(/\b(?:in|into|to|from|via|my|the)\s+(?:my\s+|the\s+)?(?:spam|junk)(?:\s+(?:folder|box|filter))?\b/gi, ' ');
  if (STOP_RE.test(text) || STOP_WORD_RE.test(text)) return result('stop');
  if (HOSTILE_RE.test(hostileText)) return result('hostile');
  if (OOO_RE.test(text)) return result('out_of_office', { returnDate: findDate(text, today) ?? findRelativeReturn(text, today) });
  const referral = findReferral(text, ownEmail);
  if (referral) return result('referral', { referral });
  if (NOT_INTERESTED_RE.test(text) || /^\s*no[\s.,]*$/i.test(text)) return result('not_interested');
  if (NOT_NOW_RE.test(text)) return result('not_now', { returnDate: findDate(text, today) });
  if (BOOK_RE.test(text)) return result('interested', {}, 'book');
  if (QUESTION_RE.test(text)) return result('question');
  return result('interested');
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'your', 'their', 'our', 'its', 'my', 'all', 'any', 'more', 'less', 'some', 'every', 'each', 'of', 'off', 'out', 'on', 'in', 'to', 'for', 'from',
  'by', 'at', 'as', 'and', 'or', 'so', 'that', 'which', 'without', 'with', 'into', 'over', 'under', 'using', 'while', 'than', 'it', 'them', 'up', 'down',
]);
const NAME_TRIGGER_RE = /\b(?:with|take|takes|taking|run|runs|running|handle|handles|manage|manages|automate|automates|build|builds|offer|offers|provide|provides|sell|sells|make|makes|design|designs|deliver|delivers|do|does|set up|sets up)\s+((?:[a-z][a-z&'-]*\s*){1,8})/gi;

/** The most specific noun phrase after with/take/run/…, title-cased, stop words dropped. */
export function nameFromOffer(offer: string): string {
  const text = offer.replace(/[‘’]/g, "'");
  for (const m of text.matchAll(NAME_TRIGGER_RE)) {
    const words: string[] = [];
    for (const w of (m[1] ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      if (STOPWORDS.has(w)) {
        if (words.length === 0) continue; // leading "the", "your", ...
        break;
      }
      words.push(w);
      if (words.length === 2) break;
    }
    if (words.length > 0) return words.map(titleCase).join(' ');
  }
  return 'My project';
}

const BANG = /!/g;

export class TemplateWriter implements Writer {
  constructor(private readonly clock: Clock = systemClock) {}

  async write(kind: OutKind, ctx: WriteContext): Promise<{ subject: string | null; body: string }> {
    const first = ctx.person.firstName;
    const company = ctx.person.company?.trim() || 'your team';
    const offer = offerSentence(ctx.project.offer);
    let body: string;
    switch (kind) {
      case 'hello':
        body = helloBody(ctx.project.tone, first, company, offer);
        break;
      case 'invite':
        body = clampNote(`Hi ${first}, ${offer} Would love to connect.`);
        break;
      case 'thanks':
        body = `Thanks for connecting, ${first}. ${offer} Would a quick chat be useful?`;
        break;
      case 'follow_up':
        body = ctx.person.touches >= 2
          ? `Hi ${first}, last note from me. If the timing is wrong, no problem at all.`
          : `Hi ${first}, following up on my note. Happy to share how this could work for ${company}.`;
        break;
      case 'reply':
        body = `Thanks, ${first}. Happy to share more. Would a short call this week work?`;
        break;
      case 'booking':
        body = `Great. Here's my calendar, pick any time that suits you: ${ctx.project.calendarUrl?.trim() || CALENDAR_PLACEHOLDER}`;
        break;
      case 'close':
        body = `Thanks for letting me know, ${first}. I won't follow up. All the best with ${company}.`;
        break;
    }
    return { subject: subjectFor(kind, ctx), body: body.replace(BANG, '.') };
  }

  async classify(text: string, ctx: WriteContext): Promise<Classification> {
    return classifyReply(text, this.clock.now(), ctx.person.email);
  }

  async offerLine(siteText: string, _domain: string): Promise<string> {
    const text = siteText.replace(/\s+/g, ' ').replace(/!/g, '.').trim();
    if (!text) return OFFER_PLACEHOLDER;
    // The meta description (or first sentence) is the best statement of what the business does.
    const sentence = /^(.{15,300}?[.?])(?:\s|$)/.exec(text)?.[1] ?? (text.length <= 300 ? text : '');
    const m = /^we\s+help\s+(.+?)[.?]*$/i.exec(sentence.trim());
    return m?.[1] ? `You help ${m[1].trim()}.` : OFFER_PLACEHOLDER;
  }

  async projectName(offer: string): Promise<string> {
    return nameFromOffer(offer);
  }

  async parseAsk(text: string, people: { id: number; name: string }[]): Promise<AskIntent> {
    return parseAskText(text, people);
  }
}

function helloBody(tone: Tone, first: string, company: string, offer: string): string {
  switch (tone) {
    case 'direct':
      return `Hi ${first}, ${offer} Worth 15 minutes next week?`;
    case 'playful':
      return `Hi ${first}, quick question: who at ${company} would get the most out of this? ${offer}`;
    case 'warm':
      return `Hi ${first}, I've been following what ${company} is building. ${offer} Would a quick chat be useful?`;
  }
}

function subjectFor(kind: OutKind, ctx: WriteContext): string | null {
  if (ctx.channel !== 'email') return null;
  const hello = `Quick question, ${ctx.person.firstName}`;
  switch (kind) {
    case 'hello':
      return hello;
    case 'follow_up':
    case 'reply':
    case 'booking':
    case 'close': {
      const original = ctx.history.find((m) => m.direction === 'out' && m.subject)?.subject?.trim() || hello;
      return /^re:/i.test(original) ? original : `Re: ${original}`;
    }
    default:
      return null;
  }
}

const CHANNEL_WORDS: [RegExp, Channel][] = [[/\be-?mail|mail\b/i, 'email'], [/\blinked-?in\b/i, 'linkedin'], [/\b(?:x|twitter)\b/i, 'x']];

function channelIn(text: string): Channel | null {
  for (const [re, channel] of CHANNEL_WORDS) if (re.test(text)) return channel;
  return null;
}

function clampCount(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(n, 50);
}

function firstNameOf(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** People whose first name (or full name) appears as a word in the text, in the order they are named. */
function peopleNamedIn(text: string, people: { id: number; name: string }[]): number[] {
  const lower = text.toLowerCase();
  const hits: { id: number; at: number }[] = [];
  for (const p of people) {
    const first = firstNameOf(p.name);
    if (!first) continue;
    const m = new RegExp(`(?:^|[^\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').exec(lower);
    if (m) hits.push({ id: p.id, at: m.index });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.id);
}

export function parseAskText(rawText: string, people: { id: number; name: string }[]): AskIntent {
  const text = rawText.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text) return { intent: 'unknown' };
  const body = text.replace(/^(?:hey |hi |ok(?:ay)?,? )?(?:callum[,:]?\s+)?(?:please |could you |can you |would you |will you )?/i, '').replace(/\s+please[.?!]*$/i, '');

  if (/^why\b/i.test(body)) return { intent: 'why' };

  const tone = /\b(warmer|warm|direct|playful)\s+tone\b|\b(?:sound|be|write|make (?:it|them|the notes))\s+(?:a bit |a little |much )?(warmer|more direct|more playful|more casual)\b|\btone\b.*\b(warm|direct|playful)\b/i.exec(body);
  if (tone) {
    const word = (tone[1] ?? tone[2] ?? tone[3] ?? '').toLowerCase();
    const t: Tone = word.includes('direct') ? 'direct' : word.includes('playful') || word.includes('casual') ? 'playful' : 'warm';
    return { intent: 'tone', tone: t };
  }

  const pause = /^(?:pause|hold off on|hold off|stop|halt)\b(.*)$/i.exec(body);
  if (pause) {
    const channel = channelIn(pause[1] ?? '');
    if (channel) return { intent: 'pause', channel };
  }
  const resume = /^(?:resume|unpause|restart|continue|start)\b(.*)$/i.exec(body);
  if (resume) {
    const channel = channelIn(resume[1] ?? '');
    if (channel) return { intent: 'resume', channel };
  }

  const sw = /^(?:switch|move|change)\s+(.+?)\s+(?:over\s+)?to\s+(?:use\s+)?(e-?mail|linked-?in|twitter|x)\b/i.exec(body);
  if (sw) {
    const channel = channelIn(sw[2] ?? '');
    const personIds = peopleNamedIn(sw[1] ?? '', people);
    if (channel && personIds.length > 0) return { intent: 'switch', personIds, channel };
  }

  const like = /\b(?:more|people|others|ones?)\s+(?:people\s+)?like\s+([\p{L}'-]+)/iu.exec(body);
  if (like) {
    const likeId = peopleNamedIn(like[1] ?? '', people)[0];
    if (likeId !== undefined) return { intent: 'find', likePersonId: likeId, query: null, count: clampCount(/\b(\d+)\b/.exec(body)?.[1]) };
  }

  const find = /^(?:find|get|look for|search for|add)\s+(?:(\d+)\s+)?(?:more\s+)?(.+)$/i.exec(body);
  if (find?.[2] && !/^(?:warm|why|who|what|how|which|when|where)\b/i.test(find[2])) {
    return { intent: 'find', likePersonId: null, query: find[2].replace(/[.?!]+$/, '').trim(), count: clampCount(find[1]) };
  }

  if (/\b(?:warm|warming up|warmed up)\b/i.test(body)) return { intent: 'warm' };
  if (/\bwhy\b/i.test(body)) return { intent: 'why' };
  return { intent: 'unknown' };
}
