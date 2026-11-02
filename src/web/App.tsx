import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState, Channel, Project } from '../shared/types.js';
import { api } from './api.js';
import { DayOne } from './screens/dayone/DayOne.js';
import { FirstRun } from './screens/firstrun/FirstRun.js';
import { Home } from './screens/home/Home.js';
import { dockPeople } from './screens/home/dock.js';
import { IncidentCards } from './screens/home/IncidentCard.js';
import { faceReactions, incidentVariant } from './screens/home/incidentVariants.js';
import { ProjectSwitcher } from './screens/home/ProjectSwitcher.js';
import { Quiet } from './screens/home/Quiet.js';
import { useQuiet } from './screens/home/useQuiet.js';
import { VariantStack } from './screens/home/VariantCard.js';
import { Weekly } from './screens/home/Weekly.js';
import { AddPeople } from './screens/add/AddPeople.js';
import { ConnectSheet } from './screens/connect/ConnectSheet.js';
import { LeaveSheet } from './screens/leave/LeaveSheet.js';
import { Wrapped } from './screens/leave/Wrapped.js';
import { NewProject } from './screens/newproject/NewProject.js';
import { PersonView } from './screens/person/PersonView.js';
import { PhoneShell } from './screens/phone/PhoneShell.js';
import type { PhoneTab } from './screens/phone/phoneCopy.js';
import { YourCallum } from './screens/settings/YourCallum.js';
import { SignIn } from './screens/signin/SignIn.js';
import type { AccountSlots } from './ui/AccountMenu.js';
import { ToastProvider } from './ui/Toast.js';
import { Wordmark } from './ui/Wordmark.js';
import { useAppState } from './useAppState.js';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery.js';
import { useNotifications } from './useNotifications.js';
import './App.css';

/** Which screen the state calls for. */
export type ScreenName = 'first-run' | 'wrapped' | 'day-one' | 'home';

/** Hellos waiting for an OK in the project being viewed. Each project OKs its own first 10. */
export function awaitingHellos(state: AppState, project: Project | null) {
  if (!project) return [];
  const mine = new Set(state.people.filter((p) => p.projectId === project.id).map((p) => p.id));
  return state.outbox.filter((o) => o.state === 'awaiting_ok' && mine.has(o.personId));
}

/** Wrapped first (starting again sets onboarded to false and a wiped Callum would otherwise show First run), then First run, Day one, Home. */
export function screenFor(state: AppState, current: Project | null): ScreenName {
  if (state.settings.pauseState === 'wrapped') return 'wrapped';
  if (!state.settings.onboarded) return 'first-run';
  if ((current?.approvalsLeft ?? 0) > 0 && awaitingHellos(state, current).length > 0) return 'day-one';
  return 'home';
}

/**
 * With more than one project running and someone waiting in the dock, Day one is a banner on Home instead of the whole
 * screen, so a reply is never stuck behind the hellos. A single project keeps the full-screen Day one.
 */
export function dayOneAsBanner(state: AppState, current: Project | null): boolean {
  return screenFor(state, current) === 'day-one' && state.projects.filter((p) => p.state !== 'wrapped').length > 1 && dockPeople(state).length > 0;
}

/** What sits over Home or Day one: a page of its own that Back returns from. */
type View =
  | { kind: 'main' }
  | { kind: 'settings' }
  | { kind: 'leave' }
  | { kind: 'person'; id: number }
  | { kind: 'add'; projectId: number }
  | { kind: 'new-project' };

const MAIN: View = { kind: 'main' };

export function App() {
  const { state, loading, locked, offline, currentProject, refresh } = useAppState();
  // Day one stays up through its last card, so the person sees "That's all 10" before the river.
  const [dayOneFor, setDayOneFor] = useState<number | null>(null);
  // The phone's tab lives here, so Back from Your Callum (opened from You) lands on You.
  const [phoneTab, setPhoneTab] = useState<PhoneTab>('river');
  const [view, setView] = useState<View>(MAIN);
  const [connect, setConnect] = useState<{ channel: Channel; reconnect: boolean } | null>(null);
  const [weeklySignal, setWeeklySignal] = useState(0);
  const phone = useMediaQuery(PHONE_QUERY);
  useNotifications(state);

  const screen = state ? screenFor(state, currentProject) : null;
  const banner = state ? dayOneAsBanner(state, currentProject) : false;
  const currentId = currentProject?.id ?? null;
  useEffect(() => {
    setDayOneFor((held) => {
      if (screen === 'day-one' && currentId !== null && !banner) return currentId;
      // Day one belongs to the project it was opened for: switching away lets it go.
      return held !== null && held !== currentId ? null : held;
    });
  }, [screen, currentId, banner]);

  // Home and Day one are the screens the pages above open from; anything else (First run, Wrapped) shows itself.
  const onMain = screen === 'home' || screen === 'day-one';
  const quietOn = screen === 'home' && view.kind === 'main';
  const { quiet, reload: reloadQuiet } = useQuiet(state, currentId, quietOn);
  const reactions = useMemo(() => (state ? faceReactions(state, quiet, new Date()) : undefined), [state, quiet]);

  const back = () => setView(MAIN);
  const changed = async () => {
    reloadQuiet();
    await refresh();
  };

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // Signing out of a Callum with no password has nothing to undo.
    }
    setView(MAIN);
    await refresh();
  };
  const account: AccountSlots = {
    onYourCallum: () => setView({ kind: 'settings' }),
    onLeave: () => setView({ kind: 'leave' }),
    // The note is mounted on Home, so the entry is offered where it can open.
    ...(screen === 'home' ? { onWeekly: () => setWeeklySignal((n) => n + 1) } : {}),
    ...(state?.auth.password ? { onSignOut: () => void signOut() } : {}),
  };
  const reconnect = (channel: Channel) => setConnect({ channel, reconnect: true });
  const openPerson = (id: number) => setView({ kind: 'person', id });
  const addPeople = () => (currentProject ? setView({ kind: 'add', projectId: currentProject.id }) : undefined);
  const newProject = () => setView({ kind: 'new-project' });

  let body: ReactNode;
  if (locked) {
    body = <SignIn mode="locked" refresh={() => refresh({ strict: true })} />;
  } else if (!state || !screen) {
    body = loading ? (
      <SignIn mode="starting" refresh={() => refresh({ strict: true })} />
    ) : (
      <main className="shell shell-wait" data-screen="loading">
        <Wordmark />
        <p className="shell-line" role="status">Callum can't be reached. Check that it is still running.</p>
      </main>
    );
  } else if (screen === 'first-run') {
    body = <FirstRun state={state} refresh={refresh} />;
  } else if (screen === 'wrapped') {
    body = <Wrapped state={state} refresh={refresh} />;
  } else if (onMain && view.kind === 'settings') {
    body = (
      <YourCallum
        state={state}
        refresh={refresh}
        onBack={back}
        onLeave={() => setView({ kind: 'leave' })}
        onAddPeople={(projectId) => setView({ kind: 'add', projectId })}
      />
    );
  } else if (onMain && view.kind === 'leave') {
    body = <LeaveSheet state={state} refresh={refresh} onClose={back} />;
  } else if (onMain && view.kind === 'person') {
    body = <PersonView state={state} personId={view.id} onOpen={openPerson} onBack={back} />;
  } else if (onMain && view.kind === 'add' && state.projects.some((p) => p.id === view.projectId)) {
    const target = state.projects.find((p) => p.id === view.projectId) as Project;
    body = <AddPeople project={target} people={state.people.filter((p) => p.projectId === target.id)} timezone={state.settings.timezone} onClose={back} />;
  } else if (onMain && view.kind === 'new-project') {
    body = <NewProject state={state} refresh={refresh} onClose={back} onOpen={back} />;
  } else if (currentProject && (dayOneFor === currentProject.id ? screen === 'day-one' || screen === 'home' : screen === 'day-one' && !banner)) {
    const several = state.projects.filter((p) => p.state !== 'wrapped').length > 1;
    body = (
      <DayOne
        key={currentProject.id}
        state={state}
        project={currentProject}
        refresh={refresh}
        account={account}
        onLeave={() => setDayOneFor(null)}
        {...(banner ? { onBack: () => setDayOneFor(null) } : {})}
        {...(several ? { switcher: <ProjectSwitcher state={state} project={currentProject} refresh={refresh} onNewProject={newProject} /> } : {})}
      />
    );
  } else if (currentProject && phone) {
    body = (
      <PhoneShell
        state={state}
        project={currentProject}
        refresh={refresh}
        onReconnect={reconnect}
        onOpenPerson={openPerson}
        onNewProject={newProject}
        onOpenSettings={() => setView({ kind: 'settings' })}
        onLeave={() => setView({ kind: 'leave' })}
        tab={phoneTab}
        onTab={setPhoneTab}
        {...(reactions ? { reactions } : {})}
        {...(banner ? { dayOne: { left: Math.min(currentProject.approvalsLeft, awaitingHellos(state, currentProject).length), onOpen: () => setDayOneFor(currentProject.id) } } : {})}
      />
    );
  } else if (currentProject) {
    const now = new Date();
    body = (
      <Home
        state={state}
        project={currentProject}
        refresh={refresh}
        account={account}
        onAddPeople={addPeople}
        onNewProject={newProject}
        onOpenPerson={openPerson}
        {...(reactions ? { reactions } : {})}
        {...(banner ? { dayOne: { left: Math.min(currentProject.approvalsLeft, awaitingHellos(state, currentProject).length), onOpen: () => setDayOneFor(currentProject.id) } } : {})}
        incident={
          <>
            <VariantStack state={state} onReconnect={reconnect} onOpenPerson={openPerson} onChanged={() => void refresh()} collapse />
            {/* The LinkedIn check has its own steps, and a reply whose words are gone has no card in the stack above. */}
            <IncidentCards
              state={state}
              refresh={refresh}
              onReconnect={reconnect}
              onOpenPerson={openPerson}
              include={(incident) => incidentVariant(incident, state, now) === null}
            />
            <Weekly tz={state.settings.timezone} onChanged={() => void changed()} onOpenPerson={openPerson} openSignal={weeklySignal} />
          </>
        }
        quiet={({ ask }) => (
          <Quiet
            key={currentProject.id}
            quiet={quiet}
            project={currentProject}
            tz={state.settings.timezone}
            offline={offline}
            waiting={dockPeople(state).length}
            onTryNow={refresh}
            onChanged={() => void changed()}
            onAsk={ask}
            onBringList={addPeople}
          />
        )}
      />
    );
  } else {
    body = (
      <main className="shell" data-screen="home">
        <header className="shell-bar">
          <Wordmark />
        </header>
        <p className="shell-line">{state.brief.line}</p>
      </main>
    );
  }

  return (
    <ToastProvider>
      {offline && state ? <p className="offline" role="status">Callum can't be reached. Trying again.</p> : null}
      {body}
      {connect && state && !locked ? (
        <ConnectSheet
          channel={connect.channel}
          reconnect={connect.reconnect}
          accounts={Object.fromEntries(state.channels.map((c) => [c.channel, c]))}
          onConnected={() => refresh()}
          onClose={() => setConnect(null)}
        />
      ) : null}
    </ToastProvider>
  );
}
