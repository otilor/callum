// Notifications from the main process: the morning brief, and replies when no window is alive to show them.
// (While the window exists, even hidden, the web app's own notifications cover replies.)
import type { TimeApi } from './server-api.js';

export interface NotifierDeps {
  bus: { on(fn: (scope: string) => void): () => void };
  time: Pick<TimeApi, 'localParts'>;
  /** People whose reply is waiting for an answer. */
  waitingPeople(): { id: number; firstName: string }[];
  settings(): { notifications: boolean | null; timezone: string };
  /** Today's brief, or null when it cannot be read right now. */
  brief(): Promise<{ line: string } | null>;
  show(note: { title: string; body: string }): void;
  /** True while the app's window can show notifications itself. */
  hasRenderer(): boolean;
  now(): Date;
  /** Remembers which day's brief was shown, so a restart does not show it twice. */
  briefStore: { get(): string | null; set(day: string): void };
}

export interface Notifier {
  /** Show the brief if it is time. Called every minute or so. */
  tick(): Promise<void>;
  stop(): void;
}

const BRIEF_FROM = 8 * 60 + 30;
const BRIEF_UNTIL = 10 * 60 + 30;

export function createNotifier(deps: NotifierDeps): Notifier {
  let seen = new Set(deps.waitingPeople().map((p) => p.id));

  const off = deps.bus.on((scope) => {
    if (scope !== 'people') return;
    const waiting = deps.waitingPeople();
    const fresh = waiting.filter((p) => !seen.has(p.id));
    seen = new Set(waiting.map((p) => p.id));
    if (deps.settings().notifications !== true || deps.hasRenderer()) return;
    for (const person of fresh) deps.show({ title: `${person.firstName} replied`, body: 'Open Callum to read it and answer.' });
  });

  async function tick(): Promise<void> {
    const { notifications, timezone } = deps.settings();
    if (notifications !== true) return;
    const local = deps.time.localParts(deps.now(), timezone);
    const minutes = local.hour * 60 + local.minute;
    if (local.weekday === 0 || local.weekday === 6 || minutes < BRIEF_FROM || minutes > BRIEF_UNTIL) return;
    const day = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
    if (deps.briefStore.get() === day) return;
    const brief = await deps.brief().catch(() => null);
    if (!brief?.line.trim()) return;
    deps.briefStore.set(day);
    deps.show({ title: 'Good morning', body: brief.line });
  }

  return { tick, stop: off };
}
