export type Channel = 'email' | 'linkedin' | 'x';
export const CHANNELS: Channel[] = ['email', 'linkedin', 'x'];
export type Stage = 'stranger' | 'hello' | 'following' | 'talking';
export type PersonStatus = 'active' | 'waiting' | 'snoozed' | 'held' | 'resting' | 'stopped' | 'closed' | 'removed';
export type LeadSource = 'csv' | 'paste' | 'linkedin_search' | 'apollo' | 'referral' | 'demo';
export type MessageKind = 'hello' | 'invite' | 'thanks' | 'follow_up' | 'reply' | 'booking' | 'close' | 'inbound';
export type OutKind = Exclude<MessageKind, 'inbound'>;
export type OutboxState = 'awaiting_ok' | 'scheduled' | 'sent' | 'cancelled' | 'failed' | 'blocked';
export type ReplyKind = 'interested' | 'question' | 'not_now' | 'not_interested' | 'stop' | 'hostile' | 'out_of_office' | 'referral';
export type SuggestedAction = 'reply' | 'book' | 'snooze' | 'close';
export type Tone = 'warm' | 'direct' | 'playful';
export type IncidentKind = 'linkedin_check' | 'linkedin_weekly_limit' | 'mailbox_signed_out' | 'bounces' | 'x_limit' | 'send_failed';
export type Correction = 'auto_reply' | 'wrong_person' | 'never_contact';
export type ProjectState = 'running' | 'paused' | 'wrapped';

export interface Project {
  id: number; name: string;
  offer: string | null; audience: string | null; tone: Tone; sample: string | null; calendarUrl: string | null;
  approvalsLeft: number;              // first 10 hellos need an OK, per project
  startedAt: string | null;           // when Start was pressed for this project
  state: ProjectState; pausedUntil: string | null;
  createdAt: string; updatedAt: string;
}
export type NewProject = Pick<Project, 'name'> & Partial<Pick<Project, 'offer' | 'audience' | 'tone' | 'sample' | 'calendarUrl'>>;

export interface Person {
  id: number; projectId: number; name: string; firstName: string;
  company: string | null; role: string | null;
  email: string | null; linkedinUrl: string | null; xHandle: string | null;
  timezone: string | null;            // IANA; null means the user's time zone
  channel: Channel | null;
  stage: Stage; status: PersonStatus;
  touches: number;                    // outbound touches sent, 0..3
  lastTouchAt: string | null; nextTouchAt: string | null;
  linkedinState: 'none' | 'invited' | 'connected';
  invitedAt: string | null;
  snoozedUntil: string | null; restUntil: string | null;
  badge: 'sent' | 'booked' | null;
  replyKind: ReplyKind | null; suggested: SuggestedAction | null;
  draft: string | null; lastInbound: string | null; repliedAt: string | null;
  source: LeadSource; note: string | null;
  createdAt: string; updatedAt: string;
}
export type NewPerson = Pick<Person, 'name' | 'source' | 'projectId'> & Partial<Omit<Person, 'id' | 'name' | 'source' | 'projectId' | 'createdAt' | 'updatedAt'>>;
/** A person found by a lead source, before it is imported into a project. `row` is the line of the list they came from, when there is one. */
export type PersonLead = Omit<NewPerson, 'projectId'> & { row?: number };

export interface Message {
  id: number; personId: number; channel: Channel; direction: 'out' | 'in'; kind: MessageKind;
  subject: string | null; body: string; at: string; externalId: string | null;
}
export type NewMessage = Omit<Message, 'id'>;

export interface OutboxItem {
  id: number; personId: number; channel: Channel; kind: OutKind;
  subject: string | null; body: string; state: OutboxState; origin: 'auto' | 'user';
  sendAfter: string; undoUntil: string | null; error: string | null;
  approvalCounted: boolean;           // an approval was spent on this item (so undo gives it back)
  createdAt: string; updatedAt: string;
}
export type NewOutboxItem = Pick<OutboxItem, 'personId' | 'channel' | 'kind' | 'body' | 'state' | 'origin' | 'sendAfter'> & Partial<Pick<OutboxItem, 'subject' | 'undoUntil' | 'error' | 'approvalCounted'>>;

export interface Incident {
  id: number; channel: Channel; kind: IncidentKind; state: 'open' | 'resolved';
  message: string; detail: string | null; personId: number | null;
  createdAt: string; resolvedAt: string | null;
}
export type NewIncident = Pick<Incident, 'channel' | 'kind' | 'message'> & Partial<Pick<Incident, 'detail' | 'personId'>>;

export interface ChannelAccount {
  channel: Channel; status: 'disconnected' | 'connected' | 'paused' | 'error';
  identity: string | null; connectedAt: string | null;
  pausedUntil: string | null; halfPaceUntil: string | null; invitesBlockedUntil: string | null;
  lastPolledAt: string | null;
}

export interface Settings {
  senderName: string | null; senderEmail: string | null;
  timezone: string; onboarded: boolean;
  currentProjectId: number | null;    // the project last viewed
  pauseState: 'running' | 'paused' | 'wrapped'; pausedUntil: string | null;
  notifications: boolean | null;
}

export interface PathStep { label: string; at: string | null; done: boolean }
export interface Brief { wantToTalk: number; sentYesterday: number; acceptedRecently: string[]; nextSendAt: string | null; line: string }
export interface AppState {
  settings: Settings; projects: Project[]; channels: ChannelAccount[]; people: Person[];
  outbox: OutboxItem[]; incidents: Incident[]; brief: Brief; demo: boolean;
}
export type AskAction =
  | { kind: 'find_more'; label: string; args: { likePersonId: number | null; query: string | null; count: number } }
  | { kind: 'pause_channel' | 'resume_channel'; label: string; args: { channel: Channel } }
  | { kind: 'set_tone'; label: string; args: { tone: Tone } }
  | { kind: 'switch_channel'; label: string; args: { personIds: number[]; channel: Channel } };
export interface AskAnswer { text: string; personIds: number[]; action: AskAction | null }
export type Scope = 'people' | 'outbox' | 'incidents' | 'settings' | 'channels' | 'projects';

// Task 19: the weekly note and the quiet moments
/** Settings keys the weekly note and the quiet moments keep. `morningBrief` is Task 16's switch; it counts as on until it is set to false. */
export interface NoteSettings {
  morningBrief?: boolean;
  /** When the last weekly email went out (or was skipped because the week was empty). */
  lastWeeklyAt?: string | null;
  /** When the last weekly email send was tried and failed, so a failure is not retried every few seconds. */
  weeklyTriedAt?: string | null;
  /** The note the person last opened. */
  weeklySeenAt?: string | null;
  /** When the current pause began, as far as Callum has seen. */
  pausedSince?: string | null;
}
export interface WeeklyReply {
  id: number; first: string; booked: boolean;
  name: string; company: string | null; projectId: number;
  /** One plain sentence about where this stands, shown when the face is picked. */
  text: string;
  /** The same, as a line in the email. */
  mail: string;
}
export interface WeeklyWarm { id: number; first: string; projectId: number; text: string }
export interface WeeklyRest { count: number; backOn: string | null }
export interface WeeklyGroup {
  projectId: number; name: string; line: string;
  replied: WeeklyReply[]; warming: WeeklyWarm[]; resting: WeeklyRest;
}
export interface WeeklySuggestion { text: string; action: AskAction; projectId: number }
export interface WeeklyNote {
  title: string;
  /** When the note is dated: the Monday at 8:30 it covers the week before. */
  at: string;
  /** The user's first name, for the greeting. */
  senderFirst: string | null;
  hellos: number;
  replied: WeeklyReply[];
  line: string;
  warming: WeeklyWarm[];
  resting: WeeklyRest;
  suggestion: WeeklySuggestion | null;
  nextAt: string;
  /** One group per project, only when there is more than one project. */
  groups: WeeklyGroup[];
}
export interface WeeklyEmail { subject: string; text: string }
export interface WeeklyAnswer { note: WeeklyNote; email: WeeklyEmail; shouldOpen: boolean }

export interface AwayPerson {
  personId: number; projectId: number; first: string; name: string; company: string | null; role: string | null;
  /** The day they said they are back (YYYY-MM-DD), when the message gave one. */
  until: string | null;
  /** When Callum follows up. */
  followUpAt: string | null;
  /** What their auto-reply said, and when it came. */
  text: string; at: string;
}
export interface ReferralCard {
  personId: number; projectId: number; first: string; name: string; company: string | null;
  referrer: { id: number; first: string; name: string; company: string | null } | null;
  /** What the referrer said about them, starting after the name: `runs finance at Oko Pay`. */
  context: string | null;
  channel: Channel | null;
  subject: string | null; draft: string;
}
export interface SentHello { personId: number; name: string; channel: Channel; at: string; text: string }
export interface QuietSnapshot {
  projectId: number | null;
  /** Nobody is in the river yet. */
  empty: boolean;
  /** Hellos went out and nobody has answered yet. */
  day2: null | { sentYesterday: number; nextCount: number; nextAt: string | null; sent: SentHello[] };
  /** Every stranger has had a first hello. */
  used: null | { replied: { id: number; first: string }[]; repliedCount: number; finishing: number; finishBy: string | null };
  away: AwayPerson[];
  referrals: ReferralCard[];
  /** Callum has been paused for three days or more. */
  paused: null | { since: string; days: number; hellos: number; followUps: number };
}
