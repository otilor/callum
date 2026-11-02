import type { Settings } from '../../shared/types.js';
import type { NoteSettings } from '../../shared/types.js';
import type { Ctx } from '../context.js';

/** The settings keys the weekly note and the quiet moments keep. They live in the same stored settings as the rest. */
export function readNoteSettings(ctx: Ctx): Settings & NoteSettings {
  return ctx.repo.getSettings() as Settings & NoteSettings;
}

export function writeNoteSettings(ctx: Ctx, patch: NoteSettings): void {
  // `updateSettings` stores whatever keys it is given; the keys are only missing from the Settings type, which other tasks own.
  ctx.repo.updateSettings(patch as unknown as Partial<Settings>);
}
