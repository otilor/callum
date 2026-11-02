import { FirstRun } from './screens/firstrun/FirstRun.js';
import { Wrapped } from './screens/leave/Wrapped.js';
import { SignIn } from './screens/signin/SignIn.js';
import type { AppState, Project } from '../shared/types.js';
import { ToastProvider } from './ui/Toast.js';
import { Wordmark } from './ui/Wordmark.js';
import { useAppState } from './useAppState.js';
import { useNotifications } from './useNotifications.js';
import './App.css';

/** Which screen the state calls for. Day one, Home and Leave done are filled in by later tasks. */
export type ScreenName = 'first-run' | 'wrapped' | 'day-one' | 'home';

export function screenFor(state: AppState, current: Project | null): ScreenName {
  // Wrapped comes first: starting again sets onboarded to false, and a wiped Callum would otherwise show First run.
  if (state.settings.pauseState === 'wrapped') return 'wrapped';
  if (!state.settings.onboarded) return 'first-run';
  if ((current?.approvalsLeft ?? 0) > 0 && state.outbox.some((o) => o.state === 'awaiting_ok')) return 'day-one';
  return 'home';
}

function Placeholder({ screen, state, project }: { screen: Exclude<ScreenName, 'first-run' | 'wrapped'>; state: AppState; project: Project | null }) {
  return (
    <main className="shell" data-screen={screen}>
      <header className="shell-bar">
        <Wordmark project={project?.name ?? null} />
      </header>
      <p className="shell-line">{state.brief.line}</p>
    </main>
  );
}

export function App() {
  const { state, loading, locked, offline, currentProject, refresh } = useAppState();
  useNotifications(state);

  let body;
  if (locked) {
    body = <SignIn mode="locked" refresh={() => refresh({ strict: true })} />;
  } else if (!state) {
    body = loading ? (
      <SignIn mode="starting" refresh={() => refresh({ strict: true })} />
    ) : (
      <main className="shell shell-wait" data-screen="loading">
        <Wordmark />
        <p className="shell-line" role="status">Callum can't be reached. Check that it is still running.</p>
      </main>
    );
  } else {
    const screen = screenFor(state, currentProject);
    body = screen === 'first-run' ? <FirstRun state={state} refresh={refresh} /> : screen === 'wrapped' ? <Wrapped state={state} refresh={refresh} /> : <Placeholder screen={screen} state={state} project={currentProject} />;
  }

  return (
    <ToastProvider>
      {offline && state ? <p className="offline" role="status">Callum can't be reached. Trying again.</p> : null}
      {body}
    </ToastProvider>
  );
}
