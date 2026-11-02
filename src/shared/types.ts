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

export interface Person {
  id: number; name: string; firstName: string;
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
export type NewPerson = Pick<Person, 'name' | 'source'> & Partial<Omit<Person, 'id' | 'name' | 'source' | 'createdAt' | 'updatedAt'>>;

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
  offer: string | null; audience: string | null; tone: Tone; sample: string | null;
  calendarUrl: string | null; timezone: string;
  onboarded: boolean; startedAt: string | null; approvalsLeft: number;
  pauseState: 'running' | 'paused' | 'wrapped'; pausedUntil: string | null;
  notifications: boolean | null;
}

export interface PathStep { label: string; at: string | null; done: boolean }
export interface Brief { wantToTalk: number; sentYesterday: number; acceptedRecently: string[]; nextSendAt: string | null; line: string }
export interface AppState {
  settings: Settings; channels: ChannelAccount[]; people: Person[];
  outbox: OutboxItem[]; incidents: Incident[]; brief: Brief; demo: boolean;
}
export type AskAction =
  | { kind: 'find_more'; label: string; args: { likePersonId: number | null; query: string | null; count: number } }
  | { kind: 'pause_channel' | 'resume_channel'; label: string; args: { channel: Channel } }
  | { kind: 'set_tone'; label: string; args: { tone: Tone } }
  | { kind: 'switch_channel'; label: string; args: { personIds: number[]; channel: Channel } };
export interface AskAnswer { text: string; personIds: number[]; action: AskAction | null }
export type Scope = 'people' | 'outbox' | 'incidents' | 'settings' | 'channels';
