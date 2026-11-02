import type { Channel, OutKind, NewPerson } from '../../shared/types.js';
export interface Recipient { name: string; email: string | null; linkedinUrl: string | null; xHandle: string | null }
export interface OutboundMessage { to: Recipient; kind: OutKind; subject: string | null; body: string; inReplyTo: string | null }
export type ChannelErrorCode = 'auth' | 'checkpoint' | 'weekly_limit' | 'rate_limit' | 'bounce' | 'invalid_recipient' | 'temporary' | 'unknown';
export interface ChannelError { code: ChannelErrorCode; message: string }
export type SendResult = { ok: true; externalId: string | null } | { ok: false; error: ChannelError };
export type InboundEvent =
  | { type: 'reply'; from: { email?: string; linkedinUrl?: string; xHandle?: string; name?: string }; text: string; at: string; externalId: string | null }
  | { type: 'accepted'; linkedinUrl: string; at: string }
  | { type: 'bounce'; email: string; at: string }
  | { type: 'outbound_seen'; email: string; at: string }
  | { type: 'checkpoint'; at: string };
export class ConnectError extends Error {}
export interface ChannelAdapter {
  readonly channel: Channel;
  connect(input: Record<string, string>): Promise<{ identity: string; secret: Record<string, string> }>;
  send(msg: OutboundMessage): Promise<SendResult>;
  poll(since: Date | null): Promise<InboundEvent[]>;
  knownAddresses?(): Promise<string[]>;
  searchPeople?(url: string, limit: number): Promise<NewPerson[]>;
  close(): Promise<void>;
}
export type AdapterFactory = (channel: Channel, secret: Record<string, string> | null) => ChannelAdapter;
