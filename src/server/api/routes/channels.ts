import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CHANNELS, type Channel } from '../../../shared/types.js';
import type { OAuthOptions } from '../../channels/microsoft-oauth.js';
import type { Ctx } from '../../context.js';
import {
  channelSummary, connectChannel, disconnectChannel, microsoftPoll, microsoftSetup, microsoftStart, saveMicrosoftClientId,
} from '../../services/channels.js';
import { UserError } from '../../services/errors.js';

export interface ChannelsRoutesOptions {
  /** Where `CALLUM_MICROSOFT_CLIENT_ID` is read from; the process environment unless a test says otherwise. */
  env?: Record<string, string | undefined>;
  /** Replaces Microsoft's endpoints in tests. */
  oauth?: OAuthOptions;
  /** Called after a channel was connected or disconnected, so the runner can act on it at once. */
  changed?: () => void;
}

const BROKEN = 'Something went wrong. Callum kept everything as it was.';

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await c.req.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Connect fields are plain strings; anything else a client sends is dropped. */
function fieldsOf(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value;
  return out;
}

function channelOf(c: Context): Channel {
  const ch = c.req.param('ch') as Channel;
  if (!CHANNELS.includes(ch)) throw new UserError('There is no such channel.', 404);
  return ch;
}

/** Routes under `/api`: connect, disconnect and summarise channels, and the Microsoft device-code sign-in. */
export function channelsRoutes(ctx: Ctx, opts: ChannelsRoutesOptions = {}): Hono {
  const app = new Hono();
  const env = () => opts.env ?? process.env;
  const oauth = opts.oauth ?? {};

  app.onError((err, c) => {
    if (err instanceof UserError) {
      return c.json({ error: err.message, ...(err.detail === undefined ? {} : { detail: err.detail }) }, err.status as ContentfulStatusCode);
    }
    return c.json({ error: BROKEN }, 500);
  });

  app.get('/channels/:ch/summary', (c) => c.json(channelSummary(ctx, channelOf(c))));

  app.post('/channels/:ch/connect', async (c) => {
    const ch = channelOf(c);
    const account = await connectChannel(ctx, ch, fieldsOf(await body(c)));
    opts.changed?.();
    return c.json(account);
  });

  app.post('/channels/:ch/disconnect', async (c) => {
    const account = await disconnectChannel(ctx, channelOf(c));
    opts.changed?.();
    return c.json(account);
  });

  app.get('/channels/email/microsoft/setup', (c) => c.json(microsoftSetup(ctx, env())));

  app.post('/channels/email/microsoft/setup', async (c) => {
    const { clientId } = await body(c);
    return c.json(saveMicrosoftClientId(ctx, typeof clientId === 'string' ? clientId : ''));
  });

  const addressOf = (raw: Record<string, unknown>) => (typeof raw.address === 'string' ? { address: raw.address } : {});

  app.post('/channels/email/microsoft/start', async (c) => c.json(await microsoftStart(ctx, addressOf(await body(c)), env(), oauth)));

  app.post('/channels/email/microsoft/poll', async (c) => {
    const result = await microsoftPoll(ctx, addressOf(await body(c)), env(), oauth);
    if (result.status === 'connected') opts.changed?.();
    return c.json(result);
  });

  return app;
}
