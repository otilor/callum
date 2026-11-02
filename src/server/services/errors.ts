import { placeholderMessage } from '../engine/guard.js';
import { PlaceholderError, UndoError } from '../outbox/outbox.js';

/** Anything the UI should show as it is written: plain words, no stack. */
export class UserError extends Error {
  constructor(message: string, public status = 422, public detail?: unknown) {
    super(message);
    this.name = 'UserError';
  }
}

/** The outbox's own errors, in the words the user should read. Anything else comes back unchanged. */
export function asUserError(e: unknown): unknown {
  if (e instanceof PlaceholderError) return new UserError(placeholderMessage(e.placeholders[0] ?? ''), 422, { placeholders: e.placeholders });
  if (e instanceof UndoError) return new UserError(e.message);
  return e;
}

/** Runs `fn`; a placeholder or undo error leaves as a UserError. */
export function userFacing<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw asUserError(e);
  }
}
