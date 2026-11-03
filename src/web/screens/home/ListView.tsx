import { Fragment, useMemo, useState } from 'react';
import type { Person, Project, Stage } from '../../../shared/types.js';
import { STAGE_LABEL } from '../../river/layout.js';
import { marbleBackground } from '../../ui/Marble.js';
import { formatWhen } from '../../ui/when.js';
import { channelName } from './people.js';
import { FacePopover } from './FacePopover.js';
import './ListView.css';

type GroupKey = 'talk' | Stage | 'resting';

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'talk', label: 'Want to talk' },
  { key: 'talking', label: STAGE_LABEL.talking },
  { key: 'following', label: STAGE_LABEL.following },
  { key: 'hello', label: STAGE_LABEL.hello },
  { key: 'stranger', label: STAGE_LABEL.stranger },
  { key: 'resting', label: 'Resting' },
];

const RING: Record<Stage, string> = { stranger: '#D5D9E4', hello: '#A9B8F5', following: '#6E86F2', talking: '#3F52D9' };

export interface ListViewProps {
  people: Person[];
  projects: Project[];
  /** The list starts on this project when there is more than one. */
  currentProjectId: number | null;
  tz: string;
  now: () => Date;
  notify: (text: string) => void;
  refresh: () => Promise<void>;
  /** A row of someone who waits on you opens the reply deck at their card. */
  onOpenDeck: (personId: number) => void;
  /** `See everything` in a row's popover. */
  onOpenPerson?: (id: number) => void;
}

function nextStep(p: Person, tz: string, now: Date): string {
  const zone = p.timezone ?? tz;
  if (p.status === 'waiting') return p.repliedAt ? `Replied ${formatWhen(p.repliedAt, tz, now)}` : 'Replied';
  if (p.status === 'snoozed') return p.snoozedUntil ? `Back ${formatWhen(p.snoozedUntil, tz, now)}` : 'Snoozed';
  if (p.status === 'resting') return p.restUntil ? `Rests until ${formatWhen(p.restUntil, tz, now)}` : 'Resting';
  if (p.status === 'held') return 'On hold';
  if (p.stage === 'talking') return 'You are talking';
  if (p.linkedinState === 'invited' && p.channel === 'linkedin') return 'Waiting to accept';
  if (p.nextTouchAt) return formatWhen(p.nextTouchAt, zone, now);
  return 'Nothing queued';
}

function groupOf(p: Person): GroupKey | null {
  if (p.status === 'waiting') return 'talk';
  if (p.status === 'resting' || p.status === 'snoozed') return 'resting';
  if (p.status === 'active' || p.status === 'held') return p.stage;
  return null;
}

/**
 * The same people as the river, as an accessible table: grouped by how close they are to you, one row each.
 * A row opens flat underneath itself; someone who waits on you opens the reply deck instead.
 */
export function ListView({ people, projects, currentProjectId, tz, now, notify, refresh, onOpenDeck, onOpenPerson }: ListViewProps) {
  const running = projects.filter((p) => p.state !== 'wrapped');
  const many = running.length > 1;
  const [filter, setFilter] = useState<number | 'all'>(currentProjectId ?? 'all');
  const [open, setOpen] = useState<number | null>(null);
  const clock = now();

  // The filter only means something with more than one project. With one, the list is that project's people; a project
  // that was wrapped up or went away falls back to all that are still running.
  const active: number | 'all' = !many ? (running[0]?.id ?? currentProjectId ?? 'all') : filter !== 'all' && running.some((p) => p.id === filter) ? filter : 'all';
  const shown = useMemo(
    () => people.filter((p) => (active === 'all' ? running.some((r) => r.id === p.projectId) : p.projectId === active)),
    // `running` is rebuilt every render from `projects`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, active, projects],
  );
  const byGroup = new Map<GroupKey, Person[]>();
  for (const p of shown) {
    const g = groupOf(p);
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), p]);
  }
  const projectName = (p: Person) => projects.find((x) => x.id === p.projectId)?.name ?? '';
  const columns = many ? 6 : 5;
  const total = shown.filter((p) => groupOf(p) !== null).length;

  return (
    <section className="lv" aria-label="Everyone, as a list">
      {many ? (
        <div className="lv-filter" role="group" aria-label="Show people from">
          {[{ id: 'all' as const, name: 'All projects' }, ...running.map((p) => ({ id: p.id, name: p.name }))].map((o) => (
            <button key={o.id} type="button" className={`lv-chip${active === o.id ? ' is-on' : ''}`} aria-pressed={active === o.id} onClick={() => setFilter(o.id)}>
              {o.name}
            </button>
          ))}
        </div>
      ) : null}

      {total === 0 ? (
        <p className="lv-empty">Nobody here yet. Tell Callum who you want to meet.</p>
      ) : (
        <table className="lv-table">
          <caption className="sr-only">{`${total} ${total === 1 ? 'person' : 'people'}, grouped by how close they are to you`}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Company</th>
              <th scope="col">Channel</th>
              <th scope="col">Where they are</th>
              <th scope="col">What happens next</th>
              {many ? <th scope="col">Project</th> : null}
            </tr>
          </thead>
          {GROUPS.map(({ key, label }) => {
            const rows = byGroup.get(key) ?? [];
            if (rows.length === 0) return null;
            return (
              <tbody key={key} className={key === 'talk' ? 'lv-group is-sun' : 'lv-group'}>
                <tr>
                  <th scope="rowgroup" colSpan={columns} className="lv-head">
                    {label}
                    <span className="lv-count">{rows.length}</span>
                  </th>
                </tr>
                {rows.map((p) => {
                  const isOpen = open === p.id;
                  const waits = key === 'talk';
                  return (
                    <Fragment key={p.id}>
                      <tr className={`lv-row${isOpen ? ' is-open' : ''}${waits ? ' is-waiting' : ''}`}>
                        <th scope="row" className="lv-name">
                          <button
                            type="button"
                            className="lv-open"
                            aria-expanded={waits ? undefined : isOpen}
                            aria-label={waits ? `${p.name}, replied and waiting on you` : undefined}
                            onClick={() => (waits ? onOpenDeck(p.id) : setOpen(isOpen ? null : p.id))}
                          >
                            <span className="lv-face" aria-hidden="true" style={{ background: marbleBackground(300 + p.id), boxShadow: `0 0 0 ${waits ? 2.5 : 1.5}px ${waits ? 'var(--sun)' : RING[p.stage]}` }} />
                            <span className="lv-who">
                              <span className="lv-who-name">{p.name}</span>
                              {p.role ? <span className="lv-who-role">{p.role}</span> : null}
                            </span>
                          </button>
                        </th>
                        <td className="lv-company">{p.company ?? ''}</td>
                        <td className="lv-channel">{p.channel ? channelName(p.channel) : ''}</td>
                        <td className="lv-stage">{STAGE_LABEL[p.stage]}</td>
                        <td className="lv-next">{nextStep(p, tz, clock)}</td>
                        {many ? <td className="lv-project"><span className="home-tag">{projectName(p)}</span></td> : null}
                      </tr>
                      {isOpen ? (
                        <tr className="lv-detail">
                          <td colSpan={columns}>
                            <FacePopover person={p} tz={tz} now={now} notify={notify} refresh={refresh} inline onOpenPerson={onOpenPerson} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      )}
    </section>
  );
}
