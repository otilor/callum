import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Correction, Settings } from '../../shared/types.js';
import { ConnectError } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { seedScene } from '../demo/seed.js';
import { FindError } from '../leads/finder.js';
import { ImportFileError } from '../leads/parse.js';
import { resumeChannel } from '../runner/incidents.js';
import * as actions from '../services/actions.js';
import { UserError } from '../services/errors.js';
import * as ask from '../services/ask.js';
import { assertCanResume } from '../services/channels.js';
import * as leave from '../services/leave.js';
import * as onboarding from '../services/onboarding.js';
import * as projects from '../services/projects.js';
import { getState } from '../services/state.js';
import { createAuth } from './auth.js';
import {
  channelParam, idParam, needText, optBool, optionalProjectId, optText, projectIdOf, readBody, toneOf, validTimezone, wholeNumber,
} from './http.js';
import { importLeads, MAX_FIND, searchLeads } from './leads.js';
import { eventStream } from './sse.js';
import { staticHandler } from './static.js';
import { afterSaved } from '../services/common.js';
import { planProjectNow } from '../runner/runner.js';
import { offerFromSite, offerWithSite, siteDomain } from '../runner/offer.js';

export interface AppOptions {
  password: string | null;
  /** The built web app (dist/web). Not served when null. */
  webDir: string | null;
  /** Asked to look for work after every change, so a send that is due goes out promptly. */
  runner?: { tick(): Promise<unknown> };
  /** Route modules from other parts of Callum (see features.ts); their paths are relative to /api. */
  extraRoutes?: Hono[];
  /** Behind a reverse proxy (CALLUM_TRUST_PROXY=1): the sign-in lockout counts X-Forwarded-For. */
  trustProxy?: boolean;
  /** Where a failure nobody expected is reported. Defaults to the console. */
  onError?: (err: unknown) => void;
}

export const TOO_LARGE = "That's too large for Callum. Try a smaller file.";
export const BODY_LIMIT = 10 * 1024 * 1024;
export const LOGIN_BODY_LIMIT = 16 * 1024;
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export const SOMETHING_WENT_WRONG = 'Something went wrong. Callum kept everything as it was.';
const NOT_FOUND = "Callum can't find that.";
const CORRECTIONS: Correction[] = ['auto_reply', 'wrong_person', 'never_contact'];
const DRAFT_KINDS = ['reply', 'booking', 'close'] as const;

function dayStamp(ctx: Ctx): string {
  return ctx.clock.now().toISOString().slice(0, 10);
}

export function createApp(ctx: Ctx, opts: AppOptions): Hono {
  const auth = createAuth({ password: opts.password, clock: ctx.clock, trustProxy: opts.trustProxy === true });
  const report = opts.onError ?? ((err: unknown) => console.error(`[callum] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  const app = new Hono();
  const api = new Hono();

  // ---- guards ----------------------------------------------------------------------------------------

  // Nobody may put Callum's page inside a frame on another site (click-jacking): every response says so, errors included.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  });

  // A page on another site must not be able to read from Callum or make the browser post to it, and without a
  // password a hostile name pointed at this computer (DNS rebinding) must not reach it either.
  app.use('/api/*', async (c, next) => {
    const refuse = () => c.json({ error: 'Callum only takes requests from its own page.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site') return refuse();
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      // Behind a proxy that rewrites Host, the page's own address arrives as X-Forwarded-Host (password mode only).
      const own = new Set([host]);
      const forwarded = opts.password !== null ? c.req.header('x-forwarded-host') : undefined;
      if (forwarded) own.add(forwarded);
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost === null || !own.has(originHost)) return refuse();
    }
    if (opts.password === null && !LOCAL_NAMES.has(hostnameOf(host))) return refuse();
    return next();
  });
  app.use('/api/login', bodyLimit({ maxSize: LOGIN_BODY_LIMIT, onError: (c) => c.json({ error: TOO_LARGE }, 413) }));
  app.use('/api/*', bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: TOO_LARGE }, 413) }));
  app.use('/api/*', auth.gate);
  // Every change wakes the runner, so a send that is due now does not wait for the next 5 seconds.
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.method === 'POST' && c.res.status < 400 && c.req.path !== '/api/login' && c.req.path !== '/api/logout') {
      opts.runner?.tick().catch(report);
    }
  });

  app.onError((err, c) => {
    if (err instanceof UserError) {
      return c.json({ error: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) }, err.status as ContentfulStatusCode);
    }
    if (err instanceof ConnectError || err instanceof FindError || err instanceof ImportFileError) {
      return c.json({ error: err.message }, 422);
    }
    report(err);
    return c.json({ error: SOMETHING_WENT_WRONG }, 500);
  });

  // ---- access and live events ------------------------------------------------------------------------

  api.post('/login', auth.login);
  api.post('/logout', auth.logout);
  api.get('/state', (c) => c.json(getState(ctx, { password: opts.password !== null })));
  api.get('/events', (c) => eventStream(ctx.bus, c.req.raw.signal));

  // The feature modules come first: a path they own (a person's page, connecting a channel) is theirs, not the generic one below.
  for (const routes of (opts.extraRoutes ?? [])) api.route('/', routes);

  // ---- channels --------------------------------------------------------------------------------------

  api.post('/channels/:ch/resume', async (c) => {
    const ch = channelParam(c);
    const body = await readBody(c);
    const { pace } = body;
    if (pace !== 'half' && pace !== 'full') throw new UserError('Pick half pace or full pace.');
    if (ctx.repo.getChannel(ch).status === 'disconnected') throw new UserError('Connect it first.');
    assertCanResume(ctx, ch, { checked: body.checked === true });
    return c.json(resumeChannel(ctx, ch, pace));
  });

  // ---- settings and first run ------------------------------------------------------------------------

  api.post('/settings', async (c) => {
    const b = await readBody(c);
    const patch: Partial<Settings> = {};
    if (b.senderName !== undefined) {
      if (b.senderName !== null && typeof b.senderName !== 'string') throw new UserError('Callum needs a name for that.');
      patch.senderName = typeof b.senderName === 'string' && b.senderName.trim() !== '' ? b.senderName.trim() : null;
    }
    if (b.timezone !== undefined) {
      if (typeof b.timezone !== 'string' || !validTimezone(b.timezone)) throw new UserError("Callum doesn't know that time zone.");
      patch.timezone = b.timezone;
    }
    if (b.notifications !== undefined) {
      if (b.notifications !== null && typeof b.notifications !== 'boolean') throw new UserError('Pick on or off.');
      patch.notifications = b.notifications;
    }
    if (b.morningBrief !== undefined) {
      if (typeof b.morningBrief !== 'boolean') throw new UserError('Pick on or off.');
      patch.morningBrief = b.morningBrief;
    }
    if (b.openAtLogin !== undefined) {
      if (typeof b.openAtLogin !== 'boolean') throw new UserError('Pick on or off.');
      patch.openAtLogin = b.openAtLogin;
    }
    const next = ctx.repo.updateSettings(patch);
    ctx.bus.emit('settings');
    return c.json(next);
  });
  api.get('/offer/suggest', async (c) => c.json({ offer: await onboarding.suggestOffer(ctx) }));
  // A website the user typed: what its company does, in a line Callum can write from.
  api.post('/offer/site', async (c) => {
    const b = await readBody(c);
    const site = typeof b.site === 'string' ? b.site : '';
    if (!siteDomain(site)) throw new UserError('Type a website, like yourcompany.com.');
    return c.json(await offerFromSite(ctx, site));
  });
  api.get('/sample', async (c) => {
    const tone = toneOf(c.req.query('tone'));
    return c.json(await onboarding.sample(ctx, projectIdOf(ctx, c.req.query('projectId')), tone));
  });
  api.get('/plan', (c) => c.json(onboarding.planPreview(ctx, projectIdOf(ctx, c.req.query('projectId')))));

  // ---- projects --------------------------------------------------------------------------------------

  api.get('/projects', (c) => c.json(ctx.repo.listProjects()));
  api.post('/projects', async (c) => {
    const b = await readBody(c);
    const name = optText(b, 'name');
    const audience = optText(b, 'audience');
    return c.json(
      await projects.createProject(ctx, {
        offer: needText(b, 'offer', 'what you offer'),
        ...(name !== undefined ? { name } : {}),
        ...(audience !== undefined ? { audience } : {}),
        ...(b.tone !== undefined ? { tone: toneOf(b.tone) } : {}),
      }),
    );
  });
  // Registered before /projects/:id so that "current" is not read as an id.
  api.post('/projects/current', async (c) => {
    const id = wholeNumber((await readBody(c)).id);
    if (id === null) throw new UserError("Callum can't find that project.", 404);
    projects.setCurrentProject(ctx, id);
    return c.json(ctx.repo.getSettings());
  });
  api.post('/projects/:id', async (c) => {
    const id = idParam(c);
    const b = await readBody(c);
    const patch: projects.ProjectPatch = {};
    for (const key of ['offer', 'audience', 'sample', 'calendarUrl'] as const) {
      const v = b[key];
      if (v === undefined) continue;
      if (v !== null && typeof v !== 'string') throw new UserError(`Callum can't read the ${key} you sent.`);
      patch[key] = v;
    }
    if (b.tone !== undefined) patch.tone = toneOf(b.tone);
    const name = optText(b, 'name');
    let project = ctx.repo.getProject(id);
    if (!project) throw new UserError("Callum can't find that project.", 404);
    // A website is read, so "tethers.com" is enough to say what the user does.
    if (typeof patch.offer === 'string' && patch.offer.trim() !== (project.offer ?? '').trim()) patch.offer = (await offerWithSite(ctx, patch.offer)) ?? patch.offer;
    // All or nothing: a name that is taken must not leave the other changes half made.
    ctx.repo.transaction(() => {
      project = projects.updateProject(ctx, id, patch);
      if (name !== undefined) project = projects.renameProject(ctx, id, name);
    });
    // New words: the hellos waiting for an OK (taken back) or for the offer are written now, not at the next tick.
    if (patch.offer !== undefined || patch.tone !== undefined) await afterSaved(ctx, () => planProjectNow(ctx, id, { early: true }));
    return c.json(project);
  });
  api.post('/projects/:id/pause', async (c) => {
    const { until } = await readBody(c);
    if (until !== undefined && until !== null && typeof until !== 'string') throw new UserError('Pick a date Callum can read.');
    return c.json(projects.pauseProject(ctx, idParam(c), until ?? null));
  });
  api.post('/projects/:id/resume', (c) => c.json(projects.resumeProject(ctx, idParam(c))));
  api.post('/projects/:id/wrap', (c) => c.json(projects.wrapProject(ctx, idParam(c))));

  // ---- people to write to ----------------------------------------------------------------------------

  api.post('/leads/import', async (c) => {
    const b = await readBody(c);
    const csv = optText(b, 'csv');
    const paste = optText(b, 'paste');
    const linkedinSearchUrl = optText(b, 'linkedinSearchUrl');
    return c.json(
      await importLeads(ctx, projectIdOf(ctx, b.projectId), {
        ...(csv !== undefined ? { csv } : {}),
        ...(paste !== undefined ? { paste } : {}),
        ...(linkedinSearchUrl !== undefined ? { linkedinSearchUrl } : {}),
      }),
    );
  });
  api.post('/leads/search', async (c) => {
    const b = await readBody(c);
    const query = needText(b, 'query', 'a few words about who to find');
    const count = b.count === undefined ? undefined : wholeNumber(b.count);
    if (count === null || (count !== undefined && (count < 1 || count > MAX_FIND))) throw new UserError(`Pick between 1 and ${MAX_FIND} people to look for.`);
    return c.json(await searchLeads(ctx, projectIdOf(ctx, b.projectId), query, count));
  });
  api.post('/start', async (c) => c.json(await onboarding.start(ctx, projectIdOf(ctx, (await readBody(c)).projectId))));

  // ---- the dock --------------------------------------------------------------------------------------

  api.post('/outbox/:id/approve', async (c) => c.json(actions.approve(ctx, idParam(c), optText(await readBody(c), 'body'))));
  api.post('/outbox/:id/skip', async (c) => {
    const id = idParam(c);
    await actions.skip(ctx, id);
    return c.json(ctx.repo.getOutbox(id));
  });
  api.post('/outbox/:id/undo', (c) => c.json(actions.undo(ctx, idParam(c))));
  api.post('/outbox/:id/retry', async (c) => c.json(actions.retry(ctx, idParam(c), { again: optBool(await readBody(c), 'again') === true })));
  // The user fixed the words of a message Callum would not send (a blank left in it).
  api.post('/outbox/:id/edit', async (c) => {
    const b = await readBody(c);
    const subject = b.subject === undefined ? undefined : b.subject === null ? null : optText(b, 'subject');
    return c.json(actions.editBlocked(ctx, idParam(c), needText(b, 'body', 'a message'), subject));
  });

  // ---- notices ---------------------------------------------------------------------------------------

  api.post('/incidents/:id/dismiss', (c) => c.json(actions.dismissIncident(ctx, idParam(c))));

  // ---- a person --------------------------------------------------------------------------------------

  api.get('/people/:id/draft', async (c) => {
    const kind = DRAFT_KINDS.find((k) => k === c.req.query('kind'));
    if (!kind) throw new UserError('Pick reply, booking or close.');
    return c.json({ body: await actions.draft(ctx, idParam(c), kind) });
  });
  api.post('/people/:id/reply', async (c) => c.json(actions.reply(ctx, idParam(c), needText(await readBody(c), 'body', 'a message'))));
  api.post('/people/:id/book', async (c) => c.json(await actions.book(ctx, idParam(c), optText(await readBody(c), 'body'))));
  api.post('/people/:id/close', async (c) => c.json(await actions.close(ctx, idParam(c), optText(await readBody(c), 'body'))));
  api.post('/people/:id/snooze', async (c) => c.json(actions.snooze(ctx, idParam(c), optText(await readBody(c), 'until'))));
  api.post('/people/:id/correct', async (c) => {
    const asked = (await readBody(c)).kind;
    const kind = CORRECTIONS.find((k) => k === asked);
    if (!kind) throw new UserError('Pick what Callum got wrong.');
    return c.json(actions.correct(ctx, idParam(c), kind));
  });
  api.post('/people/:id/nudge', (c) => c.json(actions.nudge(ctx, idParam(c))));
  api.post('/people/:id/hold', (c) => c.json(actions.hold(ctx, idParam(c))));
  api.post('/people/:id/resume', (c) => c.json(actions.resume(ctx, idParam(c))));
  api.post('/people/:id/remove', (c) => c.json(actions.remove(ctx, idParam(c))));
  api.post('/people/:id/move', async (c) => {
    const to = wholeNumber((await readBody(c)).projectId);
    if (to === null) throw new UserError("Callum can't find that project.", 404);
    return c.json(projects.moveToProject(ctx, idParam(c), to));
  });

  // ---- ask -------------------------------------------------------------------------------------------

  api.post('/ask', async (c) => {
    const b = await readBody(c);
    return c.json(await ask.ask(ctx, projectIdOf(ctx, b.projectId), needText(b, 'text', 'a question')));
  });
  api.post('/ask/act', async (c) => {
    const b = await readBody(c);
    const action = b.action as { args?: unknown } | null | undefined;
    if (!action || typeof action !== 'object' || Array.isArray(action) || !action.args || typeof action.args !== 'object' || Array.isArray(action.args)) {
      throw new UserError('Callum needs an action for that.');
    }
    return c.json(await ask.act(ctx, projectIdOf(ctx, b.projectId), b.action as Parameters<typeof ask.act>[2]));
  });

  // ---- leaving ---------------------------------------------------------------------------------------

  api.post('/pause', async (c) => {
    const { until } = await readBody(c);
    if (until !== undefined && until !== null && typeof until !== 'string') throw new UserError('Pick a date Callum can read.');
    leave.pauseUntil(ctx, until ?? null);
    return c.json(ctx.repo.getSettings());
  });
  api.post('/resume', (c) => {
    leave.resumeAll(ctx);
    return c.json(ctx.repo.getSettings());
  });
  api.post('/wrap', async (c) => {
    const deleteData = optBool(await readBody(c), 'deleteData') ?? false;
    return c.json(await leave.wrapUpEverything(ctx, { deleteData }));
  });
  api.get('/wrap/summary', (c) => c.json({ line: leave.wrapSummaryLine(ctx) }));
  api.post('/start-again', (c) => {
    leave.startAgain(ctx);
    return c.json(ctx.repo.getSettings());
  });
  api.get('/export.json', (c) =>
    c.body(JSON.stringify(leave.exportJson(ctx, optionalProjectId(ctx, c.req.query('projectId'))), null, 2), 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="callum-export-${dayStamp(ctx)}.json"`,
      'cache-control': 'no-store',
    }),
  );
  api.get('/export.csv', (c) =>
    c.body(leave.exportCsv(ctx, optionalProjectId(ctx, c.req.query('projectId'))), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="callum-export-${dayStamp(ctx)}.csv"`,
      'cache-control': 'no-store',
    }),
  );

  // ---- demo ------------------------------------------------------------------------------------------

  api.post('/demo/seed', async (c) => {
    if (!ctx.demo) return c.json({ error: NOT_FOUND }, 404);
    const { scene } = await readBody(c);
    if (scene !== 'fresh' && scene !== 'morning') throw new UserError("Callum doesn't have that scene.");
    seedScene(ctx, scene);
    return c.json({ ok: true, scene });
  });

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: NOT_FOUND }, 404));
  if (opts.webDir !== null) app.get('*', staticHandler(opts.webDir));
  return app;
}
