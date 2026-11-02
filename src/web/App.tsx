import { FirstRun } from './screens/firstrun/FirstRun.js';
import { SignInCard } from './screens/signin/SignInCard.js';
import type { AppState, Project } from '../shared/types.js';
import { ToastProvider } from './ui/Toast.js';
import { Wordmark } from './ui/Wordmark.js';
import { useAppState } from './useAppState.js';
import './App.css';

/** Which screen the state calls for. Day one, Home and Leave done are filled in by later tasks. */
export type ScreenName = 'first-run' | 'wrapped' | 'day-one' | 'home';

export function screenFor(state: AppState, current: Project | null): ScreenName {
  if (!state.settings.onboarded) return 'first-run';
  if (state.settings.pauseState === 'wrapped') return 'wrapped';
  if ((current?.approvalsLeft ?? 0) > 0 && state.outbox.some((o) => o.state === 'awaiting_ok')) return 'day-one';
  return 'home';
}

function Placeholder({ screen, state, project }: { screen: Exclude<ScreenName, 'first-run'>; state: AppState; project: Project | null }) {
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

  let body;
  if (locked) {
    body = <SignInCard onDone={refresh} />;
  } else if (!state) {
    body = (
      <main className="shell shell-wait" data-screen="loading">
        <Wordmark />
        <p className="shell-line" role="status">{loading ? 'Callum is starting' : "Callum can't be reached. Check that it is still running."}</p>
      </main>
    );
  } else {
    const screen = screenFor(state, currentProject);
    body = screen === 'first-run' ? <FirstRun state={state} refresh={refresh} /> : <Placeholder screen={screen} state={state} project={currentProject} />;
  }

  return (
    <ToastProvider>
      {offline && state ? <p className="offline" role="status">Callum can't be reached. Trying again.</p> : null}
      {body}
    </ToastProvider>
  );
}
