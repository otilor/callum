import type {
  AppState, AskAction, AskAnswer, Channel, ChannelAccount, Correction, Incident, Message, OutboxItem, PathStep, Person, PersonFull, Project, Settings, Skipped, Tone,
} from '../shared/types.js';


export type { Skipped };

/** A failed call. `message` is the server's own `error` text, already in plain words. */
export class ApiError extends Error {
  readonly status: number;
  /** Seconds to wait, from a 429 lockout. */
  readonly retryAfter?: number;
  readonly detail?: unknown;
  constructor(status: number, message: string, extra: { retryAfter?: number; detail?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
    if (extra.detail !== undefined) this.detail = extra.detail;
  }
}

const UNREACHABLE = "Callum can't be reached. Check that it is still running.";
const BROKEN = 'Something went wrong. Callum kept everything as it was.';

const unreachableListeners = new Set<() => void>();
/**
 * Called whenever a request got no answer at all (status 0), so the page can look again at whether Callum is there. The state
 * request itself does not call it: it is the one that finds out.
 */
export function onUnreachable(listener: () => void): () => void {
  unreachableListeners.add(listener);
  return () => unreachableListeners.delete(listener);
}

type Query = Record<string, string | number | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${withQuery(path, query)}`, {
      method,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    if (path !== '/state') for (const listener of [...unreachableListeners]) listener();
    throw new ApiError(0, UNREACHABLE);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as { error?: unknown; retryAfter?: unknown; detail?: unknown };
    const message = typeof obj.error === 'string' && obj.error ? obj.error : BROKEN;
    throw new ApiError(res.status, message, {
      ...(typeof obj.retryAfter === 'number' ? { retryAfter: obj.retryAfter } : {}),
      ...(obj.detail !== undefined ? { detail: obj.detail } : {}),
    });
  }
  return data as T;
}

const get = <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
const del = <T>(path: string) => request<T>('DELETE', path);

// ---- shapes the routes answer with ---------------------------------------------------------------------

export interface PlanPreview { firstSendAt: string; total: number; byChannel: Record<Channel, number>; line: string }
export interface ImportResult { added: Person[]; skipped: Skipped[] }
/** `creditsUsed` is Apollo's own count when the server has it. */
export interface SearchResult { total: number; added: Person[]; skipped: Skipped[]; creditsUsed?: number }
export interface ImportBody { csv?: string; paste?: string; linkedinSearchUrl?: string; projectId?: number }
export interface PersonDetail { person: Person; messages: Message[]; path: PathStep[] }
export interface DeviceCodeStart { userCode: string; verificationUri: string; expiresAt: string }
export type DevicePoll =
  | { status: 'waiting' | 'expired' | 'denied' }
  | { status: 'connected'; account?: ChannelAccount };
export interface ChannelSummary {
  pending: { invites: number; followUps: number; emails: number; messages: number };
  paceLine: string;
}
export type SettingsPatch = Partial<Pick<Settings, 'senderName' | 'timezone' | 'notifications'> & { morningBrief: boolean }>;
export type ProjectPatch = Partial<Pick<Project, 'name' | 'offer' | 'audience' | 'tone' | 'sample' | 'calendarUrl'>>;

/** One typed function per route of the Callum HTTP API. Answers are the server's own JSON. */
export const api = {
  state: () => get<AppState>('/state'),
  login: (password: string) => post<{ ok: true }>('/login', { password }),
  logout: () => post<{ ok: true }>('/logout'),

  connect: (ch: Channel, fields: Record<string, string>) => post<ChannelAccount>(`/channels/${ch}/connect`, fields),
  disconnect: (ch: Channel) => post<ChannelAccount>(`/channels/${ch}/disconnect`),
  /** `checked` is the person's word that they finished the check LinkedIn asked for. */
  resumeChannel: (ch: Channel, pace: 'half' | 'full', checked?: boolean) => post<ChannelAccount>(`/channels/${ch}/resume`, checked ? { pace, checked: true } : { pace }),
  channelSummary: (ch: Channel) => get<ChannelSummary>(`/channels/${ch}/summary`),
  microsoftStart: (address: string) => post<DeviceCodeStart>('/channels/email/microsoft/start', { address }),
  microsoftPoll: (address?: string) => post<DevicePoll>('/channels/email/microsoft/poll', address ? { address } : {}),

  settings: (patch: SettingsPatch) => post<Settings>('/settings', patch),
  suggestOffer: () => get<{ offer: string | null }>('/offer/suggest'),
  sample: (tone: Tone, projectId?: number) => get<HelloSample>('/sample', { tone, projectId }),
  plan: (projectId?: number) => get<PlanPreview>('/plan', { projectId }),

  createProject: (body: { offer: string; name?: string; audience?: string; tone?: Tone }) => post<Project>('/projects', body),
  updateProject: (id: number, patch: ProjectPatch) => post<Project>(`/projects/${id}`, patch),
  pauseProject: (id: number, until: string | null) => post<Project>(`/projects/${id}/pause`, { until }),
  resumeProject: (id: number) => post<Project>(`/projects/${id}/resume`),
  wrapProject: (id: number) => post<{ cancelledFollowUps: number; cancelledHellos: number; summary: string }>(`/projects/${id}/wrap`),
  setCurrentProject: (id: number) => post<Settings>('/projects/current', { id }),
  /** Moves a person to another channel; `handle` is the address on it when Callum does not know it yet. */
  switchChannel: (personId: number, channel: Channel, handle?: string) => post<Person>(`/people/${personId}/switch-channel`, handle === undefined ? { channel } : { channel, handle }),
  moveToProject: (personId: number, projectId: number) => post<Person>(`/people/${personId}/move`, { projectId }),

  importLeads: (body: ImportBody) => post<ImportResult>('/leads/import', body),
  search: (query: string, count?: number, projectId?: number) => post<SearchResult>('/leads/search', { query, count, projectId }),

  start: (projectId?: number) => post<{ firstSendAt: string }>('/start', projectId === undefined ? {} : { projectId }),
  approve: (id: number, body?: string) => post<OutboxItem>(`/outbox/${id}/approve`, body === undefined ? {} : { body }),
  skip: (id: number) => post<OutboxItem>(`/outbox/${id}/skip`),
  undo: (id: number) => post<OutboxItem>(`/outbox/${id}/undo`),
  /** `again` says yes to sending a message that may have gone out already. */
  retry: (id: number, again?: boolean) => post<OutboxItem>(`/outbox/${id}/retry`, again ? { again: true } : {}),
  /** The words of a message Callum would not send, fixed. */
  editBlocked: (id: number, body: string, subject?: string | null) => post<OutboxItem>(`/outbox/${id}/edit`, subject === undefined ? { body } : { body, subject }),
  /** `Okay` on a notice. */
  dismissIncident: (id: number) => post<Incident>(`/incidents/${id}/dismiss`),

  person: (id: number) => get<PersonDetail>(`/people/${id}`),
  draft: (id: number, kind: 'reply' | 'booking' | 'close') => get<{ body: string }>(`/people/${id}/draft`, { kind }),
  reply: (id: number, body: string) => post<OutboxItem>(`/people/${id}/reply`, { body }),
  book: (id: number, body?: string) => post<OutboxItem>(`/people/${id}/book`, body === undefined ? {} : { body }),
  close: (id: number, body?: string) => post<OutboxItem>(`/people/${id}/close`, body === undefined ? {} : { body }),
  snooze: (id: number, until?: string) => post<Person>(`/people/${id}/snooze`, until === undefined ? {} : { until }),
  correct: (id: number, kind: Correction) => post<Person>(`/people/${id}/correct`, { kind }),
  nudge: (id: number) => post<Person>(`/people/${id}/nudge`),
  hold: (id: number) => post<Person>(`/people/${id}/hold`),
  resume: (id: number) => post<Person>(`/people/${id}/resume`),
  remove: (id: number) => post<Person>(`/people/${id}/remove`),

  ask: (text: string, projectId?: number) => post<AskAnswer>('/ask', projectId === undefined ? { text } : { text, projectId }),
  act: (action: AskAction, projectId?: number) => post<AskAnswer>('/ask/act', projectId === undefined ? { action } : { action, projectId }),

  pause: (until: string | null) => post<Settings>('/pause', { until }),
  resumeAll: () => post<Settings>('/resume'),
  wrap: (deleteData: boolean) => post<{ cancelledFollowUps: number; cancelledHellos: number; summary: string }>('/wrap', { deleteData }),
  wrapSummary: () => get<{ line: string }>('/wrap/summary'),
  startAgain: () => post<Settings>('/start-again'),

  seed: (scene: 'fresh' | 'morning') => post<unknown>('/demo/seed', { scene }),

  /** Download links; the browser follows them, so they are plain URLs. */
  exportJsonUrl: (projectId?: number) => `/api${withQuery('/export.json', { projectId })}`,
  exportCsvUrl: (projectId?: number) => `/api${withQuery('/export.csv', { projectId })}`,
  // Task 17
  /** The same route as `person`, with what the person page needs: next step, why this channel, what can be done. */
  personFull: (id: number) => get<PersonFull>(`/people/${id}`),
  wake: (id: number) => post<{ person: Person; undoUntil: string; next: string | null }>(`/people/${id}/wake`),
  rest: (id: number) => post<Person>(`/people/${id}/rest`),
};

// Task 16
export interface MicrosoftSetup { configured: boolean; source: 'env' | 'settings' | null }
/** The one-time Microsoft app registration that device-code sign-in needs. */
export const channelSetup = {
  microsoft: () => get<MicrosoftSetup>('/channels/email/microsoft/setup'),
  saveMicrosoftClientId: (clientId: string) => post<MicrosoftSetup>('/channels/email/microsoft/setup', { clientId }),
};

// Task 18: adding people, describing them, and the voice of a project that does not exist yet
import type { AddCommit, AddPreview, Described } from '../shared/types.js';

export interface HelloSample { body: string; to: { name: string; company: string | null } }
export interface PreviewBody { csv?: string; csvBase64?: string; paste?: string; linkedinSearchUrl?: string; projectId?: number | null }

export const peopleApi = {
  preview: (body: PreviewBody) => post<AddPreview>('/people/preview', body),
  commit: (body: { batchId: string; projectId?: number; drop?: string[] }) => post<AddCommit>('/people/commit', body),
  undo: (batchId: string) => post<{ removed: number }>('/people/undo', { batchId }),
  describe: (body: { query: string; filters?: string[]; projectId?: number | null }) => post<Described>('/people/describe', body),
  connectApollo: (key: string) => post<{ connected: true }>('/apollo/connect', { key }),
  sample: (body: { offer: string; tone: Tone; batchId?: string; key?: string }) => post<HelloSample>('/people/sample', body),
  discardProject: (projectId: number) => post<{ discarded: boolean }>('/people/discard-project', { projectId }),
};

// Task 19
/** The weekly note and the quiet moments of Home. */
export const noteApi = {
  weekly: () => get<import('../shared/types.js').WeeklyAnswer>('/weekly'),
  weeklySeen: () => post<{ seenAt: string }>('/weekly/seen'),
  quiet: (projectId?: number) => get<import('../shared/types.js').QuietSnapshot>('/quiet', { projectId }),
  /** The person's auto-reply was a real reply: they move to the dock. */
  realReply: (id: number) => post<Person>(`/people/${id}/real-reply`),
  /** Okay on an out-of-office card: it does not come back for that auto-reply. */
  awaySeen: (id: number) => post<{ ok: true }>(`/people/${id}/away-seen`),
  /** The user's hello to a person someone pointed to. */
  referralHello: (id: number, body: string, subject?: string | null) =>
    post<OutboxItem>(`/people/${id}/referral-hello`, subject ? { body, subject } : { body }),
};

// Integration
/** The key Callum writes hellos with. The server keeps it and never sends it back. */
export const claudeKeyApi = {
  save: (key: string) => post<{ claudeConnected: boolean }>('/settings/claude-key', { key }),
  remove: () => del<{ claudeConnected: boolean }>('/settings/claude-key'),
};
