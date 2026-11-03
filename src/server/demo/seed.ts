import type { Channel, MessageKind, Person, Project, ReplyKind, SuggestedAction, Tone } from '../../shared/types.js';
import { inlineOffer, offerSentence } from '../ai/templates.js';
import { clampNote } from '../channels/linkedin-detect.js';
import type { Ctx } from '../context.js';
import { afterSent, afterUserSent, onAccepted, onInbound } from '../engine/lifecycle.js';
import { localParts, weekdayOf, zonedTime } from '../engine/time.js';
import { withOptOut } from '../engine/guard.js';
import { DEMO_PEOPLE, PAYROLL_PEOPLE, type DemoPerson } from './people.js';

export type Scene = 'fresh' | 'morning';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SENDER_NAME = 'Gabriel';
const SENDER_EMAIL = 'gabriel@yourcompany.com';
const CALENDAR_URL = 'https://cal.example.com/gabriel';

const RECONCILIATION = {
  name: 'Reconciliation',
  offer: "You help fintech teams take reconciliation off their ops team's plate.",
  audience: 'Founders and finance leads at fintechs in Lagos',
  tone: 'warm' as Tone,
};
const PAYROLL = {
  name: 'Payroll',
  offer: 'You help growing teams in Lagos and Accra run payroll without spreadsheets.',
  audience: 'Heads of people and founders at growing companies in Lagos and Accra',
  tone: 'direct' as Tone,
};

const IDENTITY: Record<Channel, string> = { email: SENDER_EMAIL, linkedin: 'Gabriel on LinkedIn', x: '@gabriel' };

/**
 * Replace everything with a demo scene. `fresh` is a first run waiting to happen: demo channels connected and a
 * list of people to meet. `morning` is Callum three days into the job, with replies waiting on the dock.
 * Everything goes through the repo and the engine's own rules, so the screens show what the real app would.
 */
export function seedScene(ctx: Ctx, scene: Scene): void {
  ctx.repo.deleteAll();
  // A demo scene holds made-up people: their stops are not worth keeping.
  ctx.repo.clearSuppressions();
  ctx.reloadKeys();
  ctx.repo.transaction(() => {
    if (scene === 'fresh') seedFresh(ctx);
    else seedMorning(ctx);
  });
  for (const scope of ['settings', 'channels', 'projects', 'people', 'outbox', 'incidents'] as const) ctx.bus.emit(scope);
}

function connectChannels(ctx: Ctx, connectedAt: Date): void {
  for (const channel of ['email', 'linkedin', 'x'] as const) {
    ctx.repo.updateChannel(channel, { status: 'connected', identity: IDENTITY[channel], connectedAt: connectedAt.toISOString() });
  }
}

function addPerson(ctx: Ctx, projectId: number, d: DemoPerson): Person {
  return ctx.repo.insertPerson({
    projectId,
    name: d.name,
    firstName: d.firstName,
    company: d.company,
    role: d.role,
    email: d.email,
    linkedinUrl: d.linkedinUrl,
    xHandle: d.xHandle,
    timezone: d.timezone,
    channel: d.channel,
    source: 'demo',
  });
}

function seedFresh(ctx: Ctx): void {
  const { repo } = ctx;
  connectChannels(ctx, ctx.clock.now());
  const project = repo.insertProject({ ...RECONCILIATION });
  for (const d of DEMO_PEOPLE) addPerson(ctx, project.id, d);
  repo.updateSettings({
    senderName: SENDER_NAME, senderEmail: SENDER_EMAIL, onboarded: false, currentProjectId: project.id,
  });
}

// ---- the morning scene ---------------------------------------------------

/** Positions in DEMO_PEOPLE, as on the Morning board. */
const KEMI = 0;
const TUNDE = 1;
const FEMI = 3;
const ZAINAB = 4;
const FOLLOWING = new Set([2, 8]);   // Ada and Ngozi: invited, accepted, thanked on LinkedIn
const STRANGERS_FROM = 24;           // the last 16 have had no message yet
const FIRST_DAY_COUNT = 12;          // the first dozen got their hello two working days ago, the rest one day ago

interface Reply {
  kind: ReplyKind;
  suggested: SuggestedAction;
  text: string;
  draft: string;
  /** How long before now they wrote. */
  ago: number;
}

const DOCK: Record<number, Reply> = {
  [KEMI]: {
    kind: 'interested', suggested: 'book', text: 'Happy to chat. Does Thursday work?', ago: 40 * 60_000,
    draft: "Thursday works, Kemi. Here's my calendar, pick any time that suits you: " + CALENDAR_URL,
  },
  [FEMI]: {
    kind: 'question', suggested: 'reply', text: 'Can you tell me more about pricing?', ago: 17 * HOUR,
    draft: "Hi Femi, for a team your size it's [YOUR PRICE] a month, and setup is included. Want a two-minute walkthrough video first, or should I send a trial invite?",
  },
  [ZAINAB]: {
    kind: 'not_now', suggested: 'snooze', text: 'Not right now, maybe next quarter.', ago: 19 * HOUR,
    draft: "Totally fair, Zainab. I'll check back next quarter. Good luck with the year-end rush.",
  },
};

const YAW_REPLY: Reply = {
  kind: 'interested', suggested: 'reply', text: 'Happy to look. We run 140 people on a spreadsheet today.', ago: 3 * HOUR,
  draft: 'Thanks, Yaw. 140 people on a spreadsheet is where I can help most. Can you do a 20 minute call on Thursday at 10:00?',
};

function isWeekend(year: number, month: number, day: number): boolean {
  const w = weekdayOf(year, month, day);
  return w === 0 || w === 6;
}

/**
 * A working-day time inside sending hours, `daysBack` days before now (or the working day before that),
 * staggered by `k` so the hellos do not all leave at one moment.
 */
function workSlot(now: Date, tz: string, daysBack: number, k: number): Date {
  const { year, month, day } = localParts(now, tz);
  let d = day - daysBack;
  while (isWeekend(year, month, d)) d -= 1;
  const minutes = (k * 53) % 420;
  return zonedTime(tz, year, month, d, 9 + Math.floor(minutes / 60), minutes % 60);
}

function helloBody(tone: Tone, first: string, company: string, offer: string): string {
  const sentence = offerSentence(offer);
  switch (tone) {
    case 'direct':
      return `Hi ${first}, ${inlineOffer(sentence)} Worth 15 minutes next week?`;
    case 'playful':
      return `Hi ${first}, quick question: who at ${company} would get the most out of this? ${sentence}`;
    case 'warm':
      return `Hi ${first}, I've been following what ${company} is building. ${sentence} Would a quick chat be useful?`;
  }
}

/** The words of an outbound message, in the shape the real writer gives them. */
function outbound(kind: 'hello' | 'invite' | 'thanks' | 'reply', channel: Channel, p: DemoPerson, project: Pick<Project, 'tone' | 'offer'>): { subject: string | null; body: string } {
  const hello = `Quick question, ${p.firstName}`;
  const offer = offerSentence(project.offer);
  let body: string;
  switch (kind) {
    case 'hello':
      body = helloBody(project.tone, p.firstName, p.company, project.offer ?? '');
      break;
    case 'invite':
      body = clampNote(`Hi ${p.firstName}, ${inlineOffer(offer)} Would love to connect.`);
      break;
    case 'thanks':
      body = `Thanks for connecting, ${p.firstName}. ${offer} Would a quick chat be useful?`;
      break;
    case 'reply':
      body = `Thanks, ${p.firstName}. Happy to share more. Would a short call this week work?`;
      break;
  }
  const subject = channel === 'email' ? (kind === 'hello' ? hello : `Re: ${hello}`) : null;
  return { subject, body: channel === 'email' ? withOptOut(body) : body };
}

class Scribe {
  constructor(private readonly ctx: Ctx, private person: Person, private readonly demo: DemoPerson, private readonly project: Pick<Project, 'tone' | 'offer'>) {}

  get current(): Person {
    return this.person;
  }

  apply(patch: Partial<Person>): void {
    this.person = this.ctx.repo.updatePerson(this.person.id, patch);
  }

  record(direction: 'in' | 'out', kind: MessageKind, at: Date, written: { subject: string | null; body: string }): void {
    this.ctx.repo.insertMessage({
      personId: this.person.id, channel: this.person.channel ?? this.demo.channel, direction, kind,
      subject: written.subject, body: written.body, at: at.toISOString(), externalId: null,
    });
  }

  /** Callum's own touch, with the patch the engine applies when one goes out. */
  touch(kind: 'hello' | 'invite' | 'thanks', at: Date): void {
    const channel = this.person.channel ?? this.demo.channel;
    this.record('out', kind, at, outbound(kind, channel, this.demo, this.project));
    this.apply(afterSent(this.person, kind, at, this.demo.timezone));
  }

  /** They wrote back and the engine put them on the dock (or out of it, for someone the user already answered). */
  heard(reply: Pick<Reply, 'kind' | 'suggested' | 'text'>, at: Date): void {
    const channel = this.person.channel ?? this.demo.channel;
    this.record('in', 'inbound', at, { subject: channel === 'email' ? `Re: Quick question, ${this.demo.firstName}` : null, body: reply.text });
    const { patch } = onInbound(this.person, { kind: reply.kind, suggested: reply.suggested, returnDate: null }, reply.text, at, this.demo.timezone);
    this.apply(patch);
  }

  /** The user answered from the dock. */
  answered(at: Date): void {
    const channel = this.person.channel ?? this.demo.channel;
    this.record('out', 'reply', at, outbound('reply', channel, this.demo, this.project));
    this.apply(afterUserSent(this.person, 'reply', at));
  }
}

function seedMorning(ctx: Ctx): void {
  const { repo } = ctx;
  const now = ctx.clock.now();
  const nominalStart = now.getTime() - 3 * DAY;

  connectChannels(ctx, new Date(nominalStart - DAY));
  repo.updateSettings({
    senderName: SENDER_NAME, senderEmail: SENDER_EMAIL, timezone: 'Africa/Lagos', onboarded: true,
  });

  const reconciliation = repo.insertProject({ ...RECONCILIATION, calendarUrl: CALENDAR_URL });
  const payroll = repo.insertProject({ ...PAYROLL, calendarUrl: CALENDAR_URL });
  repo.updateSettings({ currentProjectId: reconciliation.id });

  let earliest = Number.POSITIVE_INFINITY;
  const note = (at: Date): void => {
    earliest = Math.min(earliest, at.getTime());
  };

  DEMO_PEOPLE.forEach((d, i) => {
    const person = addPerson(ctx, reconciliation.id, d);
    if (i >= STRANGERS_FROM) return;
    const scribe = new Scribe(ctx, person, d, reconciliation);
    const first = workSlot(now, d.timezone, i < FIRST_DAY_COUNT ? 2 : 1, i);
    note(first);
    const kind = d.channel === 'linkedin' ? 'invite' : 'hello';
    scribe.touch(kind, first);

    const dock = DOCK[i];
    if (dock) {
      scribe.heard(dock, new Date(now.getTime() - dock.ago));
      scribe.apply({ draft: dock.draft });
    } else if (i === TUNDE) {
      const wrote = new Date(Math.min(first.getTime() + 20 * HOUR, now.getTime() - 6 * HOUR));
      scribe.heard({ kind: 'interested', suggested: 'reply', text: 'This looks relevant. Could you send a short example?' }, wrote);
      scribe.answered(new Date(wrote.getTime() + 2 * HOUR));
    } else if (FOLLOWING.has(i)) {
      const accepted = new Date(first.getTime() + 3 * HOUR);
      scribe.apply(onAccepted(scribe.current, accepted, d.timezone));
      const due = new Date(scribe.current.nextTouchAt ?? accepted.toISOString());
      // The thank-you goes at 11:00 the next working day, but never after this moment.
      scribe.touch('thanks', new Date(Math.min(due.getTime(), now.getTime() - 30 * 60_000)));
    }
  });
  repo.updateProject(reconciliation.id, {
    startedAt: new Date(Math.min(nominalStart, earliest - HOUR)).toISOString(), approvalsLeft: 0,
  });

  // Payroll: four hellos have gone out, each one OKed, and Yaw has already written back.
  earliest = Number.POSITIVE_INFINITY;
  let sent = 0;
  PAYROLL_PEOPLE.forEach((d, i) => {
    const person = addPerson(ctx, payroll.id, d);
    if (i >= 4) return;
    const scribe = new Scribe(ctx, person, d, payroll);
    const first = workSlot(now, d.timezone, 2, i + 5);
    note(first);
    scribe.touch('hello', first);
    sent += 1;
    if (i === 0) {
      scribe.heard(YAW_REPLY, new Date(now.getTime() - YAW_REPLY.ago));
      scribe.apply({ draft: YAW_REPLY.draft });
    }
  });
  repo.updateProject(payroll.id, {
    startedAt: new Date(Math.min(nominalStart, earliest - HOUR)).toISOString(), approvalsLeft: 10 - sent,
  });
}
