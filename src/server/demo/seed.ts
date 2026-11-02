import type { Ctx } from '../context.js';
import { UserError } from '../services/errors.js';

/** Fills a demo Callum with a scene. Task 20 replaces this with the real scenes. */
export async function seedScene(_ctx: Ctx, _scene: 'morning'): Promise<unknown> {
  throw new UserError('Not available', 404);
}
