import { useEffect, useState } from 'react';
import { api } from './api.js';
import { DayOne } from './screens/dayone/DayOne.js';
import { FirstRun } from './screens/firstrun/FirstRun.js';
import { SignInCard } from './screens/signin/SignInCard.js';
import type { AppState, Project } from '../shared/types.js';
import type { AccountSlots } from './ui/AccountMenu.js';
import { ToastProvider } from './ui/Toast.js';
import { Wordmark } from './ui/Wordmark.js';
import { useAppState } from './useAppState.js';
import './App.css';

/** Which screen the state calls for. Home and Leave done are filled in by later tasks. */
export type ScreenName = 'first-run' | 'wrapped' | 'day-one' | 'home';

/** Hellos waiting for an OK in the project being viewed. Each project OKs its own first 10. */
export function awaitingHellos(state: AppState, project: Project | null) {
  if (!project) return [];
  const mine = new Set(state.people.filter((p) => p.projectId === project.id).map((p) => p.id));
  return state.outbox.filter((o) => o.state === 'awaiting_ok' && mine.has(o.personId));
}

export function screenFor(state: AppState, current: Project | null): ScreenName {
  if (!state.settings.onboarded) return 'first-run';
  if (state.settings.pauseState === 'wrapped') return 'wrapped';
  if ((current?.approvalsLeft ?? 0) > 0 && awaitingHellos(state, current).length > 0) return 'day-one';
  return 'home';
}

function Placeholder({ screen, state, project }: { screen: Exclude<ScreenName, 'first-run' | 'day-one'>; state: AppState; project: Project | null }) {
  return (
    <main className="shell" data-screen={screen}>
      <header className="shell-bar">
        <Wordmark project={project?.name ?? null} />
      </header>
      <p className="shell-line">{state.brief.line}</p>
    </main>
  );
}

const SIGNED_IN = 'callum.signed-in';

/** The server does not say whether it has a password, so this browser remembers that it signed in. */
function signedInBefore(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN) === '1';
  } catch {
    return false;
  }
}

function rememberSignedIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(SIGNED_IN, '1');
    else localStorage.removeItem(SIGNED_IN);
  } catch {
    // Private windows can refuse storage; the menu then simply has no Sign out.
  }
}

export function App() {
  const { state, loading, locked, offline, currentProject, refresh } = useAppState();
  const [signedIn, setSignedIn] = useState(signedInBefore);
  // Day one stays up through its last card, so the person sees "That's all 10" before the river.
  const [dayOneFor, setDayOneFor] = useState<number | null>(null);

  const screen = state ? screenFor(state, currentProject) : null;
  useEffect(() => {
    if (screen === 'day-one' && currentProject) setDayOneFor(currentProject.id);
  }, [screen, currentProject]);

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // Signing out of a Callum with no password has nothing to undo.
    }
    rememberSignedIn(false);
    setSignedIn(false);
    await refresh();
  };
  const account: AccountSlots = signedIn ? { onSignOut: () => void signOut() } : {};

  let body;
  if (locked) {
    body = (
      <SignInCard
        onDone={async () => {
          rememberSignedIn(true);
          setSignedIn(true);
          await refresh();
        }}
      />
    );
  } else if (!state || !screen) {
    body = (
      <main className="shell shell-wait" data-screen="loading">
        <Wordmark />
        <p className="shell-line" role="status">{loading ? 'Callum is starting' : "Callum can't be reached. Check that it is still running."}</p>
      </main>
    );
  } else if (screen === 'first-run') {
    body = <FirstRun state={state} refresh={refresh} />;
  } else if (currentProject && (screen === 'day-one' || (screen === 'home' && dayOneFor === currentProject.id))) {
    body = <DayOne key={currentProject.id} state={state} project={currentProject} refresh={refresh} account={account} onLeave={() => setDayOneFor(null)} />;
  } else {
    body = <Placeholder screen={screen === 'day-one' ? 'home' : screen} state={state} project={currentProject} />;
  }

  return (
    <ToastProvider>
      {offline && state ? <p className="offline" role="status">Callum can't be reached. Trying again.</p> : null}
      {body}
    </ToastProvider>
  );
}
