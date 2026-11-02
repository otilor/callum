import type { Hono } from 'hono';
import type { Ctx } from '../context.js';

/**
 * Route modules of the other parts of Callum. Add one entry per module, e.g. `channelsRoutes` from
 * `./routes/channels.js`. Each builds its routes for a ctx; paths are relative to /api.
 */
export const FEATURE_ROUTES: ((ctx: Ctx) => Hono)[] = [];
