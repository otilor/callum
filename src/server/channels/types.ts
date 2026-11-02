import type { Channel, OutKind, PersonLead } from '../../shared/types.js';
export interface Recipient { name: string; email: string | null; linkedinUrl: string | null; xHandle: string | null }
export interface OutboundMessage { to: Recipient; kind: OutKind; subject: string | null; body: string; inReplyTo: string | null }
export type ChannelErrorCode =
  | 'auth' | 'checkpoint' | 'weekly_limit' | 'rate_limit' | 'bounce' | 'invalid_recipient' | 'already_connected' | 'temporary' | 'unknown';
/** `messageId` is the Message-ID an email carried when it failed, so a person (or a later try) can look for it in Sent. */
export interface ChannelError { code: ChannelErrorCode; message: string; messageId?: string }

/** What the outbox keeps about a failed send: whether it may have left, and the Message-ID to look for. Null when there is nothing to keep. */
export function failureDetail(error: ChannelError): string | null {
  if (error.code !== 'unknown' && !error.messageId) return null;
  return JSON.stringify({ ...(error.code === 'unknown' ? { maybeSent: true } : {}), ...(error.messageId ? { messageId: error.messageId } : {}) });
}
/** `noteDropped` is set when an invitation went out without its note, so the app records what was really delivered. */
export type SendResult = { ok: true; externalId: string | null; noteDropped?: true } | { ok: false; error: ChannelError };
export type InboundEvent =
  | {
    type: 'reply';
    /** `linkedinAltUrl` is the member-id form of the profile when LinkedIn showed one and the vanity address was found. */
    from: { email?: string; linkedinUrl?: string; linkedinAltUrl?: string; xHandle?: string; name?: string };
    text: string; at: string; externalId: string | null;
    /** Email only: what the stop rule and the thread lookup read. */
    subject?: string | null; inReplyTo?: string | null; references?: string[];
  }
  | { type: 'accepted'; linkedinUrl: string; at: string }
  /** `externalId` is the DSN's own Message-ID. */
  | { type: 'bounce'; email: string; at: string; externalId: string | null }
  /** `externalId` is the Message-ID of the sent mail, so the runner can ignore Callum's own sends. */
  | { type: 'outbound_seen'; email: string; at: string; externalId: string | null }
  | { type: 'checkpoint'; at: string };
/** `message` is always plain words for the person; `code` lets callers tell a signed-out channel apart. */
export class ConnectError extends Error {
  constructor(message: string, readonly code?: ChannelErrorCode) {
    super(message);
  }
}
export interface ChannelAdapter {
  readonly channel: Channel;
  connect(input: Record<string, string>): Promise<{ identity: string; secret: Record<string, string> }>;
  send(msg: OutboundMessage): Promise<SendResult>;
  poll(since: Date | null): Promise<InboundEvent[]>;
  knownAddresses?(): Promise<string[]>;
  searchPeople?(url: string, limit: number): Promise<PersonLead[]>;
  /** Drops anything the adapter keeps on this machine for the account (a signed-in browser profile). */
  forget?(): Promise<void>;
  close(): Promise<void>;
}
/** What the registry hands every adapter so it can keep its own secret current (rotated tokens). */
export interface AdapterHooks { saveSecret(secret: Record<string, string>): void }
export type AdapterFactory = (channel: Channel, secret: Record<string, string> | null, hooks?: AdapterHooks) => ChannelAdapter;
