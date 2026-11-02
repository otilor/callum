import type { AppState, Channel, Project } from '../../shared/types.js';

/** Channels that are not sending right now: their faces go grey in the river. */
export function stillChannels(state: AppState): Channel[] {
  return state.channels.filter((c) => c.status === 'paused' || c.status === 'error').map((c) => c.channel);
}

/** True while Callum is paused as a whole, or the project being viewed is paused. */
export function isStill(state: AppState, project: Project | null): boolean {
  return state.settings.pauseState !== 'running' || (project?.state ?? 'running') !== 'running';
}
