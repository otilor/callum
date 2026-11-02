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

const LEADING_FUNCTION_WORDS = new Set(['we', 'our', 'my', 'the', 'a', 'an', 'this', 'helping', 'providing', 'offering', 'building', 'making']);

/**
 * The offer where it follows "Hi Kemi, " on the same sentence. An offer that opens with a plain
 * function word ("We help ...") starts in lower case; a proper noun, acronym or product word ("Oko Pay builds",
 * "AI-powered", "Payroll for ...") keeps its capital.
 */
export function inlineOffer(offer: string): string {
  const first = /^([A-Z][a-z]*)(?![A-Za-z'\u2019-])/.exec(offer)?.[1];
  return first && LEADING_FUNCTION_WORDS.has(first.toLowerCase()) ? first.toLowerCase() + offer.slice(first.length) : offer;
}

const MONTH_RE = [
  'jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'june?', 'july?', 'aug(?:ust)?', 'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?',
  // French, German, Spanish, Portuguese
  'janvier', 'f[\\u00e9e]vr(?:ier)?', 'mars', 'avril', 'mai', 'juin', 'juillet', 'ao[u\\u00fb]t', 'septembre', 'octobre', 'novembre', 'd[\\u00e9e]cembre',
  'januar', 'februar', 'm[\\u00e4a]rz', 'juni', 'juli', 'oktober', 'dezember',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  'janeiro', 'fevereiro', 'mar[\\u00e7c]o', 'maio', 'junho', 'julho', 'setembro', 'outubro', 'dezembro',
].join('|');
const MONTH_BY_PREFIX: Record<string, number> = {
  jan: 0, ene: 0, feb: 1, fev: 1, mar: 2, apr: 3, avr: 3, abr: 3, mai: 4, may: 4, jun: 5, jul: 6, aug: 7, aou: 7, ago: 7,
  sep: 8, set: 8, oct: 9, okt: 9, out: 9, nov: 10, dec: 11, dez: 11, dic: 11,
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_MS = 86_400_000;

function monthIndex(word: string): number {
  const w = word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (w === 'juin') return 5;
  if (w === 'juillet') return 6;
  return MONTH_BY_PREFIX[w.slice(0, 3)] ?? -1;
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
  const dayMonthRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er|\\.)?\\s+(?:of\\s+|de\\s+|do\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi');
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
  if (/\b(?:back|until|till|return(?:ing)?)\s+tomorrow\b/i.test(text)) return iso(new Date(t0 + DAY_MS));
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

// ---- reading a reply -------------------------------------------------------------------------
// Three views of a message, from most to least trusting:
//   quoted-free  `stripQuoted(text)`: what they typed, signature included. Opt-outs are searched here, line by line,
//                so nothing a person wrote can be hidden by signature handling.
//   body         `stripSignature(quoted-free)`: footer noise removed, used for out-of-office, hostile and the rest.
//   engagement   words that show a real person answering us (yes, call me, a question). They veto out-of-office.

const GREETING_RE = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|hola|ol[aá]|bonjour|hallo)\b[^.!?]*$/i;
const BARE_THANKS_RE = /^(?:thanks|thank you|many thanks|thanks a lot|thank you so much|cheers|merci|gracias|danke|obrigad[oa])[\s.!,]*$/i;
const SIGN_OFF_RE = /^\s*(?:best|(?:(?:best|kind|warm|many)\s+)?(?:regards|wishes|thanks|thank you|cheers|sincerely)|cordialement|saludos|mit freundlichen gr[üu](?:ß|ss)en|atenciosamente)\s*[,.!]?\s*$/i;
const CLIENT_FOOTER_RE = /^\s*(?:sent from (?:my|outlook|mail|yahoo|gmail)\b.*|get outlook for .*|envoy[ée] de mon .*|enviado desde mi .*|enviado do meu .*|gesendet von meinem .*)$/i;
const DASH_RE = /^\s*(?:-{2,}|—+|–+|_{2,})\s*$/;
const PS_RE = /^\s*p\.?\s?s\.?(?=\s|:|$)/i;
const NOT_A_NAME_RE = /^(?:i|we|you|please|let|will|can|could|call|send|yes|no|sure|thanks?|thank|happy|not|stop|unsubscribe|remove|take|do|don'?t|never|kindly|leave|opt|cancel|delete|quit)\b/i;

/** A line that can follow a sign-off: a name, a title, a company, a phone number. Never a sentence. */
function looksLikeNameLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.split(/\s+/).length > 6) return false;
  if (!/^[A-Z0-9+<(]/.test(t) || /[!?]/.test(t) || NOT_A_NAME_RE.test(t)) return false;
  return !/[a-z]\.$/.test(t) || t.split(/\s+/).length <= 3;
}

/**
 * Where a closing signature starts, or `lines.length` when there is none. A sign-off ("Best,", "Thanks,", "--",
 * "Sent from my iPhone") starts a signature only when there is real content above it (not just a greeting or a
 * bare thanks) and, for a sign-off word, the next line looks like a name or title. `strict` also wants no more than
 * 6 short lines to follow, so a long reply is never mistaken for a signature; the loose form (used to decide where
 * the closing block and its footers begin) lets a long legal footer belong to the signature.
 */
function findSignatureStart(lines: string[], strict: boolean): number {
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const footer = CLIENT_FOOTER_RE.test(line);
    if (!footer && !SIGN_OFF_RE.test(line) && !DASH_RE.test(line)) continue;
    const above = lines.slice(0, i).map((l) => l.trim()).filter((l) => l && !GREETING_RE.test(l) && !BARE_THANKS_RE.test(l));
    if (above.length === 0) continue;
    const filled = lines.slice(i + 1).filter((l) => l.trim() !== '');
    if (!footer && filled[0] !== undefined && !looksLikeNameLine(filled[0])) continue;
    if (strict && (filled.length > 6 || filled.some((l) => l.length > 90))) continue;
    return i;
  }
  return lines.length;
}

/**
 * Drops a closing signature block, conservatively. P.S. lines are kept.
 */
export function stripSignature(text: string): string {
  const lines = text.split('\n');
  const i = findSignatureStart(lines, true);
  if (i >= lines.length) return text;
  const tail = lines.slice(i + 1);
  const ps = tail.findIndex((l) => PS_RE.test(l));
  return [...lines.slice(0, i), ...(ps >= 0 ? tail.slice(ps) : [])].join('\n').trim();
}

const NAME_BLOCK_RE = /^[A-Z][A-Za-z'-]+(?:[ \t]+[A-Z][A-Za-z'-]+){0,2}(?:[ \t]*[|,\u00b7\u2022/\u2013\u2014-][ \t]*[^.!?]{1,50})?[ \t]*$/;

/**
 * Where an unsigned name block starts ("Kemi Eze\nCFO\n..."): a name line after a blank line, with real content above it
 * and no more than 6 short lines from there on. `lines.length` when there is none.
 */
function findNameBlockStart(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line || (lines[i - 1] ?? '').trim() !== '') continue;
    if (!NAME_BLOCK_RE.test(line) || NOT_A_NAME_RE.test(line) || NOT_NAMES.has(line.split(/[\s|,]+/)[0] ?? '')) continue;
    const tail = lines.slice(i).filter((l) => l.trim() !== '');
    if (tail.length > 6 || tail.some((l) => l.length > 90)) continue;
    if (lines.slice(0, i).some((l) => l.trim() && !GREETING_RE.test(l.trim()) && !BARE_THANKS_RE.test(l.trim()))) return i;
  }
  return lines.length;
}

/** Where the closing block (signature, client footer or name block) starts: `lines.length` when there is none. */
function closingBlockStart(lines: string[]): number {
  return Math.min(findSignatureStart(lines, false), findNameBlockStart(lines));
}

/** What is left once the closing block is cut: where away phrases are looked for. Whole text when nothing but a greeting is above it. */
function aboveSignature(text: string): string {
  const lines = text.split('\n');
  const cut = closingBlockStart(lines);
  return cut >= lines.length ? text : lines.slice(0, cut).join('\n');
}

/** The reply as the person wrote it, quoted history and signature removed. For out-of-office, hostile and the rest. */
export function cleanReply(rawText: string): string {
  return stripSignature(stripQuoted(rawText));
}

// ---- engagement
const NEGATED_INTEREST_RE = /\b(?:not|never|no|isn'?t|aren'?t|n'?t)\s+(?:really\s+|very\s+|that\s+|so\s+)?(?:interested|keen)\b|\bno interest\b|\bkein interesse\b|pas int[ée]ress[ée]e?|no me interesa|n[ãa]o tenho interesse|\bnot sure\b/gi;
/** "Don't call me", "never send me ...": the engagement phrase is refused, not offered. */
const REFUSED_REQUEST_RE = /\b(?:do not|don'?t|never)\s+(?:ever\s+)?(?:call|ring|send|text|phone)\s+(?:me|us)\b/gi;
const RHETORICAL_QUESTION_RE = /\b(?:any |other )?(?:questions|queries|urgent(?:ly)?|need (?:help|assistance)|anything urgent)\s*\?/gi;
const ENGAGED_RE = new RegExp(
  '(?<![\\p{L}])(?:' + [
    'yes', 'yeah', 'yep', 'sure', 'happy to', 'glad to', 'keen', 'interested', 'intrigued', 'a call works', "let'?s", 'sounds (?:good|great)',
    'call me', 'ring me', 'send me', 'send over', 'send (?:the|us|through|across)', 'tell me more', 'exactly what we need', 'works for me', 'free (?:on|at|tomorrow)',
    's\\u00ed', 'me interesa', 'claro', 'ja', 'gerne', 'interesse an', 'oui', 'int[\\u00e9e]ress[\\u00e9e]e?', 'volontiers', 'bien s[u\\u00fb]r', 'sim', 'tenho interesse', 'com certeza',
  ].join('|') + ')(?![\\p{L}])|[?\\u00bf]',
  'iu',
);
const DAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const CLOCK = String.raw`(?:\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|(?:[01]?\d|2[0-3]):[0-5]\d\b)`;
/** Scheduling words: a person proposing or accepting a slot. Used where an away message is the other reading. */
const SCHEDULING_RE = new RegExp(`(?<![\\p{L}])(?:${DAY}|ok(?:ay)?|works|suits|sounds good|book)(?![\\p{L}])|${CLOCK}`, 'iu');
/** "back Monday", "until 9am on Monday": a day or time that says when someone returns is not a proposed slot. */
const RETURN_SLOT_RE = new RegExp(`\\b(?:until|till|back|returning|returns?|from|through|thru|by)\\s+(?:(?:on|at|the|next)\\s+)*(?:${DAY}|${CLOCK})(?:\\s+(?:(?:on|at)\\s+)?(?:${DAY}|${CLOCK}))*`, 'gi');
/**
 * True when the message shows a real person answering: yes, call me, send me, a question for us. With `scheduling`,
 * a weekday, a clock time, "works" or "ok" counts too (the return date of an away message does not).
 */
export function isEngaged(text: string, scheduling = false): boolean {
  const t = text.replace(NEGATED_INTEREST_RE, ' ').replace(REFUSED_REQUEST_RE, ' ').replace(RHETORICAL_QUESTION_RE, ' ');
  return ENGAGED_RE.test(t) || (scheduling && SCHEDULING_RE.test(t.replace(RETURN_SLOT_RE, ' ')));
}

// ---- opt-outs
const URL_RE = /https?:\/\/|www\./i;
/** Mailing-list and marketing footer wording: a line like this is boilerplate, never the person's own request. */
const FOOTER_WORDING_RE = new RegExp(
  [
    'unsubscribe here', 'click (?:here )?to unsubscribe', String.raw`(?:^|[.!?]\s+)\W*to unsubscribe\b`,
    String.raw`\b(?:click|tap|press|follow|use|visit|reply|send|link|button|below)\b[^.?!\n]{0,60}\bto unsubscribe\b`,
    'unsubscribe at any time', 'unsubscribe from this group', String.raw`\breply(?:ing)? (?:with |to )?(?:the word )?"?unsubscribe\b`, String.raw`\+unsubscribe@`,
    String.raw`\byou (?:can|may) (?:also )?opt[ -]?out\b`, String.raw`opt[ -]?out of (?:our |all )?marketing\s*:`,
    'if you no longer wish to receive', '(?:would )?prefer not to receive', "don'?t want to hear from (?:me|us)",
    'manage (?:your |email )?(?:preferences|subscription)', 'update (?:your )?preferences',
    'view (?:this )?(?:e-?mail )?in (?:your )?browser', 'why am i (?:getting|receiving) this',
  ].join('|'),
  'i',
);
const NEGATION = String.raw`(?:do not|don'?t|never)(?:\s+ever)?`;
const OTHER_CHANNEL_VERB = String.raw`(?:call|phone|ring|text|sms|whats\s?app|dm)`;
const DONT_VERB = String.raw`(?:e-?mail|mail|contact|write(?: to)?|message|reach out to|${OTHER_CHANNEL_VERB})`;
const VERB_LIST_SEPARATOR = String.raw`(?:\s*,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+)`;
const DONT_VERBS = String.raw`${DONT_VERB}(?:${VERB_LIST_SEPARATOR}${DONT_VERB})*`;
/**
 * "Don't email me", "do not contact us again", "don't send me any more": the three shapes of a general request.
 * Each match is then read by `readDontPhrase`, which decides whether it is a stop or something narrower.
 */
const DONT_PATTERNS = [
  new RegExp(String.raw`\b${NEGATION}\s+(${DONT_VERBS})\s+(?:me|us|my team|this address|this e-?mail(?: address)?)\b`, 'gi'),
  new RegExp(String.raw`\b${NEGATION}\s+(${DONT_VERBS})\s+(?:again|anymore|any more|any longer)\b`, 'gi'),
  new RegExp(String.raw`\b${NEGATION}\s+(send)\s+(?:me|us)\s+(?:any\s+)?(?:more|further|another)\b(?:\s+([\w-]+))?`, 'gi'),
];
const OTHER_CHANNEL_VERB_RE = new RegExp(`^${OTHER_CHANNEL_VERB}$`, 'i');
/** What can follow "any more" and still be a request to stop writing; any other noun ("attachments", "paper invoices") is a narrower request. */
const MESSAGE_NOUNS = new Set([
  'e-mail', 'e-mails', 'email', 'emails', 'mail', 'mails', 'message', 'messages', 'note', 'notes', 'follow-up', 'follow-ups', 'followups', 'info', 'information',
  'offer', 'offers', 'pitch', 'pitches', 'spam', 'stuff', 'update', 'updates', 'newsletter', 'newsletters', 'text', 'texts', 'call', 'calls', 'reminder', 'reminders',
  'outreach', 'marketing', 'material', 'materials', 'junk', 'correspondence', 'of', 'from', 'please', 'thanks', 'now', 'and', 'or',
]);
/** "again", "ever", "anymore": the writer means never, whatever else the clause says. */
const AGAIN_RE = /\b(?:again|anymore|any more|any longer|ever)\b/i;
/** The clause of a phrase ends at a comma, a semicolon, "but" or "and then"; what follows is somebody else's business. */
const CLAUSE_END_RE = /[,;]|\s+but\s+|\s+and then\s+/i;
/** "after this", "after today", "after this message" end nothing: the writer does not mean "write again later". */
const AFTER_THIS_RE = /\bafter\s+(?:this|that|today|now|tonight|these)\b(?:\s+(?:message|e-?mail|note|one))?/gi;
/** The one qualifier that survives "again": a stated end point ("until ...", "before January", "after 9am") means the writer will hear from us later. */
const END_POINT_RE = new RegExp(
  String.raw`\b(?:until|till)\b|\b(?:before|after)\s+(?:the\s+)?(?:\d|(?:${MONTH_RE})\b|${DAY}\b|tomorrow\b|next\b|christmas\b|new year\b)`,
  'i',
);
/**
 * A time, condition, place or channel attached to the phrase: "on Fridays", "if it's urgent", "on this number", "via the website form",
 * "at the info@ address". Our own channel is not one: "by email", "via any channel", "on my work email", "at work", "at this address".
 */
const QUALIFIER_RE = new RegExp(
  [
    String.raw`\b(?:outside|out of hours|before|after|during|between|next (?:week|month|quarter|year)|this (?:week|month|quarter|year)|in the (?:morning|evening|afternoon|night)|(?:at|over) (?:the )?(?:weekends?|weekdays?|holidays?|noon|midnight|night|lunch)|every \w+|when|while|once|if|unless|except|as long as)\b`,
    String.raw`\b(?:from|at)\s+\d`, String.raw`^\s*back\b`,
    String.raw`\b(?:through|via|by|on|over|using)\s+(?!(?:\w+\s+){0,3}?(?:e-?mail|mail)\b|(?:any|all|every|whatever)\b)`,
    String.raw`\bat\s+(?:the\s+|that\s+)?[\w.-]*@`,
  ].join('|'),
  'i',
);
/** A thing being named after "email us": "your card details", "the PDF". A narrower request, not a stop. */
const NOUN_OBJECT_RE = /^\s*(?:your|my|the|any|a|an|our|their|these|those|this|that|\d)\b/i;
/** The same sentence points the writer elsewhere: "call me instead", "WhatsApp me", "use payments@...". */
const OTHER_CHANNEL_RE = /\b(?:call(?:s|ing)?|phone|ring|text(?:s|ing)?|sms|whats\s?app|telegram|signal|linkedin|slack|dm|direct message|instead|rather)\b|\b(?:use|try|reach me at|contact me at|write to)\b[^.]{0,60}@/i;

/** One "don't ..." match: is it a request to stop, or something narrower? */
function isStopRequest(sentence: string, m: RegExpExecArray): boolean {
  const verbs = (m[1] ?? '').split(new RegExp(VERB_LIST_SEPARATOR, 'i'));
  if (verbs.every((v) => OTHER_CHANNEL_VERB_RE.test(v.trim()))) return false; // "don't call me" is not an email opt-out
  // "Do not email this address" is about the mailbox ("it is not monitored"), not about the person, unless they say again
  if (/\bthis (?:e-?mail )?address$/i.test(m[0]) && !AGAIN_RE.test(m[0] + sentence.slice(m.index + m[0].length))) return false;
  const end = m.index + m[0].length;
  const rest = sentence.slice(end);
  const clauseEnd = rest.search(CLAUSE_END_RE);
  const clause = (clauseEnd < 0 ? rest : rest.slice(0, clauseEnd)).replace(AFTER_THIS_RE, ' ');
  if (END_POINT_RE.test(clause)) return false;
  if (!AGAIN_RE.test(`${m[0]} ${clause}`) && (QUALIFIER_RE.test(clause) || NOUN_OBJECT_RE.test(clause))) return false;
  const emailOnly = verbs.every((v) => /^(?:e-?mail|mail)$/i.test(v.trim())) || /\bat this (?:e-?mail )?address\b/i.test(clause);
  return !(emailOnly && OTHER_CHANNEL_RE.test(sentence.slice(0, m.index) + ' ' + rest));
}

/** `stop` when a sentence asks the writer to stop; `narrow` when it has a "don't ..." phrase that asks for less; null for neither. */
function readDontPhrase(sentence: string): 'stop' | 'narrow' | null {
  let found: 'narrow' | null = null;
  for (const re of DONT_PATTERNS) {
    for (const m of sentence.matchAll(re)) {
      if (m[2] !== undefined && !MESSAGE_NOUNS.has(m[2].toLowerCase())) continue;
      if (isStopRequest(sentence, m)) return 'stop';
      found = 'narrow';
    }
  }
  return found;
}

/** Explicit opt-out phrases: these win over any softer reading, including Claude's. */
const STOP_RE = new RegExp(
  [
    String.raw`\bunsubscribe\b`, String.raw`\bremove me\b`, String.raw`\bremove my (?:e-?mail|address|name|details|number)\b`, String.raw`\btake me off\b`,
    String.raw`\bopt(?:ing)? me out\b`,
    String.raw`\bopt(?:ing)?[ -]out of (?:these|your|this|the|any|all)(?: \w+)? (?:e-?mails?|messages?|list|mailing|newsletters?|updates)\b`,
    String.raw`\b(?:i'?d like to|i would like to|i want to|i wish to|please|kindly|let me|need to) opt[ -]?out\b`,
    String.raw`^opt[ -]?out[\s.!]*$`,
    String.raw`\bno more (?:e-?mails?|mails?|messages?|notes?)\b`,
    String.raw`\bi (?:no longer|do not|don'?t) (?:wish|want) to (?:receive|get|hear from)\b`,
    String.raw`\b(?:stop|quit) (?:emailing|e-?mailing|messaging|contacting|writing|sending|texting|calling|following up|reaching out(?: to (?:me|us))?)(?=\s*[.,!?;]|\s*$|\s+(?:me|us|this|my|our|again|please|now)\b)`,
    String.raw`\bcease (?:all |any )?(?:contact|communication|correspondence)\b`, String.raw`\brefrain from (?:e-?mailing|contacting|writing|messaging|calling)\b`,
    String.raw`\b(?:never|do not|don'?t)\s+(?:ever\s+)?(?:e-?mail|contact|write to|message)\s+(?:anyone|anybody|everyone)\b[^.!?;]*\bagain\b`,
    // other languages
    String.raw`d[ée]sabonn\w*`, String.raw`d[ée]sinscri\w*`, String.raw`ne plus (?:me |m['’]|nous )?(?:contacter|[ée]crire|envoyer)`, String.raw`me retirer de votre liste`, String.raw`retirez[- ]moi`,
    String.raw`\bdar(?:se|me|nos)? de baja\b`, String.raw`\bd[ae]n?me de baja\b`, String.raw`no me (?:env[ií]en?|escriban?|manden?) m[aá]s`,
    String.raw`\babmelden\b`, String.raw`keine (?:e-?mails?|mails?|nachrichten) mehr`, String.raw`aus (?:dem|ihrem|ihrer) verteiler`, String.raw`von ihrer liste`, String.raw`streichen sie mich`,
    String.raw`\bne (?:me |nous )?(?:contactez|[ée]crivez|envoyez) plus\b`, String.raw`\bmeld\w* sie mich ab\b`, String.raw`\b(?:kontaktier\w*|schreib\w*) sie (?:mich|mir|uns) nicht mehr\b`,
    String.raw`\bd[eé]j(?:en|a|e|ar) de (?:escribir|enviar|contactar|mandar|molestar)\w*`, String.raw`\bno (?:me|nos) (?:contact(?:en?|es)|llam(?:en?|es)) m[aá]s`,
    String.raw`\bpar(?:e|em) de (?:me |nos )?(?:enviar|mandar|escrever|contactar|contatar|ligar)\b`, String.raw`\bdescadastr\w+`, String.raw`n[ãa]o me (?:envie|mande|escreva) mais`, String.raw`me remov\w+ da lista`, String.raw`remova-me`, String.raw`me tire da lista`,
  ].join('|'),
  'i',
);
/** "Stop" as the whole message, even repeated ("STOP STOP STOP"). */
const STOP_ONLY_RE = /^[\s"'*_>-]*(?:(?:please|pls|just|kindly)[\s,]+)?stop(?:[\s,.!]*\bstop\b)*[\s.!,"'*_-]*$/i;
/** A message that opens with "stop": "Stop.", "Stop, not interested", "stop it". Never "stop me if", "stop by". */
const STOP_FIRST_RE = /^[\s"'*_>-]*(?:(?:please|pls|just|kindly)[\s,]+)?stop\b(?:[\s,.!]*\bstop\b)*(?:[.,!?;:]|\s+[\-–—]\s|\s*$|[ \t]*\n|\s+(?:it|this|now|please|pls|emailing|e-?mailing|messaging|contacting|writing|sending|texting|calling|following)\b)/i;
/** "I said stop.", "Please stop, thanks.", "Just stop.", "Not sure who you are, stop." as a sentence or clause of its own. Never "full stop", "bus stop", "don't stop". */
const STOP_SENTENCE_RE = /(?:^|[.!?\n,;]\s*)(?:(?:i\s+(?:said|asked you to|told you to|already said)|please|pls|just|kindly|so|oh|ok|okay|yes)[\s,]+)*stop(?:[\s.!,]+(?:thanks|thank you|please|pls)\b)?[\s.!,]*$/i;


/** "unsubscribe me", "remove me", "take me off", "how do I unsubscribe": a person asking. */
const ASKING_RE = /\b(?:unsubscribe|remove|take|opt) me\b|\bremove my (?:e-?mail|address|name|details|number)\b|\bhow (?:do|can) i (?:unsubscribe|opt[ -]?out)\b/i;
/** "I want to unsubscribe", "I no longer wish to receive ...": a person saying so. */
const SAYING_RE = /\bi(?:'d| would)? (?:(?:no longer|do not|don'?t) (?:wish|want) to|(?:want|wish|need|like) to (?:unsubscribe|opt[ -]?out))/i;
/**
 * A line with a link or footer wording is boilerplate, unless a person is asking in it: the line opens with "unsubscribe me",
 * has a short sentence of its own that says so ("Remove me."), or says "I want to unsubscribe". A footer that mentions
 * "remove me from list requests" in the middle of a long sentence is still boilerplate.
 */
function holdsOwnOptOut(line: string): boolean {
  if (SAYING_RE.test(line)) return true;
  return line.split(/(?<=[.!?])\s+/).some((sentence, i) => (i === 0 || sentence.trim().split(/\s+/).length <= 8) && ASKING_RE.test(sentence));
}

interface OptOutUnit { text: string; /** above the closing block and the first footer wording */ body: boolean }

/**
 * Every non-empty sentence of every line, except list-footer lines (a link or footer wording, and the hard-wrapped
 * lines that continue one) that hold no first-person opt-out. `body` marks the sentences above the closing block
 * and the first footer wording.
 */
function optOutUnits(lines: string[], closing: number): OptOutUnit[] {
  const firstFooter = lines.findIndex((l) => FOOTER_WORDING_RE.test(l) && !holdsOwnOptOut(l));
  const bodyEnd = Math.min(closing, firstFooter < 0 ? lines.length : firstFooter);
  const units: OptOutUnit[] = [];
  let prevFooter = false;
  lines.forEach((line, i) => {
    const wrapped = prevFooter && line.trim() !== '' && (/^\s*[a-z]/.test(line) || line.includes('@'));
    const footer = (URL_RE.test(line) || FOOTER_WORDING_RE.test(line) || wrapped) && !holdsOwnOptOut(line);
    prevFooter = footer && !/[.!?:;]\s*$/.test(line);
    if (footer) return;
    for (const part of line.split(/(?<=[.!?])\s+/)) if (part.trim()) units.push({ text: part.trim(), body: i < bodyEnd });
  });
  return units;
}

/**
 * `explicit`: unambiguous on its own. `soft`: a bare "stop" that a clearly engaged message overrides. `narrow`: a "don't ..."
 * phrase that asks for less than a stop (a time, a condition, another channel). `engaged` is the body above the closing block.
 */
type OptOut = 'explicit' | 'soft' | 'narrow' | null;
interface OptOutScan { kind: OptOut; /** a bare "stop" that engagement overrode: it still beats an away message */ vetoed: boolean; engaged: boolean }

/**
 * Looks for a request to stop on the full text the person typed. A "don't ..." phrase below the closing block
 * (signature, client footer, name block) counts only when the body above it is not engaged: a footer cannot stop a
 * person who is answering us, and a request typed under a signature still stops one who is not.
 */
function scanOptOut(quotedFree: string): OptOutScan {
  const lines = quotedFree.split('\n');
  const closing = closingBlockStart(lines);
  const engaged = isEngaged(lines.slice(0, closing).join('\n'));
  let soft = false;
  let vetoed = false;
  let narrow = false;
  for (const unit of optOutUnits(lines, closing)) {
    const dont = unit.body || !engaged ? readDontPhrase(unit.text) : null;
    if (STOP_RE.test(unit.text) || dont === 'stop') return { kind: 'explicit', vetoed: false, engaged };
    if (dont === 'narrow') narrow = true;
    if (STOP_ONLY_RE.test(unit.text)) {
      if (!engaged) return { kind: 'explicit', vetoed: false, engaged };
      vetoed = true;
    }
    if (STOP_SENTENCE_RE.test(unit.text)) {
      if (engaged) vetoed = true;
      else soft = true;
    }
  }
  if (STOP_FIRST_RE.test(quotedFree)) {
    if (engaged) vetoed = true;
    else soft = true;
  }
  return { kind: soft ? 'soft' : narrow ? 'narrow' : null, vetoed: vetoed && !soft, engaged };
}

/** Someone the writer sends us to instead, in the same message as an opt-out: "take me off this, but loop in Chidi Okafor". */
const OPT_OUT_REFERRAL_VERB_RE = /\b(?:talk(?:ing)? to|speak(?:ing)? (?:to|with)|reach(?:ing)? out to|loop(?:ed|ing)? in|cc'?(?:ing|d)?|contact(?:ing)?)\b/gi;
/**
 * Before a referral verb in an opt-out message: "not talking to", "won't speak to", "stop contacting", "I'll talk to", "I've cc'd".
 * A negation, a stop verb or the writer's own plan, so the name that follows is not someone we are sent to.
 */
const NOT_A_POINTER_RE = /(?:\b(?:not|never|no|cannot|stop|quit|cease|without|refrain from)\b|n't|\b(?:i|we)(?:'ll|'m|'ve|'d|\s+(?:will|shall|am|have|had|would|may|might|can|could))\b)(?:\s+\w+){0,2}\s*$/i;

/** True when the reply says, in so many words, to stop writing and names no one else to talk to. Claude never overrides this. */
export function isExplicitOptOut(rawText: string, opts: ClassifyOptions = {}): boolean {
  const quotedFree = stripQuoted(rawText);
  return scanOptOut(quotedFree).kind === 'explicit' && !findReferral(stripSignature(quotedFree), referralExclusions(opts), OPT_OUT_REFERRAL_VERB_RE, true);
}

// ---- hostile
const GO_AWAY = String.raw`(?:^|[.!?;\n]\s*)(?:(?:just|please|pls|oh|now)[\s,]+)*go away(?=\s*(?:[.!,;]|$))`;
const HOSTILE_RE = new RegExp(
  '(?<![\\w*])(?:' + [
    GO_AWAY, 'leave me alone(?!\\s+(?:on|at|outside|before|after|until|during|between|from|while|when)\\b)', 'go to hell', 'piss off', 'screw you',
    '(?:fuck|fck|f\\*+k?) (?:off|you)', 'asshole', 'bastard',
    'harass(?:ing|ed) (?:me|us)', '(?:this|that) is (?:pure |plain |just )?harassment', 'stop harass\\w*',
    "(?:i(?:'ll| will| am going to|'m going to)|going to|will) report(?:ing)? you", 'report(?:ing|ed)? you (?:to|for|as|if|unless)',
    // aimed at this message or at the sender, never at something else ("a vendor scammed us")
    "this(?:'s| is) (?:just |pure |total |complete |utter |a |an |nothing but )*(?:spam|scam|bullshit)(?!\\s+(?:warning|alert|notice|filter))",
    '(?:this|your|the) (?:e-?mail|message|note|pitch|offer|company|product) (?:is|was) (?:just |a |total |complete |utter |pure )*(?:rubbish|garbage|spam|scam|bullshit)',
    "(?:you(?:'re| are)|you've been) (?:just |a |an |such |nothing but )*(?:spam|scam|spammers?|scammers?|spamming|harassing)",
    'what an? (?:spam|scam)', 'stop spamming',
    "^(?:it|that)(?:'s| is) (?:just |a |an |total |complete |pure )*(?:spam|scam)[\\s.!]*$",
    '(?:^|[.!?\\n]\\s*)(?:spam|scam)(?:[\\s.!]+(?:reported|blocked|deleted))?[\\s.!]*$',
  ].join('|') + ')(?![\\w])',
  'i',
);

// ---- out of office
const OOO_RE = new RegExp(
  [
    '\\booo\\b', 'out of (?:the )?office', 'out-of-office', 'out sick',
    'on (?:annual|maternity|paternity|parental|medical|sick|extended|study|compassionate) leave\\b',
    'on leave(?=\\s+(?:until|till|and will|returning|back)\\b)',
    'on (?:vacation|holiday|sabbatical)(?=\\s+(?:until|till|through|from|and|now|this|next|for)\\b|\\s*[.,;]|\\s*$)',
    'away (?:until|till)\\b', 'away from (?:the )?office\\b',
    'auto-?\\s?reply', 'automatic reply', 'automated (?:reply|response)',
    'limited access to (?:my )?(?:e-?mail|messages)',
    // other languages
    "absent(?:e)? jusqu['\\u2019]?(?:au|\\u00e0)", 'en cong[\\u00e9e]', 'fuera de la oficina', 'de vacaciones hasta',
    'nicht im b(?:\\u00fc|ue)ro', 'abwesend bis', 'fora do escrit[\\u00f3o]rio', 'de f[\\u00e9e]rias at[\\u00e9e]',
  ].join('|'),
  'i',
);
/** "Out of the office on Fridays" is a person describing their week, never an away message. */
const RECURRING_RE = /\b(?:out of (?:the )?office|away|on leave)\s+(?:on\s+)?(?:every\s+)?(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|most days|every (?:day|week)|often|sometimes|part of the week)\b/gi;
/** A mail system's own header at the start of the message or in a Subject line: these are away messages whatever else they say. */
const AUTOREPLY_HEADER_RE = /^\s*(?:subject:\s*)?(?:(?:automatic|auto)[ -]?reply|autoreply|out of office|r[ée]ponse automatique|respuesta autom[aá]tica|automatische antwort|resposta autom[aá]tica)\b\s*(?::|-|–|—|re:|$)/i;
function hasAutoReplyHeader(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return AUTOREPLY_HEADER_RE.test(lines[0] ?? '') || lines.some((l) => /^\s*subject:/i.test(l) && AUTOREPLY_HEADER_RE.test(l));
}
/**
 * An away phrase counts only when nobody is answering us in the same message (or the mail system says it is automatic).
 * `away` is the text above any signature or name block: an "out of the office" line in a signature is not an away message.
 */
function isOutOfOffice(text: string, away: string): boolean {
  if (hasAutoReplyHeader(text)) return true;
  const t = away.replace(RECURRING_RE, ' ');
  return OOO_RE.test(t) && !isEngaged(t, true);
}
const NOT_INTERESTED_FOREIGN_RE = /kein interesse|pas int[\u00e9e]ress[\u00e9e]e?|no me interesa|n[\u00e3a]o tenho interesse/i;
const NOT_INTERESTED_RE = /\b(?:not interested|no,? thank(?:s| you)|not (?:a )?(?:good )?fit|no need|not (?:looking|in the market)|not for (?:us|me)|we(?:'re| are) (?:all )?set|already (?:have|use|work with)|not a priority|(?:don'?t|do not|no) (?:have )?(?:the )?time for|not relevant|no interest|(?:we(?:'re| are)|i(?:'m| am)) (?:very |perfectly |quite |really )?happy with (?:our|what|the|my)|i'?ll pass|we'?ll pass|pass on this)\b/i;
const NOT_NOW_RE = /\b(?:not (?:right |just )?now|not (?:at the moment|this (?:week|month|quarter|year))|not until|bad timing|next (?:month|quarter|year|week)|circle back|(?:reach|get|come|check) back (?:to me |in )|later this|in (?:a |a few |a couple of |few |couple of |\d+ )?(?:weeks?|months?)|after (?:the )?(?:holidays?|summer|new year|q[1-4]|our (?:launch|audit|fundraise)|christmas)|try (?:me )?again|ping me (?:in|again|next)|touch base (?:in|next)|busy (?:right now|at the moment|with))\b/i;
const BOOK_RE = /\b(?:calls?|chat|meet(?:ing)?|time|calendar|demo|catch up|zoom|google meet|schedule|let'?s (?:talk|speak|connect)|(?:talk|speak) (?:soon|more|then)|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
const QUESTION_RE = /(?:\?|(?:^|[.!]\s+|\n)(?:how|what|what'?s|why|who|which|when|where|can you|could you|do you|does it|does this|is it|is this|are you|are there|would you|tell me (?:more|about)|i'?d like to know|send me (?:the )?(?:pricing|price|details|more info|info))\b)/i;
const NOT_NAMES = new Set([
  'I', 'We', 'You', 'The', 'Our', 'My', 'Your', 'Us', 'Me', 'Him', 'Her', 'Them', 'This', 'That', 'It', 'If', 'Please', 'Thanks', 'Thank', 'Hi', 'Hello', 'Hey',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Head', 'Director', 'Manager', 'Team', 'CEO', 'CFO', 'CTO', 'COO',
  'Legal', 'Compliance', 'Procurement', 'Accounts', 'Accounting', 'Payroll', 'Billing', 'Security', 'Privacy', 'Management', 'Reception', 'Everyone', 'Anybody', 'Department',
  'Finance', 'Support', 'Sales', 'Someone', 'Anyone', 'Marketing', 'Operations', 'Ops', 'Admin', 'Info', 'Sir', 'Madam', 'Best', 'Regards', 'Kind',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Mr', 'Mrs', 'Ms', 'Dr',
]);
const REFERRAL_VERB_RE = /\b(?:talk(?:ing)? to|speak(?:ing)? (?:to|with)|reach(?:ing)? out to|get in touch with|(?:please )?contact|loop(?:ed|ing)? in|cc'?(?:ing|d)|introduc(?:e|ing) you to|point(?:ing)? you to|connect(?:ing)? you (?:with|to)|forward(?:ed|ing)? (?:this |it |your (?:note|email|message) )?to|pass(?:ed|ing)? (?:this |it )?(?:on )?to|(?:right|best) person (?:is|would be|to (?:talk|speak) to is)|try(?:ing)?|ask(?:ing)?|e-?mail(?:ing)?|write to)\b/gi;
const NAME_RE = /^[ \t,:-]*(?:(?:my|our|the|his|her)[ \t]+(?:[a-z]+|[A-Z]{2,5})(?:[ \t]+(?:of[ \t]+)?(?:[a-z]+|[A-Z]{2,5})){0,2}[ \t]*[,:]?[ \t]+)?((?:[A-Z][a-z]+(?:['-][A-Za-z]+)*)(?:[ \t]+[A-Z][a-z]+(?:['-][A-Za-z]+)*){0,2})/;
const ROLE_MAILBOXES = new Set(['ops', 'info', 'finance', 'sales', 'support', 'hello', 'hi', 'team', 'admin', 'accounts', 'accounting', 'billing', 'contact', 'office', 'hr', 'mail', 'help', 'enquiries', 'inquiries', 'marketing', 'operations', 'procurement', 'payments', 'payroll', 'legal', 'press', 'careers', 'jobs', 'noreply', 'reception', 'general', 'service', 'services']);
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

interface ReferralExclusions { emails: (string | null)[]; names: (string | null)[] }

/** Names and addresses that can never be the person someone points us to. */
function referralExclusions(opts: ClassifyOptions): ReferralExclusions {
  return { emails: [opts.ownEmail ?? null, ...(opts.excludeEmails ?? [])], names: opts.excludeNames ?? [] };
}

function findReferral(text: string, exclude: ReferralExclusions, verbs: RegExp = REFERRAL_VERB_RE, optOut = false): Classification['referral'] {
  const skipEmail = (email: string): boolean =>
    exclude.emails.some((e) => e && e.toLowerCase() === email.toLowerCase()) || /^(?:no-?reply|donotreply)@/i.test(email);
  const excludedTokens = exclude.names.filter((n): n is string => !!n).map((n) => n.toLowerCase().split(/\s+/).filter(Boolean));
  const isExcludedName = (name: string): boolean => {
    const tokens = name.toLowerCase().split(/\s+/);
    return excludedTokens.some((set) => tokens.every((t) => set.includes(t)));
  };
  for (const verb of text.matchAll(verbs)) {
    if (optOut && NOT_A_POINTER_RE.test(text.slice(0, verb.index).replace(/^[\s\S]*[.!?;,\n]/, ''))) continue;
    const from = verb.index + verb[0].length;
    const rest = text.slice(from);
    const m = NAME_RE.exec(rest);
    const clean: string[] = [];
    for (const w of m?.[1]?.split(/[ \t]+/) ?? []) {
      if (NOT_NAMES.has(w) || /['’]s$/i.test(w)) break;
      clean.push(w);
    }
    if (clean.length > 0) {
      const name = clean.join(' ');
      if (isExcludedName(name)) continue;
      const after = rest.slice(m?.[0].length ?? 0);
      const near = EMAIL_RE.exec(after.slice(0, 80))?.[0] ?? EMAIL_RE.exec(text)?.[0] ?? null;
      return { name, email: near && !skipEmail(near) ? near : null, context: sentenceAround(text, verb.index) };
    }
    const direct = /^[\s,:]*[<(]?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(rest)?.[1];
    if (direct && !skipEmail(direct)) {
      const parts = (direct.split('@')[0] ?? direct).split(/[._+-]+/).filter((p) => /^[a-z]{2,}$/i.test(p));
      // only a mailbox that looks like a person ("sam.bello", "sam"), never "ops" or "finance"
      if (parts.length > 0 && parts.length <= 2 && !parts.some((p) => ROLE_MAILBOXES.has(p.toLowerCase()))) {
        const name = parts.map(titleCase).join(' ');
        if (!isExcludedName(name)) return { name, email: direct, context: sentenceAround(text, verb.index) };
      }
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

const BACK_DAY_RE = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)';

export interface ClassifyOptions { ownEmail?: string | null; excludeNames?: (string | null)[]; excludeEmails?: (string | null)[] }

/**
 * Deterministic reply reading: ordered phrase rules, the same ones every time.
 * When in doubt it lands on "interested", which only costs the user a glance at the dock.
 * `today` is the date of the message being read.
 */
export function classifyReply(rawText: string, today: Date, opts: ClassifyOptions = {}): Classification {
  const quotedFree = stripQuoted(rawText);
  const text = stripSignature(quotedFree);
  // "it went to my spam folder" is not a complaint
  const hostileText = text.replace(/\b(?:in|into|to|from|via|my|the)\s+(?:my\s+|the\s+)?(?:spam|junk)(?:\s+(?:folder|box|filter))?\b/gi, ' ');
  const exclusions = referralExclusions(opts);
  const optOut = scanOptOut(quotedFree);
  if (optOut.kind === 'explicit' || optOut.kind === 'soft') {
    // "take me off this, but loop in Chidi Okafor": the person named someone else, so a human has to see it
    const named = findReferral(text, exclusions, OPT_OUT_REFERRAL_VERB_RE, true);
    return named ? result('referral', { referral: named }) : result('stop');
  }
  if (HOSTILE_RE.test(hostileText)) return result('hostile');
  // a phrase that asks for less than a stop ("not on Fridays", "don't call me") goes to the dock, never to out_of_office,
  // and as a "no" unless the reply is engaged
  const narrow = optOut.kind === 'narrow';
  if (narrow && !optOut.engaged) return result('not_interested');
  const away = aboveSignature(quotedFree);
  // a bare "stop" that a question overrode still beats an away message: "Out of Office until Monday. Who are you? Stop."
  if (optOut.vetoed && (hasAutoReplyHeader(text) || OOO_RE.test(away.replace(RECURRING_RE, ' ')))) return result('stop');
  if (!narrow && isOutOfOffice(text, away)) return result('out_of_office', { returnDate: findDate(away, today) ?? findRelativeReturn(away, today) });
  const referral = findReferral(text, exclusions);
  if (referral) return result('referral', { referral });
  if (NOT_INTERESTED_RE.test(text) || NOT_INTERESTED_FOREIGN_RE.test(text) || /^\s*no[\s.,]*$/i.test(text)) return result('not_interested');
  // "let's circle back on Monday" proposes a day; it is not a request to wait
  const waiting = text.replace(new RegExp(`\\b(?:circle|get|come|check|reach) back (?:to me )?(?:on |by |this )?${BACK_DAY_RE}\\b`, 'gi'), ' ');
  if (NOT_NOW_RE.test(waiting)) return result('not_now', { returnDate: findDate(text, today) });
  if (BOOK_RE.test(text)) return result('interested', {}, 'book');
  if (QUESTION_RE.test(text)) return result('question');
  return result('interested');
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'your', 'their', 'our', 'its', 'my', 'all', 'any', 'more', 'less', 'some', 'every', 'each', 'of', 'off', 'out', 'on', 'in', 'to', 'for', 'from',
  'by', 'at', 'as', 'and', 'or', 'so', 'that', 'which', 'without', 'with', 'into', 'over', 'under', 'using', 'while', 'than', 'it', 'them', 'up', 'down',
]);
const NAME_TRIGGER_RE = /\b(?:with|take|takes|taking|run|runs|running|handle|handles|manage|manages|automate|automates|build|builds|offer|offers|provide|provides|sell|sells|design|designs|deliver|delivers|set up|sets up)\s+((?:[a-z][a-z&'-]*\s*){1,8})/gi;

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
  // "easy to pay contractors abroad": the thing acted on
  const infinitive = /\bto\s+[a-z]+\s+((?:[a-z][a-z&'-]*\s*){1,4})/i.exec(text)?.[1];
  const object = infinitive?.toLowerCase().split(/\s+/).filter(Boolean).find((w) => !STOPWORDS.has(w));
  return object ? titleCase(object) : 'My project';
}

const BANG = /!/g;

/** The date of the reply being read: the latest inbound message in the history, else now. */
export function messageDate(ctx: WriteContext, clock: Clock): Date {
  let latest: Date | null = null;
  for (const m of ctx.history) {
    if (m.direction !== 'in') continue;
    const at = new Date(m.at);
    if (!Number.isNaN(at.getTime()) && (!latest || at > latest)) latest = at;
  }
  return latest ?? clock.now();
}

/** Names and addresses that can never be the person someone points us to: the replier and the sender. */
export function classifyOptions(ctx: WriteContext): ClassifyOptions {
  return {
    ownEmail: ctx.person.email,
    excludeEmails: [ctx.settings.senderEmail],
    excludeNames: [ctx.person.name, ctx.person.firstName, ctx.settings.senderName],
  };
}

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
        body = clampNote(`Hi ${first}, ${inlineOffer(offer)} Would love to connect.`);
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
    return classifyReply(text, messageDate(ctx, this.clock), classifyOptions(ctx));
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
      return `Hi ${first}, ${inlineOffer(offer)} Worth 15 minutes next week?`;
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

const escapeRe = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (word: string, text: string): RegExpExecArray | null =>
  new RegExp(`(?:^|[^\\p{L}])${escapeRe(word)}(?![\\p{L}])`, 'iu').exec(text);

/**
 * People named in the text, in the order they are named. A first name shared by several people picks the one
 * whose full name is in the text; if that still leaves more than one, the text is ambiguous and nobody is picked.
 */
function peopleNamedIn(text: string, people: { id: number; name: string }[]): { ids: number[]; ambiguous: boolean } {
  const lower = text.toLowerCase();
  const byFirst = new Map<string, { id: number; name: string }[]>();
  for (const p of people) {
    const first = firstNameOf(p.name);
    if (first) byFirst.set(first, [...(byFirst.get(first) ?? []), p]);
  }
  const hits: { id: number; at: number }[] = [];
  let ambiguous = false;
  for (const [first, group] of byFirst) {
    const m = wordIn(first, lower);
    if (!m) continue;
    let chosen = group;
    if (group.length > 1) {
      chosen = group.filter((p) => wordIn(p.name.trim().replace(/\s+/g, ' ').toLowerCase(), lower));
      if (chosen.length !== 1) {
        ambiguous = true;
        continue;
      }
    }
    for (const p of chosen) hits.push({ id: p.id, at: m.index });
  }
  return { ids: hits.sort((a, b) => a.at - b.at).map((h) => h.id), ambiguous };
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
    const named = peopleNamedIn(sw[1] ?? '', people);
    if (named.ambiguous) return { intent: 'unknown' };
    if (channel && named.ids.length > 0) return { intent: 'switch', personIds: named.ids, channel };
  }

  const like = /\b(?:more|people|others|ones?)\s+(?:people\s+)?like\s+([\p{L}'-]+)/iu.exec(body);
  if (like) {
    const named = peopleNamedIn(body.slice(like.index + like[0].length - (like[1] ?? '').length), people);
    if (named.ambiguous) return { intent: 'unknown' };
    const likeId = named.ids[0];
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
