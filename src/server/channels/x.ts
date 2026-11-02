import { systemClock, type Clock } from '../engine/clock.js';
import { normalizeXHandle } from '../db/handles.js';
import { ConnectError, type ChannelAdapter, type ChannelError, type InboundEvent, type OutboundMessage, type SendResult } from './types.js';

export interface XDeps {
  fetch?: typeof fetch;
  /** X API v2 root. Local test servers override it. */
  baseUrl?: string;
  /** OAuth 2.0 token endpoint used to refresh the access token. Defaults to `${baseUrl}/oauth2/token`. */
  tokenUrl?: string;
  clock?: Clock;
  /** Called with the full secret whenever the tokens rotate, so the app can store them. */
  onSecretChange?: (secret: Record<string, string>) => void;
}

const DEFAULT_BASE = 'https://api.x.com/2';
const REQUEST_TIMEOUT_MS = 20_000;
const LOOKBACK_MS = 3 * 86_400_000;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

const RATE_LIMIT_MESSAGE = "X stopped accepting Callum's messages because your X plan's daily limit is reached. DMs resume tomorrow.";
const NO_CREDITS_MESSAGE = "X stopped accepting Callum's messages because your X developer account is out of credits. Add credits in the X developer portal.";
const SIGNED_OUT_MESSAGE = 'X signed Callum out. Connect X again from Your Callum.';
const NO_READ_MESSAGE = "This X token can't read messages. Give the app Direct Messages read and write access, then connect again.";
const NO_DM_ACCESS_MESSAGE = "X didn't accept Callum's access. Check that your X plan includes direct messages.";

interface Tokens { accessToken: string; refreshToken: string | null; clientId: string | null; clientSecret: string | null }
interface Account extends Tokens { userId: string; username: string }
interface XResponse { status: number; body: Record<string, unknown> }

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

/** X answers "client not allowed to use this endpoint" with 403 too; that is a plan problem, not a bad recipient. */
function isClientForbidden(body: Record<string, unknown>): boolean {
  const reason = str(body.reason) ?? '';
  const type = str(body.type) ?? '';
  return reason.startsWith('client-') || type.includes('client-forbidden') || type.includes('unsupported-authentication') || str(body.title) === 'Client Forbidden';
}

function detail(body: Record<string, unknown>): string {
  return str(body.detail) ?? str(body.title) ?? str(record(list(body.errors)[0]).detail) ?? '';
}

function secretOf(account: Account): Record<string, string> {
  return {
    accessToken: account.accessToken,
    ...(account.refreshToken ? { refreshToken: account.refreshToken } : {}),
    ...(account.clientId ? { clientId: account.clientId } : {}),
    ...(account.clientSecret ? { clientSecret: account.clientSecret } : {}),
    userId: account.userId,
    username: account.username,
  };
}

function loadAccount(secret: Record<string, string> | null): Account | null {
  if (!secret?.accessToken || !secret.userId) return null;
  return {
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken || null,
    clientId: secret.clientId || null,
    clientSecret: secret.clientSecret || null,
    userId: secret.userId,
    username: secret.username ?? '',
  };
}

export function createXAdapter(secret: Record<string, string> | null, deps: XDeps = {}): ChannelAdapter {
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const tokenUrl = deps.tokenUrl ?? `${baseUrl}/oauth2/token`;
  const clock = deps.clock ?? systemClock;

  let account = loadAccount(secret);
  let refreshing: Promise<boolean> | null = null;
  const handleIds = new Map<string, string>();
  // Direct messages already reported by this adapter instance (polls overlap by design).
  const seen = new Set<string>();

  async function raw(method: string, url: string, token: string | null, payload?: { json?: unknown; form?: URLSearchParams; basic?: string }): Promise<XResponse> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload?.basic) headers.authorization = `Basic ${payload.basic}`;
    let body: string | undefined;
    if (payload?.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(payload.json);
    } else if (payload?.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = payload.form.toString();
    }
    const res = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // A non-JSON body (a proxy error page) carries no X error details.
    }
    return { status: res.status, body: record(parsed) };
  }

  /** Rotates the access token. X refresh tokens are single use, so one refresh runs at a time. */
  function refresh(tokens: Tokens): Promise<boolean> {
    if (!tokens.refreshToken || !tokens.clientId) return Promise.resolve(false);
    refreshing ??= (async () => {
      try {
        const res = await raw('POST', tokenUrl, null, {
          form: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken ?? '', client_id: tokens.clientId ?? '' }),
          // An app of type "Web App, Automated App or Bot" is a confidential client and must prove it with its secret.
          ...(tokens.clientSecret ? { basic: Buffer.from(`${tokens.clientId}:${tokens.clientSecret}`).toString('base64') } : {}),
        });
        const access = str(res.body.access_token);
        if (res.status !== 200 || !access) return false;
        tokens.accessToken = access;
        tokens.refreshToken = str(res.body.refresh_token) ?? tokens.refreshToken;
        // While connecting, `tokens` are not the stored account yet; connect returns them as the new secret.
        if (account && tokens === account) deps.onSecretChange?.(secretOf(account));
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function authed(tokens: Tokens, method: string, path: string, json?: unknown): Promise<XResponse> {
    const url = `${baseUrl}${path}`;
    const res = await raw(method, url, tokens.accessToken, json === undefined ? undefined : { json });
    if (res.status === 401 && (await refresh(tokens))) return raw(method, url, tokens.accessToken, json === undefined ? undefined : { json });
    return res;
  }

  function sendFailure(res: XResponse, who: string): ChannelError {
    if (res.status === 401) return { code: 'auth', message: SIGNED_OUT_MESSAGE };
    if (res.status === 402) return { code: 'rate_limit', message: NO_CREDITS_MESSAGE };
    if (res.status === 429) return { code: 'rate_limit', message: RATE_LIMIT_MESSAGE };
    if (res.status === 403) {
      if (isClientForbidden(res.body)) return { code: 'auth', message: NO_DM_ACCESS_MESSAGE };
      return { code: 'invalid_recipient', message: `${who} can't be messaged on X. ${detail(res.body)}`.trim() };
    }
    if (res.status === 404) return { code: 'invalid_recipient', message: `${who} wasn't found on X.` };
    if (res.status >= 500) return { code: 'temporary', message: 'X is not answering right now. Callum will try again.' };
    return { code: 'unknown', message: `X refused the message. ${detail(res.body)}`.trim() };
  }

  async function resolveUserId(tokens: Tokens, handle: string, who: string): Promise<{ id: string } | { error: ChannelError }> {
    const known = handleIds.get(handle);
    if (known) return { id: known };
    const res = await authed(tokens, 'GET', `/users/by/username/${encodeURIComponent(handle)}`);
    if (res.status !== 200) return { error: sendFailure(res, who) };
    const id = str(record(res.body.data).id);
    // X answers 200 with an `errors` list and no `data` for a handle that does not exist.
    if (!id) return { error: { code: 'invalid_recipient', message: `${who} wasn't found on X.` } };
    handleIds.set(handle, id);
    return { id };
  }

  function requireAccount(): Account {
    if (!account) throw new ConnectError(SIGNED_OUT_MESSAGE, 'auth');
    return account;
  }

  return {
    channel: 'x',

    async connect(input) {
      const accessToken = (input.accessToken ?? '').trim();
      if (!accessToken) throw new ConnectError('Add the X access token.');
      const tokens: Tokens = {
        accessToken,
        refreshToken: input.refreshToken?.trim() || null,
        clientId: input.clientId?.trim() || null,
        clientSecret: input.clientSecret?.trim() || null,
      };
      let res: XResponse;
      try {
        res = await authed(tokens, 'GET', '/users/me');
      } catch {
        throw new ConnectError("Couldn't reach X. Check your connection and try again.");
      }
      if (res.status === 401) throw new ConnectError("Couldn't sign in to X. Check the access token.");
      if (res.status === 403) throw new ConnectError(isClientForbidden(res.body) ? NO_DM_ACCESS_MESSAGE : "X wouldn't let Callum read this account. Check the access token.");
      if (res.status === 429) throw new ConnectError('X is asking Callum to slow down. Try again in a few minutes.');
      if (res.status >= 500) throw new ConnectError("Couldn't reach X right now. Try again in a few minutes.");
      const me = record(res.body.data);
      const id = str(me.id);
      const username = str(me.username)?.toLowerCase();
      if (res.status !== 200 || !id || !username) throw new ConnectError("Couldn't sign in to X. Check the access token.");
      // /users/me needs only read scopes; check the token can read messages too, or every send would later fail.
      let probe: XResponse;
      try {
        probe = await authed(tokens, 'GET', '/dm_events?max_results=1');
      } catch {
        throw new ConnectError("Couldn't reach X. Check your connection and try again.");
      }
      if (probe.status === 403) throw new ConnectError(isClientForbidden(probe.body) ? NO_DM_ACCESS_MESSAGE : NO_READ_MESSAGE);
      if (probe.status === 401) throw new ConnectError("Couldn't sign in to X. Check the access token.");
      if (probe.status >= 500) throw new ConnectError("Couldn't reach X right now. Try again in a few minutes.");
      account = { ...tokens, userId: id, username };
      handleIds.clear();
      return { identity: `@${username}`, secret: secretOf(account) };
    },

    async send(msg: OutboundMessage): Promise<SendResult> {
      if (!account) return { ok: false, error: { code: 'auth', message: SIGNED_OUT_MESSAGE } };
      const handle = normalizeXHandle(msg.to.xHandle);
      if (!handle) return { ok: false, error: { code: 'invalid_recipient', message: `${msg.to.name} has no X handle.` } };
      // Looking the person up changes nothing on X, so a failure there is safe to try again.
      let target: Awaited<ReturnType<typeof resolveUserId>>;
      try {
        target = await resolveUserId(account, handle, msg.to.name);
      } catch {
        return { ok: false, error: { code: 'temporary', message: "Couldn't reach X. Callum will try again." } };
      }
      if ('error' in target) return { ok: false, error: target.error };
      // The message itself may have been taken before the answer was lost, so a failure here is not tried again on its own.
      let res: XResponse;
      try {
        res = await authed(account, 'POST', `/dm_conversations/with/${encodeURIComponent(target.id)}/messages`, { text: msg.body });
      } catch {
        return { ok: false, error: { code: 'unknown', message: "Callum lost the connection to X while sending, so the message may have gone. Check X before trying again." } };
      }
      if (res.status === 200 || res.status === 201) return { ok: true, externalId: str(record(res.body.data).dm_event_id) };
      return { ok: false, error: sendFailure(res, msg.to.name) };
    },

    async poll(since) {
      const me = requireAccount();
      const cutoff = (since ?? new Date(clock.now().getTime() - LOOKBACK_MS)).getTime();
      const found: Array<{ at: number; event: InboundEvent }> = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({
          event_types: 'MessageCreate',
          'dm_event.fields': 'sender_id,text,created_at',
          expansions: 'sender_id',
          'user.fields': 'username',
          max_results: String(PAGE_SIZE),
        });
        if (token) query.set('pagination_token', token);
        let res: XResponse;
        try {
          res = await authed(me, 'GET', `/dm_events?${query.toString()}`);
        } catch {
          throw new Error("Couldn't reach X to check for replies.");
        }
        if (res.status === 401) throw new ConnectError(SIGNED_OUT_MESSAGE, 'auth');
        if (res.status === 429) throw new Error(RATE_LIMIT_MESSAGE);
        if (res.status === 402) throw new Error(NO_CREDITS_MESSAGE);
        if (res.status !== 200) throw new Error("X didn't answer Callum's check for replies.");

        const users = new Map(list(record(res.body.includes).users).flatMap((u) => (str(u.id) ? [[str(u.id) as string, u] as const] : [])));
        let reachedOld = false;
        for (const event of list(res.body.data)) {
          const at = Date.parse(str(event.created_at) ?? '');
          if (Number.isNaN(at)) continue;
          if (at < cutoff) {
            reachedOld = true;
            continue;
          }
          const id = str(event.id);
          const sender = str(event.sender_id);
          if (!sender || sender === me.userId || (id && seen.has(id))) continue;
          const user = users.get(sender);
          const handle = str(user?.username)?.toLowerCase();
          if (!handle) continue;
          if (id) seen.add(id);
          const name = str(user?.name);
          found.push({
            at,
            event: { type: 'reply', from: { xHandle: handle, ...(name ? { name } : {}) }, text: str(event.text) ?? '', at: new Date(at).toISOString(), externalId: id },
          });
        }
        token = str(record(res.body.meta).next_token);
        if (!token || reachedOld) break;
      }
      return found.sort((a, b) => a.at - b.at).map((f) => f.event);
    },

    async close() {},
  };
}
