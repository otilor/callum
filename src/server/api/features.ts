import type { Hono } from 'hono';
import type { Ctx } from '../context.js';
import { channelsRoutes } from './routes/channels.js';
import { keysRoutes } from './routes/keys.js';
import { peopleRoutes } from './routes/people.js';
import { personRoutes } from './routes/person.js';

/**
 * Route modules of the other parts of Callum. Each builds its routes for a ctx; paths are relative to /api.
 * They are mounted ahead of the generic routes in app.ts, so a path they own is theirs.
 */
export const FEATURE_ROUTES: ((ctx: Ctx) => Hono)[] = [
  (ctx) => personRoutes(ctx),
  (ctx) => peopleRoutes(ctx),
  (ctx) => channelsRoutes(ctx),
  (ctx) => keysRoutes(ctx),
];
