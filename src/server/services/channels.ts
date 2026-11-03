import type { Channel, ChannelAccount } from '../../shared/types.js';
import { OAuthError, pollDeviceToken, startDeviceCode, type DeviceCode, type OAuthOptions } from '../channels/microsoft-oauth.js';
import { ConnectError } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { emailDailyCap, LINKEDIN_HALF_PACE_CAP, LINKEDIN_INVITE_CAP, X_DAILY_CAP } from '../engine/pacing.js';
import { UserError } from './errors.js';

export interface Pending { invites: number; followUps: number; emails: number; messages: number }
export interface ChannelSummary { pending: Pending; paceLine: string }

// ---- what is waiting, and how fast ---------------------------------------------------------------------

/** Scheduled and awaiting-OK items on a channel, in the words the disconnect confirm uses. */
export function pendingFor(ctx: Ctx, ch: Channel): Pending {
  const out: Pending = { invites: 0, followUps: 0, emails: 0, messages: 0 };
  for (const item of ctx.repo.listOutbox({ state: ['scheduled', 'awaiting_ok'] })) {
    if (item.channel !== ch) continue;
    if (item.kind === 'invite') out.invites += 1;
    else if (ch === 'email') out.emails += 1;
    else if (ch === 'x') out.messages += 1;
    else if (item.kind === 'follow_up' || item.kind === 'thanks') out.followUps += 1;
    else out.messages += 1;
  }
  return out;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayParts(date: Date, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** `Thursday` inside the coming week, then `20 Nov`. */
function dayName(iso: string, tz: string, now: Date): string {
  const at = dayParts(new Date(iso), tz);
  const here = dayParts(now, tz);
  const ahead = (Date.UTC(at.y, at.m - 1, at.d) - Date.UTC(here.y, here.m - 1, here.d)) / 86_400_000;
  if (ahead >= 1 && ahead < 7) return WEEKDAYS[new Date(Date.UTC(at.y, at.m - 1, at.d)).getUTCDay()] ?? '';
  return `${at.d} ${MONTHS[at.m - 1] ?? ''}`;
}

/** How many projects share the channels, as a phrase: `both projects`, `all 3 projects`; null with one. */
function sharedBy(ctx: Ctx): string | null {
  const live = ctx.repo.listProjects().filter((p) => p.state !== 'wrapped').length;
  if (live < 2) return null;
  return live === 2 ? 'both projects' : `all ${live} projects`;
}

/** One line on how fast Callum writes on a channel right now. */
export function paceLine(ctx: Ctx, ch: Channel): string {
  const now = ctx.clock.now();
  const shared = sharedBy(ctx);
  const across = shared ? ` across ${shared}` : '';
  const account = ctx.repo.getChannel(ch);
  switch (ch) {
    case 'email': {
      const cap = emailDailyCap(account.connectedAt ? new Date(account.connectedAt) : now, now);
      const [lead, tail] = cap === 20 ? ['20', ', 120 by week 3'] : cap === 70 ? ['70', ', 120 from next week'] : ['120', ''];
      if (shared) return `${lead} emails a day${across}${tail}`;
      return cap === 120 ? '120 a day' : `${lead} a day this week${tail}`;
    }
    case 'linkedin': {
      const tz = ctx.repo.getSettings().timezone;
      const half = account.halfPaceUntil && new Date(account.halfPaceUntil).getTime() > now.getTime() ? account.halfPaceUntil : null;
      const blocked = account.invitesBlockedUntil && new Date(account.invitesBlockedUntil).getTime() > now.getTime() ? account.invitesBlockedUntil : null;
      if (blocked) return `No invites until ${dayName(blocked, tz, now)}, then ${LINKEDIN_INVITE_CAP} a day`;
      if (half) return `${LINKEDIN_HALF_PACE_CAP} invites a day${across} until ${dayName(half, tz, now)}, then ${LINKEDIN_INVITE_CAP}`;
      return `${LINKEDIN_INVITE_CAP} invites a day${across}, runs on this computer while Callum is open`;
    }
    case 'x':
      return `${X_DAILY_CAP} messages a day${across}`;
  }
}

export function channelSummary(ctx: Ctx, ch: Channel): ChannelSummary {
  return { pending: pendingFor(ctx, ch), paceLine: paceLine(ctx, ch) };
}

// ---- resuming a stopped channel ------------------------------------------------------------------------

const NAME_OF: Record<Channel, string> = { email: 'Email', linkedin: 'LinkedIn', x: 'X' };
const SIGNED_OUT_INCIDENT = { email: 'mailbox_signed_out', linkedin: 'linkedin_signed_out', x: 'x_signed_out' } as const;

/**
 * Throws, in plain words, when a channel cannot simply be resumed: it is signed out (resuming would call it connected
 * without signing in), X is out of room for today, or LinkedIn asked to check it's the user. `checked` is the user's own
 * word that they finished LinkedIn's check; only the incident card sends it, so Ask and a stray request cannot.
 */
export function assertCanResume(ctx: Ctx, ch: Channel, opts: { checked?: boolean } = {}): void {
  const name = NAME_OF[ch];
  const open = ctx.repo.listIncidents({ open: true }).filter((i) => i.channel === ch);
  if (ctx.repo.getChannel(ch).status === 'error' || open.some((i) => i.kind === SIGNED_OUT_INCIDENT[ch])) {
    throw new UserError(`${name} signed Callum out. Reconnect ${name} first, from Your Callum or the notice on your home screen.`);
  }
  if (open.some((i) => i.kind === 'x_limit')) {
    throw new UserError("X is out of room for today, so Callum can't resume it yet. It starts again by itself tomorrow.");
  }
  if (open.some((i) => i.kind === 'linkedin_check') && opts.checked !== true) {
    throw new UserError("LinkedIn asked to check it's you. Finish the check on LinkedIn first, then press Resume LinkedIn on the notice on your home screen.");
  }
}

// ---- connect and disconnect ----------------------------------------------------------------------------

/** Signs in to a channel through the registry. A refusal leaves as a UserError with the adapter's own words. */
export async function connectChannel(ctx: Ctx, ch: Channel, input: Record<string, string>): Promise<ChannelAccount> {
  try {
    const account = await ctx.adapters.connect(ch, input, ctx.clock.now());
    // Emails go out from the connected address, so it is also the one Callum reads the company site from.
    if (ch === 'email' && account.identity) {
      ctx.repo.updateSettings({ senderEmail: account.identity });
      ctx.bus.emit('settings');
    }
    return account;
  } catch (err) {
    if (err instanceof ConnectError) throw new UserError(err.message);
    throw err;
  }
}

export function disconnectChannel(ctx: Ctx, ch: Channel): Promise<ChannelAccount> {
  return ctx.adapters.disconnect(ch);
}

// ---- Microsoft device-code sign-in ---------------------------------------------------------------------

const CLIENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SETUP_FIRST = 'Microsoft needs a one-time app setup on this computer first.';
const NO_SIGN_IN = 'Start the Microsoft sign-in first.';

type Env = Record<string, string | undefined>;

export interface MicrosoftSetup { configured: boolean; source: 'env' | 'settings' | null }
export interface DeviceCodeStart { userCode: string; verificationUri: string; expiresAt: string }
export type DevicePoll =
  | { status: 'waiting' | 'expired' | 'denied' }
  | { status: 'connected'; account: ChannelAccount };

function clientIdOf(ctx: Ctx, env: Env): { id: string; source: 'env' | 'settings' } | null {
  const fromEnv = env.CALLUM_MICROSOFT_CLIENT_ID?.trim();
  if (fromEnv) return { id: fromEnv, source: 'env' };
  const fromSettings = ctx.repo.getSettings().microsoftClientId?.trim();
  return fromSettings ? { id: fromSettings, source: 'settings' } : null;
}

/** Whether Microsoft sign-in can start: `CALLUM_MICROSOFT_CLIENT_ID` wins, then the id saved from Your Callum. */
export function microsoftSetup(ctx: Ctx, env: Env = process.env): MicrosoftSetup {
  // Demo mode has no real Microsoft to set up; the demo code works without an app registration.
  if (ctx.demo) return { configured: true, source: null };
  const found = clientIdOf(ctx, env);
  return { configured: found !== null, source: found?.source ?? null };
}

/** Keeps the app registration id in settings, for the desktop app, which has no environment to set it in. */
export function saveMicrosoftClientId(ctx: Ctx, clientId: string): MicrosoftSetup {
  const id = clientId.trim().toLowerCase();
  if (!CLIENT_ID_SHAPE.test(id)) {
    throw new UserError("That doesn't look like an application (client) ID. Copy the whole value from your app's overview page in Azure.");
  }
  ctx.repo.updateSettings({ microsoftClientId: id });
  ctx.bus.emit('settings');
  return microsoftSetup(ctx, {});
}

interface PendingSignIn {
  clientId: string;
  address: string;
  device: DeviceCode;
  expiresAtMs: number;
  nextAskMs: number;
  demo: boolean;
}
// One sign-in at a time per Callum: starting again replaces the old code.
const signIns = new WeakMap<Ctx, PendingSignIn>();

const ADDRESS = /^[^@\s]+@[^@\s]+$/;

function oauthFailure(err: unknown, lead: string): UserError {
  if (err instanceof OAuthError) return new UserError(`${lead} ${err.message}`);
  return new UserError("Couldn't reach Microsoft. Check your connection and try again.");
}

/** Asks Microsoft for a short code the person enters on microsoft.com/devicelogin. */
export async function microsoftStart(ctx: Ctx, input: { address?: string }, env: Env = process.env, oauth: OAuthOptions = {}): Promise<DeviceCodeStart> {
  const address = (input.address ?? '').trim();
  if (!ADDRESS.test(address)) throw new UserError('Add the email address to send from.');
  const now = ctx.clock.now().getTime();

  if (ctx.demo) {
    const device: DeviceCode = { deviceCode: 'demo', userCode: 'DEMO-0000', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 };
    signIns.set(ctx, { clientId: 'demo', address, device, expiresAtMs: now + 900_000, nextAskMs: now, demo: true });
    return { userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: new Date(now + 900_000).toISOString() };
  }

  const found = clientIdOf(ctx, env);
  if (!found) throw new UserError(SETUP_FIRST);
  let device: DeviceCode;
  try {
    device = await startDeviceCode(found.id, { clock: ctx.clock, ...oauth });
  } catch (err) {
    throw oauthFailure(err, "Microsoft wouldn't start the sign-in.");
  }
  const expiresIn = Number.isFinite(device.expiresIn) ? device.expiresIn : 900;
  const expiresAtMs = now + expiresIn * 1000;
  signIns.set(ctx, { clientId: found.id, address, device, expiresAtMs, nextAskMs: now + device.interval * 1000, demo: false });
  return { userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Asks whether the code was entered. Connects the mailbox the moment it was. */
export async function microsoftPoll(ctx: Ctx, _input: { address?: string }, env: Env = process.env, oauth: OAuthOptions = {}): Promise<DevicePoll> {
  const pending = signIns.get(ctx);
  if (!pending) throw new UserError(NO_SIGN_IN);
  const now = ctx.clock.now().getTime();
  if (now >= pending.expiresAtMs) {
    signIns.delete(ctx);
    return { status: 'expired' };
  }
  // The address the code was started for; a later body cannot change who is being connected.
  const address = pending.address;

  if (pending.demo) {
    signIns.delete(ctx);
    return { status: 'connected', account: await connectChannel(ctx, 'email', { provider: 'microsoft', address }) };
  }

  // Microsoft asks callers to wait one interval between checks; the page may ask more often than that.
  if (now < pending.nextAskMs) return { status: 'waiting' };
  pending.nextAskMs = now + pending.device.interval * 1000;

  let result: Awaited<ReturnType<typeof pollDeviceToken>>;
  try {
    result = await pollDeviceToken(pending.clientId, pending.device.deviceCode, { clock: ctx.clock, ...oauth });
  } catch (err) {
    // A network blip is not the end of the sign-in: the code is still good, so keep waiting.
    if (!(err instanceof OAuthError)) return { status: 'waiting' };
    signIns.delete(ctx);
    throw oauthFailure(err, "Microsoft didn't finish the sign-in.");
  }
  if (result.status === 'waiting' && result.slowDown) {
    pending.device = { ...pending.device, interval: pending.device.interval + 5 };
    pending.nextAskMs = now + pending.device.interval * 1000;
  }
  if (result.status === 'waiting') return { status: 'waiting' };
  signIns.delete(ctx);
  if (result.status !== 'connected') return { status: result.status };
  const account = await connectChannel(ctx, 'email', {
    provider: 'microsoft',
    address,
    clientId: pending.clientId,
    refreshToken: result.refreshToken,
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.expiresAt,
  });
  return { status: 'connected', account };
}
