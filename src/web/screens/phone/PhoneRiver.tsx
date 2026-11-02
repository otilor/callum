import { useMemo, useState } from 'react';
import type { AppState, Person, Project, Stage } from '../../../shared/types.js';
import { Marble, lookForStage } from '../../ui/Marble.js';
import { PhonePersonSheet } from './PhonePersonSheet.js';
import { groupByStage, pauseLine, rowSub, rowWhen, wantToTalk } from './phoneCopy.js';
import type { Notify } from './PhoneNotice.js';

export interface PhoneRiverProps {
  state: AppState;
  /** The project on screen. The strip and the stage groups show this one. */
  project: Project | null;
  tz: string;
  now: Date;
  notify: Notify;
  refresh(): Promise<void> | void;
}

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

interface Zone { stage: Stage | 'want'; x0: number; x1: number; size: number; label: string; opacity: number }
const ZONES: Zone[] = [
  { stage: 'stranger', x0: 4, x1: 24, size: 14, label: 'strangers', opacity: 0.62 },
  { stage: 'hello', x0: 27, x1: 50, size: 17, label: 'said hello', opacity: 0.9 },
  { stage: 'following', x0: 53, x1: 65, size: 21, label: 'following up', opacity: 1 },
  { stage: 'talking', x0: 67, x1: 79, size: 24, label: 'talking', opacity: 1 },
  { stage: 'want', x0: 83, x1: 96, size: 28, label: 'want to talk', opacity: 1 },
];
const PER_ZONE = 12;

export interface StripFace { id: number; x: number; y: number; size: number; stage: Stage; want: boolean; label: string }

/** Where each face sits in the strip: strangers on the left, people who want to talk at the right. */
export function stripFaces(people: Person[]): StripFace[] {
  const faces: StripFace[] = [];
  for (const zone of ZONES) {
    const inZone = people
      .filter((p) =>
        zone.stage === 'want'
          ? p.status === 'waiting'
          : p.status !== 'waiting' && (p.status === 'active' || p.status === 'held') && p.stage === zone.stage,
      )
      .slice(0, PER_ZONE);
    const cols = Math.max(1, Math.ceil(inZone.length / 2));
    const width = (zone.x1 - zone.x0) / cols;
    inZone.forEach((p, k) => {
      const col = Math.floor(k / 2);
      const row = inZone.length === 1 ? 0.5 : k % 2;
      faces.push({
        id: p.id,
        x: zone.x0 + (col + 0.5) * width + (hash(p.id * 3.1 + 1) - 0.5) * width * 0.3,
        y: 34 + row * 30 + (col % 2) * 5 + (hash(p.id * 5.7) - 0.5) * 5,
        size: zone.size,
        stage: p.stage,
        want: zone.stage === 'want',
        label: `${p.name}, ${zone.label}`,
      });
    });
  }
  return faces;
}

function Row({ person, tag, tz, now, quiet, onOpen }: { person: Person; tag: string | null; tz: string; now: Date; quiet: boolean; onOpen(): void }) {
  const waiting = person.status === 'waiting';
  const look = lookForStage(person.stage);
  const when = rowWhen(person, tz, now);
  return (
    <button type="button" className="pa-row" onClick={onOpen}>
      <Marble
        seed={300 + person.id}
        size={40}
        tone={waiting ? 'warm' : look.tone}
        ring={waiting ? 'var(--sun)' : look.ring}
        style={waiting ? { boxShadow: '0 0 0 3px var(--sun)' } : quiet || person.status === 'held' ? { filter: 'grayscale(1)', opacity: 0.6 } : undefined}
      />
      <span className="pa-row-text">
        <span className="pa-row-name">
          {person.name}
          {tag ? <span className="pa-tag">{tag}</span> : null}
          {person.status === 'held' ? <span className="pa-tag">On hold</span> : null}
        </span>
        <span className="pa-row-sub">{rowSub(person, tz, now)}</span>
      </span>
      {when ? <span className="pa-row-when">{when}</span> : null}
    </button>
  );
}

function Head({ title, count, kind }: { title: string; count: number; kind: 'want' | Stage | 'rest' }) {
  return (
    <div className="pa-head">
      <span className="pa-head-title"><i className={`pa-dot pa-dot-${kind}`} aria-hidden="true" />{title}</span>
      <span className="pa-head-count">{count}</span>
    </div>
  );
}

function greeting(now: Date, tz: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

const FOLLOW_SHOWN = 3;

/** The River tab: the brief, the strip, and everyone by how far along they are. The people who want to talk come from every project, with the project named when there are several. */
export function PhoneRiver({ state, project, tz, now, notify, refresh }: PhoneRiverProps) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const projectId = project?.id ?? state.settings.currentProjectId;
  const several = state.projects.length > 1;
  const names = useMemo(() => new Map(state.projects.map((p) => [p.id, p.name])), [state.projects]);
  const tagFor = (p: Person) => (several ? names.get(p.projectId) ?? null : null);

  const mine = state.people.filter((p) => projectId === null || p.projectId === projectId);
  const want = wantToTalk(state.people);
  const groups = groupByStage(state.people, projectId ?? null);
  const paused = pauseLine(state, project, tz);
  const quiet = paused !== null;
  const faces = stripFaces(mine);

  const followShown = more ? groups.following : groups.following.slice(0, FOLLOW_SHOWN);
  const followHidden = groups.following.length - followShown.length;
  const open = openId === null ? null : state.people.find((p) => p.id === openId) ?? null;

  const pills: { key: string; text: string; kind: string }[] = [
    { key: 'want', kind: 'want', text: want.length > 0 ? `${want.length} want${want.length === 1 ? 's' : ''} to talk` : 'All caught up' },
  ];
  if (state.brief.sentYesterday > 0) {
    pills.push({ key: 'sent', kind: 'hello', text: `${state.brief.sentYesterday} ${state.brief.sentYesterday === 1 ? 'hello' : 'hellos'} sent yesterday` });
  }
  const accepted = state.brief.acceptedRecently[0];
  if (accepted) pills.push({ key: 'accepted', kind: 'following', text: `${accepted} accepted` });

  return (
    <div className="pa-tab pa-river">
      <section aria-labelledby="pa-brief" className="pa-brief">
        <h1 id="pa-brief">{greeting(now, tz)}</h1>
        <div className="pa-pills">
          {pills.map((pl) => (
            <span key={pl.key} className="pa-pill"><i className={`pa-dot pa-dot-${pl.kind}`} aria-hidden="true" />{pl.text}</span>
          ))}
        </div>
      </section>

      <section className={`pa-strip${quiet ? ' pa-strip-quiet' : ''}`} aria-label={`${project?.name ?? 'Your'} river`}>
        <svg className="pa-strip-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 50 C 20 38, 40 62, 60 50 S 90 44, 100 50" /></svg>
        {faces.map((f) => (
          <span
            key={f.id}
            role="img"
            aria-label={f.label}
            className="pa-face"
            style={{ left: `${f.x}%`, top: f.y, width: f.size, height: f.size }}
          >
            <Marble
              seed={300 + f.id}
              size={f.size}
              tone={f.want ? 'warm' : lookForStage(f.stage).tone}
              ring={f.want ? 'var(--sun)' : lookForStage(f.stage).ring}
              style={f.want ? { boxShadow: '0 0 0 2px var(--sun)' } : undefined}
            />
          </span>
        ))}
      </section>

      <div className="pa-list">
        {paused ? <p className="pa-pause fade-in">{paused}</p> : null}

        {want.length > 0 ? (
          <>
            <Head title="Want to talk" count={want.length} kind="want" />
            {want.map((p) => <Row key={p.id} person={p} tag={tagFor(p)} tz={tz} now={now} quiet={false} onOpen={() => setOpenId(p.id)} />)}
          </>
        ) : null}

        {groups.talking.length > 0 ? (
          <>
            <Head title="Talking" count={groups.talking.length} kind="talking" />
            {groups.talking.map((p) => <Row key={p.id} person={p} tag={null} tz={tz} now={now} quiet={false} onOpen={() => setOpenId(p.id)} />)}
          </>
        ) : null}

        {groups.following.length > 0 ? (
          <>
            <Head title="Following up" count={groups.following.length} kind="following" />
            {followShown.map((p) => <Row key={p.id} person={p} tag={null} tz={tz} now={now} quiet={quiet} onOpen={() => setOpenId(p.id)} />)}
            {groups.following.length > FOLLOW_SHOWN ? (
              <button type="button" className="pa-more" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? 'Show fewer' : `${followHidden} more`}
              </button>
            ) : null}
          </>
        ) : null}

        {groups.hello.length > 0 ? (
          <>
            <Head title="Said hello" count={groups.hello.length} kind="hello" />
            <p className="pa-note">{quiet ? 'Their follow-ups wait while Callum is paused.' : 'Their first follow-ups go out as the days pass.'}</p>
          </>
        ) : null}

        {groups.strangers.length > 0 ? (
          <>
            <Head title="Strangers" count={groups.strangers.length} kind="stranger" />
            <p className="pa-note">
              {quiet
                ? 'Their first hellos wait while Callum is paused.'
                : `${groups.strangers.length === 1 ? '1 person waits' : `${groups.strangers.length} people wait`} for a first hello.`}
            </p>
          </>
        ) : null}

        {groups.resting.length > 0 ? (
          <>
            <Head title="Resting" count={groups.resting.length} kind="rest" />
            {groups.resting.map((p) => <Row key={p.id} person={p} tag={null} tz={tz} now={now} quiet onOpen={() => setOpenId(p.id)} />)}
          </>
        ) : null}

        {mine.length === 0 && want.length === 0 ? <p className="pa-note">Nobody is in this river yet. Add people from your computer, or ask Callum to find some.</p> : null}
      </div>

      {open ? (
        <PhonePersonSheet
          key={open.id}
          person={open}
          tag={tagFor(open)}
          tz={tz}
          now={now}
          paused={quiet}
          notify={notify}
          refresh={refresh}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
