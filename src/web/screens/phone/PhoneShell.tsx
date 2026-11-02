import type { AppState, Channel, Project } from '../../../shared/types.js';
import { River } from '../../river/River.js';
import { isStill, stillChannels } from '../../river/state.js';
import { pendingSendIds, riverPeople } from '../home/dock.js';
import type { FaceReaction } from '../home/incidentVariants.js';
import { PhoneHome } from './PhoneHome.js';
import { PhoneTabs } from './PhoneTabs.js';

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
  now?: () => Date;
}

/** Home on a narrow screen: the bottom bar (River, Ask, You) with the phone river, its deck and its notices as the first tab. */
export function PhoneShell({ state, project, refresh, onReconnect, onOpenPerson, onNewProject, onOpenSettings, onLeave, reactions, now }: PhoneShellProps) {
  const sending = pendingSendIds(state);
  const people = riverPeople(state, project?.id ?? null, sending);
  const still = project ? isStill(state, project) : false;
  const river = (
    <River
      people={people}
      running={!still}
      still={still ? ['email', 'linkedin', 'x'] : stillChannels(state)}
      compact
      height={150}
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
      {...(now ? { now } : {})}
      river={
        <PhoneHome
          state={state}
          project={project}
          refresh={refresh}
          river={river}
          onOpenAccount={onOpenSettings}
          onReconnect={onReconnect}
          {...(onOpenPerson ? { onOpenPerson } : {})}
          {...(onNewProject ? { onNewProject } : {})}
          {...(now ? { now } : {})}
        />
      }
    />
  );
}
