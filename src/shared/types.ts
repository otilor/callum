export type Channel = 'email' | 'linkedin' | 'x';
export const CHANNELS: Channel[] = ['email', 'linkedin', 'x'];
export type Stage = 'stranger' | 'hello' | 'following' | 'talking';
export type PersonStatus = 'active' | 'waiting' | 'snoozed' | 'held' | 'resting' | 'stopped' | 'closed' | 'removed';
export type LeadSource = 'csv' | 'paste' | 'linkedin_search' | 'apollo' | 'referral' | 'demo';
export type MessageKind = 'hello' | 'invite' | 'thanks' | 'follow_up' | 'reply' | 'booking' | 'close' | 'inbound';
export type OutKind = Exclude<MessageKind, 'inbound'>;
export type OutboxState = 'awaiting_ok' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed' | 'blocked';
export type ReplyKind = 'interested' | 'question' | 'not_now' | 'not_interested' | 'stop' | 'hostile' | 'out_of_office' | 'referral';
export type SuggestedAction = 'reply' | 'book' | 'snooze' | 'close';
export type Tone = 'warm' | 'direct' | 'playful';
export type IncidentKind =
  | 'linkedin_check' | 'linkedin_weekly_limit' | 'mailbox_signed_out' | 'x_signed_out' | 'linkedin_signed_out'
  | 'bounces' | 'x_limit' | 'send_failed' | 'reply_unread' | 'not_answering';
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
  claimedAt: string | null;           // set just before the channel is asked to send; an item left `sending` may have gone out
  detail: string | null;              // JSON the retry route reads: {"maybeSent":true} or {"thrown":true}
  createdAt: string; updatedAt: string;
}
export type NewOutboxItem = Pick<OutboxItem, 'personId' | 'channel' | 'kind' | 'body' | 'state' | 'origin' | 'sendAfter'> & Partial<Pick<OutboxItem, 'subject' | 'undoUntil' | 'error' | 'approvalCounted' | 'claimedAt' | 'detail'>>;

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
  /** Projects that Wrap up everything wrapped (so Start again can bring back exactly those). */
  wrappedByWrapUp?: number[];
  /** Desktop app only: open Callum when the computer starts. Off until the person turns it on. */
  openAtLogin?: boolean;
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

export type SkipReason = 'duplicate' | 'known' | 'stopped' | 'no_channel' | 'other_project';
/** Someone a list or a search turned up who was not added, and why. */
export interface Skipped {
  name: string;
  reason: SkipReason;
  /** The project the person is already in, for `other_project`. */
  projectName?: string;
  /** The line of the file or paste the person came from (1-based), when there is one. */
  row?: number;
}

// Task 17: a person, in full
export type PathState = 'done' | 'sun' | 'next' | 'later' | 'held' | 'stop' | 'rest';
/** A step of the path with how it should look: done, a reply (sun), what comes next, later, on hold, stopped or resting. */
export interface PersonPathStep extends PathStep { state: PathState }
/** Whether a button can be used, and when not, why. */
export interface Availability { ok: boolean; reason: string | null }
/** Another channel the person could move to. `available` false means the move cannot happen now and `reason` says why; true with a `reason` is a heads-up (a gap to wait out, an address to add). */
export interface Switchable { channel: Channel; at: string | null; reason: string | null; available: boolean }
/** Another running project the person could move to. `reason` is why not, when not. */
export interface ProjectMove { projectId: number; name: string; reason: string | null }
export interface PersonFull {
  person: Person; messages: Message[]; path: PersonPathStep[];
  next: string | null; why: string | null;
  switchable: Switchable[]; projectMoves: ProjectMove[];
  nudge: Availability;
  /** Set when the person is stopped or closed: the note the page shows in place of the actions. */
  closedNote: string | null;
  /** The name of the person's project. */
  projectName: string;
}
