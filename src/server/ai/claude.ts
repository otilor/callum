import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Channel, Message, OutKind, Tone } from '../../shared/types.js';
import { clampNote } from '../channels/linkedin-detect.js';
import { type Clock, systemClock } from '../engine/clock.js';
import { findPlaceholders } from '../engine/guard.js';
import { OFFER_PLACEHOLDER, classifyOptions, isExplicitOptOut, messageDate, stripQuoted } from './templates.js';
import { ApiModel, type Model } from './model.js';
import type { AskIntent, Classification, Writer, WriteContext } from './writer.js';

const CHANNELS = ['email', 'linkedin', 'x'] as const;

/** The prompt asks for under 90 words; this is the limit the code enforces, with room to spare. */
const MAX_WORDS: Record<OutKind, number> = { hello: 120, invite: 60, thanks: 120, follow_up: 120, reply: 160, booking: 120, close: 120 };

const COPY_RULES = [
  'You write for Callum, a calm outreach assistant, on behalf of one person (the sender).',
  'Copy rules, without exception:',
  '- Write like a calm colleague: first names, plain words, short sentences.',
  '- No exclamation marks. No emojis. No hype, no buzzwords, no flattery.',
  '- It must not read like a mail merge or a template. Say one specific, true thing.',
  '- Under 90 words.',
  '- Give exact times ("Thursday at 9:00"), never "soon" or "sometime".',
  '- Never invent facts: no prices, links, customers, numbers, dates or claims you were not given.',
  '- When a fact you need is missing (a price, a link, a date), write it as an ALL-CAPS bracket placeholder such as [YOUR PRICE] or [YOUR CALENDAR LINK]. Never guess.',
  '- Never use the words: lead, prospect, contact (as a noun for a person), touch, step, cadence, engaged, churned, disable.',
  '- Never mention AI, automation or that this was generated.',
].join('\n');

const TONES: Record<Tone, string> = {
  warm: 'warm: friendly, a little curious about their work, unhurried',
  direct: 'direct: brief and to the point, one clear ask, no small talk',
  playful: 'playful: light and a bit witty, never silly, still respectful',
};

const KIND_BRIEF: Record<OutKind, string> = {
  hello: 'A first hello. Say why you are writing, in one line about what the sender offers, and ask one easy question.',
  invite: 'A LinkedIn connection note. At most 280 characters including spaces. No pitch beyond one line.',
  thanks: 'A short thank-you for accepting the LinkedIn connection, with one line on what the sender offers and an easy next step.',
  follow_up: 'A follow-up to an earlier note that got no reply. Add something useful or a lighter ask. If this is the last one, say so kindly and leave the door open.',
  reply: 'A reply to what they last wrote. Answer what they asked. If they asked about something you were not given, use an ALL-CAPS bracket placeholder.',
  booking: 'Offer to book a time. Include the calendar link exactly as given.',
  close: 'A gracious close: thank them, say you will not follow up again, wish them well.',
};

const writeSchema = z.object({ body: z.string() });
const classifySchema = z.object({
  kind: z.enum(['interested', 'question', 'not_now', 'not_interested', 'stop', 'hostile', 'out_of_office', 'referral']),
  suggested: z.enum(['reply', 'book', 'snooze', 'close']),
  returnDate: z.string().nullable(),
  referral: z.object({ name: z.string(), email: z.string().nullable(), context: z.string() }).nullable(),
  language: z.string(),
});
const offerSchema = z.object({ offer: z.string() });
const nameSchema = z.object({ name: z.string() });
const askSchema = z.object({
  intent: z.enum(['warm', 'why', 'find', 'pause', 'resume', 'tone', 'switch', 'unknown']),
  likePersonId: z.number().nullable(),
  query: z.string().nullable(),
  count: z.number().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  tone: z.enum(['warm', 'direct', 'playful']).nullable(),
  personIds: z.array(z.number()),
});

function isoDate(s: string | null | undefined): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** Claude's suggested action, kept only where it fits the kind. */
function suggestedFor(kind: Classification['kind'], suggested: Classification['suggested']): Classification['suggested'] {
  switch (kind) {
    case 'stop': case 'hostile': case 'not_interested': return 'close';
    case 'out_of_office': case 'not_now': return 'snooze';
    case 'question': case 'referral': return 'reply';
    case 'interested': return suggested === 'book' ? 'book' : 'reply';
  }
}

function transcript(history: Message[]): string {
  const recent = history.slice(-6);
  if (recent.length === 0) return '(no earlier messages)';
  return recent
    .map((m) => `${m.direction === 'out' ? 'Sender' : 'Them'} (${m.kind}, ${m.at.slice(0, 10)})${m.subject ? ` subject "${m.subject}"` : ''}:\n${m.body}`)
    .join('\n\n');
}

function dayName(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Claude writes; the template writer answers whenever Claude cannot (no network, error, refusal, bad output). */
export class ClaudeWriter implements Writer {
  /** Where Claude runs: Claude Code on this computer, or the API with a key. */
  readonly model: Model;

  /**
   * `source` is a Model, or an API key (with `model` naming the Claude model and `client` standing in for the API in
   * tests). Every call falls back to `fallback` when Claude can't answer.
   */
  constructor(
    source: string | Model,
    modelName: string,
    private readonly fallback: Writer,
    client?: Anthropic,
    private readonly clock: Clock = systemClock,
  ) {
    this.model = typeof source === 'string' ? new ApiModel(source, modelName, client) : source;
  }

  /** The last reason a call fell back to the templates (never contains the API key). */
  get lastError(): string | null {
    return this.model.lastError;
  }

  private ask<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S> | null> {
    return this.model.ask(schema, system, user);
  }

  async write(kind: OutKind, ctx: WriteContext): Promise<{ subject: string | null; body: string }> {
    const template = await this.fallback.write(kind, ctx);
    const { person, project, settings, channel } = ctx;
    const system = [
      COPY_RULES,
      `Write one ${channel === 'email' ? 'email body' : channel === 'linkedin' ? 'LinkedIn message' : 'X direct message'}. Output only the message text in "body": no subject line, no quotes, no notes to the sender.`,
      channel === 'email' ? 'Plain text, no signature block, and do not add an unsubscribe line (it is added for you). End after the last sentence.' : '',
      kind === 'invite' ? 'Hard limit: 280 characters including spaces.' : '',
      `The sender: ${settings.senderName ?? 'the sender'}. Write in the first person as the sender.`,
      project.offer
        ? `What the sender offers (their own words; write it in first person, "I help ..."): ${project.offer}`
        : `The sender has not said what they offer. Where you must say it, write ${OFFER_PLACEHOLDER}.`,
      project.audience ? `Who the sender usually writes to: ${project.audience}` : '',
      `Tone: ${TONES[project.tone]}.`,
      project.sample ? `A message the sender wrote themselves, for voice only (never copy its facts):\n${project.sample}` : '',
      kind === 'booking' ? `Calendar link: ${project.calendarUrl?.trim() || '[YOUR CALENDAR LINK]'}` : '',
      'If they wrote in a language other than English, answer in the language of their message.',
    ].filter(Boolean).join('\n\n');
    const user = [
      `Message to write: ${kind} (${KIND_BRIEF[kind]})`,
      `Recipient: ${person.name} (first name ${person.firstName})${person.role ? `, ${person.role}` : ''}${person.company ? ` at ${person.company}` : ''}.`,
      `Messages already sent: ${person.touches}.`,
      person.note ? `Note about them: ${person.note}` : '',
      `Conversation so far:\n${transcript(ctx.history)}`,
    ].filter(Boolean).join('\n\n');

    const out = await this.ask(writeSchema, system, user);
    if (!out) return template;
    let body = out.body.trim().replace(/!/g, '.').replace(/\u00A1/g, '');
    if (kind === 'invite') body = clampNote(body);
    const badMergeField = findPlaceholders(body).some((p) => !p.startsWith('['));
    const words = body.split(/\s+/).filter(Boolean).length;
    if (!body || words > MAX_WORDS[kind] || body.length > 1500 || badMergeField) return template;
    return { subject: template.subject, body };
  }

  async classify(text: string, ctx: WriteContext): Promise<Classification> {
    const template = await this.fallback.classify(text, ctx);
    const reply = stripQuoted(text) || text.trim();
    const system = [
      'You read one reply to an outreach message and say what it means. Answer only with the structured fields.',
      'kind: interested (wants to talk or hear more), question (asks something before deciding), not_now (maybe later), not_interested (a clear no), stop (asks not to be contacted again, unsubscribes), hostile (angry, abusive, calls it spam), out_of_office (automatic or personal away reply), referral (points to someone else to talk to).',
      'suggested: reply (write back), book (offer a time or calendar link), snooze (leave them alone until later), close (stop writing, thank them).',
      'Rules: stop and hostile always suggest close. not_interested suggests close. not_now and out_of_office suggest snooze. If they propose a call or ask for a time, kind is interested and suggested is book.',
      `returnDate: the date they said they are back or ready, as YYYY-MM-DD, resolved to the next such date on or after today (${dayName(messageDate(ctx, this.clock))}); null when no date is given. Never guess a date.`,
      'referral: only for kind referral. name and email of the person they point to (email null if not given), and context: the sentence that says why, in their words.',
      'language: the ISO 639-1 code of the language of their message ("en", "fr", ...).',
      'Ignore quoted earlier messages and the opt-out line "If this isn\'t for you, just reply stop"; judge only what they wrote now.',
    ].join('\n');
    const last = [...ctx.history].reverse().find((m) => m.direction === 'out');
    const user = [
      `Sender's offer: ${ctx.project.offer ?? '(not given)'}`,
      last ? `The message they are replying to:\n${last.body}` : '',
      `Their reply:\n${reply}`,
    ].filter(Boolean).join('\n\n');

    const out = await this.ask(classifySchema, system, user);
    if (!out) return template;
    // An explicit opt-out ("unsubscribe", "take me off", "don't email me") is never overridden by a softer reading.
    // Any other template guess (a bare "stop", a hostile word) yields to Claude.
    if (template.kind === 'stop' && isExplicitOptOut(text, classifyOptions(ctx)) && out.kind !== 'stop' && out.kind !== 'hostile') return template;
    const referral = out.kind === 'referral' && out.referral && out.referral.name.trim()
      ? { name: out.referral.name.trim(), email: out.referral.email?.trim() || null, context: out.referral.context.trim() }
      : null;
    if (out.kind === 'referral' && !referral) return template;
    return {
      kind: out.kind,
      suggested: suggestedFor(out.kind, out.suggested),
      returnDate: out.kind === 'out_of_office' || out.kind === 'not_now' ? isoDate(out.returnDate) : null,
      referral,
      language: out.language.trim().toLowerCase().slice(0, 12) || 'en',
    };
  }

  async offerLine(siteText: string, domain: string): Promise<string> {
    const template = await this.fallback.offerLine(siteText, domain);
    if (!siteText.trim()) return template;
    const system = [
      'You read the text of a company website and say, in one sentence, what the company offers and to whom.',
      `Write it as "You help <who> <do what>." in second person, plain words, under 25 words, no exclamation marks, no hype.`,
      `Use only what the text says. If the text does not make clear what the company offers, answer exactly ${OFFER_PLACEHOLDER}.`,
    ].join('\n');
    const out = await this.ask(offerSchema, system, `Domain: ${domain}\n\nWebsite text:\n${siteText.slice(0, 6000)}`);
    const line = out?.offer.replace(/\s+/g, ' ').trim();
    if (!line) return template;
    if (line === OFFER_PLACEHOLDER) return line;
    if (line.length > 240 || /[!\n]/.test(line) || !/^You\b/.test(line)) return template;
    return line;
  }

  async parseAsk(text: string, people: { id: number; name: string }[]): Promise<AskIntent> {
    const template = await this.fallback.parseAsk(text, people);
    const system = [
      'You turn one short instruction from the user of an outreach app into a structured intent. Answer only with the structured fields.',
      'intents: warm (who is warm / who replied), why (why something happened), find (find more people: likePersonId when "more like <person>", else query text; count defaults to 20, max 50), pause or resume (needs channel), tone (needs tone: warm, direct or playful), switch (move named people to a channel; needs personIds and channel), unknown (anything else).',
      'Use null for fields that do not apply and [] for personIds. Only use ids from the list of people. If unsure, answer unknown.',
    ].join('\n');
    const user = `People:\n${people.map((p) => `${p.id}: ${p.name}`).join('\n') || '(none)'}\n\nInstruction: ${text}`;
    const out = await this.ask(askSchema, system, user);
    if (!out) return template;
    const known = new Set(people.map((p) => p.id));
    switch (out.intent) {
      case 'warm':
      case 'why':
      case 'unknown':
        return { intent: out.intent };
      case 'find': {
        if (out.likePersonId !== null && !known.has(out.likePersonId)) return template;
        const query = out.query?.trim() || null;
        if (out.likePersonId === null && !query) return template;
        const count = out.count != null && Number.isFinite(out.count) ? Math.min(50, Math.max(1, Math.round(out.count))) : 20;
        return { intent: 'find', likePersonId: out.likePersonId, query: out.likePersonId === null ? query : null, count };
      }
      case 'pause':
      case 'resume':
        return out.channel ? { intent: out.intent, channel: out.channel as Channel } : template;
      case 'tone':
        return out.tone ? { intent: 'tone', tone: out.tone } : template;
      case 'switch': {
        const personIds = [...new Set(out.personIds)].filter((id) => known.has(id));
        return out.channel && personIds.length > 0 ? { intent: 'switch', personIds, channel: out.channel as Channel } : template;
      }
    }
  }

  async projectName(offer: string): Promise<string> {
    const template = await this.fallback.projectName(offer);
    if (!offer.trim()) return template;
    const system = [
      'You name a project for an outreach app. The project is about one thing the user offers.',
      'Answer with a name of one to three words, title-cased, for what is offered (examples: "Reconciliation", "Payroll", "Design reviews"). No quotes, no punctuation, no company names, no exclamation marks.',
    ].join('\n');
    const out = await this.ask(nameSchema, system, `What the user offers: ${offer}`);
    const name = out?.name.replace(/[\s"'.]+$/g, '').replace(/^["'\s]+/, '').replace(/\s+/g, ' ');
    if (!name || name.length > 40 || name.split(' ').length > 3 || /[!\n]/.test(name)) return template;
    return name;
  }
}
