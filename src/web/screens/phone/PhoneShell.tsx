import type { AppState, Channel, Person, Project } from '../../../shared/types.js';
import { River } from '../../river/River.js';
import { isStill, stillChannels } from '../../river/state.js';
import { pendingSendIds, riverPeople } from '../home/people.js';
import type { FaceReaction } from '../home/incidentVariants.js';
import { PhoneHome } from './PhoneHome.js';
import { PhoneTabs } from './PhoneTabs.js';
import type { PhoneTab } from './phoneCopy.js';

export interface PhoneShellProps {
  state: AppState;
  project: Project | null;
  refresh(): Promise<void>;
  onReconnect(channel: Channel): void;
  onOpenPerson?(personId: number): void;
  onNewProject?(): void;
  /** `Your Callum`, from the avatar and from the You tab. */
  onOpenSettings(): void;
  onLeave(): void;
  reactions?: ReadonlyMap<number, FaceReaction>;
  /** The tab shown and what changes it, kept by the caller so Back from Your Callum lands where the person left. */
  tab?: PhoneTab;
  onTab?(tab: PhoneTab): void;
  /** Hellos still to OK while more than one project runs. */
  dayOne?: { left: number; onOpen(): void };
  now?: () => Date;
}

/** Home on a narrow screen: the bottom bar (River, Ask, You) with the phone river, its deck and its notices as the first tab. */
export function PhoneShell({ state, project, refresh, onReconnect, onOpenPerson, onNewProject, onOpenSettings, onLeave, reactions, dayOne, tab, onTab, now }: PhoneShellProps) {
  const sending = pendingSendIds(state);
  const people = riverPeople(state, project?.id ?? null, sending);
  const still = project ? isStill(state, project) : false;
  const river = ({ onFace }: { onFace(person: Person): void }) => (
    <River
      people={people}
      onFace={onFace}
      running={!still}
      still={still ? ['email', 'linkedin', 'x'] : stillChannels(state)}
      compact
      height={108}
      sendingIds={[...sending]}
      {...(reactions ? { reactions } : {})}
    />
  );
  return (
    <PhoneTabs
      state={state}
      project={project}
      refresh={refresh}
      onOpenSettings={onOpenSettings}
      onLeave={onLeave}
      {...(tab ? { tab } : {})}
      {...(onTab ? { onTab } : {})}
      {...(now ? { now } : {})}
      river={
        <PhoneHome
          state={state}
          project={project}
          refresh={refresh}
          river={river}
          onOpenAccount={onOpenSettings}
          onReconnect={onReconnect}
          {...(dayOne ? { dayOne } : {})}
          {...(onOpenPerson ? { onOpenPerson } : {})}
          {...(onNewProject ? { onNewProject } : {})}
          {...(now ? { now } : {})}
        />
      }
    />
  );
}
