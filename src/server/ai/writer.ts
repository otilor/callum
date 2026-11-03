import type { Channel, Message, OutKind, Person, Project, ReplyKind, Settings, SuggestedAction, Tone } from '../../shared/types.js';
import { systemClock } from '../engine/clock.js';
import { ClaudeWriter } from './claude.js';
import { TemplateWriter } from './templates.js';

export interface WriteContext { person: Person; project: Project; settings: Settings; channel: Channel; history: Message[] }
export interface Classification {
  kind: ReplyKind; suggested: SuggestedAction; returnDate: string | null;
  referral: { name: string; email: string | null; context: string } | null; language: string;
}
export type AskIntent =
  | { intent: 'warm' } | { intent: 'why' } | { intent: 'unknown' }
  | { intent: 'find'; likePersonId: number | null; query: string | null; count: number }
  | { intent: 'pause' | 'resume'; channel: Channel }
  | { intent: 'tone'; tone: Tone }
  | { intent: 'switch'; personIds: number[]; channel: Channel };
/**
 * A message as written. `missing` is set instead when it could not be written well without something only the sender
 * knows (what they offer, said plainly): a short question for them, and the body is not to be sent.
 */
export interface Written { subject: string | null; body: string; missing?: string }
export interface Writer {
  write(kind: OutKind, ctx: WriteContext): Promise<Written>;
  classify(text: string, ctx: WriteContext): Promise<Classification>;
  offerLine(siteText: string, domain: string): Promise<string>;
  parseAsk(text: string, people: { id: number; name: string }[]): Promise<AskIntent>;
  projectName(offer: string): Promise<string>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Claude when there is an API key (with the template writer as the fallback for every call), else the template writer. */
export function createWriter(env: { ANTHROPIC_API_KEY?: string; CALLUM_MODEL?: string }): Writer {
  const templates = new TemplateWriter(systemClock);
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return templates;
  const model = env.CALLUM_MODEL?.trim() || DEFAULT_MODEL;
  return new ClaudeWriter(key, model, templates, undefined, systemClock);
}
