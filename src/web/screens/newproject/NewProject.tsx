import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddCommit, AppState, Project, Tone } from '../../../shared/types.js';
import { api, peopleApi, type HelloSample } from '../../api.js';
import { formatSlot, joinNames, suggestProjectName } from '../../ui/format.js';
import { Marble } from '../../ui/Marble.js';
import { useToast } from '../../ui/Toast.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { River } from '../add/River.js';
import { messageOf, useWhoFinder } from '../add/useWhoFinder.js';
import { AlertLine, WhoPanel } from '../add/WhoPanel.js';
import { firstOf, seedOf } from '../add/words.js';
import './NewProject.css';

export const EXAMPLE_OFFER = 'You help growing teams in Lagos and Accra run payroll without spreadsheets.';
const TONES: { key: Tone; name: string }[] = [
  { key: 'warm', name: 'Warm' },
  { key: 'direct', name: 'Direct' },
  { key: 'playful', name: 'Playful' },
];
const CHANNEL_WORDS: Record<string, string> = { email: 'your mailbox', linkedin: 'LinkedIn', x: 'X' };

export interface NewProjectProps {
  state: AppState;
  refresh(): Promise<void>;
  /** The close button, and Escape: back to where the person came from. */
  onClose(): void;
  /** "See {name} at home": the project that was just started. */
  onOpen(project: Project): void;
  now?: () => Date;
}

type Step = 0 | 1 | 2;
type Phase = 'flow' | 'starting' | 'ready';

/** The ready line: `tomorrow from 9:00`, or `Monday from 9:00` over a weekend. */
function fromWords(firstSendAt: string, tz: string, now: Date): string {
  return formatSlot(firstSendAt, tz, now).replace(' at ', ' from ');
}

/** Starting a second (or third) project: what you offer, who to meet, how to sound, then Start. */
export function NewProject({ state, refresh, onClose, onOpen, now = () => new Date() }: NewProjectProps) {
  const toast = useToast();
  const finder = useWhoFinder(null, { initialWay: 'describe' });
  const [step, setStep] = useState<Step>(0);
  const [phase, setPhase] = useState<Phase>('flow');
  const [offer, setOffer] = useState('');
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [nameError, setNameError] = useState('');
  const [tone, setTone] = useState<Tone>('warm');
  const [drafts, setDrafts] = useState<Partial<Record<Tone, string>>>({});
  const [samples, setSamples] = useState<Record<string, HelloSample>>({});
  const [sampleError, setSampleError] = useState<{ key: string; message: string } | null>(null);
  const [error, setError] = useState('');
  // What Start has already done, so a second press carries on from where the first stopped.
  const [project, setProject] = useState<Project | null>(null);
  const [imported, setImported] = useState<AddCommit | null>(null);
  const [firstSendAt, setFirstSendAt] = useState('');
  const opened = useRef(false);

  const tz = state.settings.timezone;
  const others = state.projects;
  const connected = state.channels.filter((c) => c.status === 'connected').map((c) => CHANNEL_WORDS[c.channel] ?? c.channel);
  const hasOffer = offer.trim() !== '';
  const name = nameOverride ?? suggestProjectName(offer);
  const clash = useMemo(() => {
    const wanted = name.trim().toLowerCase();
    return wanted === '' ? null : (others.find((p) => p.name.toLowerCase() === wanted && p.id !== project?.id) ?? null);
  }, [name, others, project]);
  const clashText = clash ? `You already have a project called ${clash.name}. Nothing has started yet. Pick another name.` : '';
  const nameBlocked = !hasOffer || name === '' || clash !== null;

  const kept = finder.kept;
  const first = kept[0] ?? null;
  const sampleKey = `${tone}|${offer.trim()}|${finder.found?.batchId ?? ''}|${first?.key ?? ''}`;
  const sample = samples[sampleKey];
  const edited = drafts[tone] !== undefined;

  useEffect(() => {
    if (step !== 2 || !hasOffer || sample || edited) return;
    let current = true;
    setSampleError(null);
    peopleApi
      .sample({ offer: offer.trim(), tone, ...(finder.found && first ? { batchId: finder.found.batchId, key: first.key } : {}) })
      .then((res) => {
        if (current) setSamples((all) => ({ ...all, [sampleKey]: res }));
      })
      .catch((e: unknown) => {
        if (current) setSampleError({ key: sampleKey, message: messageOf(e) });
      });
    return () => {
      current = false;
    };
  }, [step, hasOffer, sample, edited, offer, tone, sampleKey, finder.found, first]);

  const message = drafts[tone] ?? sample?.body ?? '';
  const writing = !sample && !edited && sampleError?.key !== sampleKey;
  const target = sample ? [sample.to.name, sample.to.company ? `at ${sample.to.company}` : ''].filter(Boolean).join(' ') : first ? [first.source === 'apollo' ? firstOf(first) : first.name, first.company ? `at ${first.company}` : ''].filter(Boolean).join(' ') : 'Kemi Eze at Oko Pay';

  const saveName = () => {
    const v = draftName.trim();
    if (!v) return setNameError(`A project needs a name. Callum kept "${name}". Type a name to save.`);
    const taken = others.find((p) => p.name.toLowerCase() === v.toLowerCase() && p.id !== project?.id);
    if (taken) {
      setNameOverride(v);
      return setNameError(`You already have a project called ${taken.name}. Nothing has started yet. Pick another name.`);
    }
    setNameOverride(v);
    setNameError('');
    setEditing(false);
  };

  const go = (next: Step) => {
    setError('');
    setStep(next);
  };

  const start = async () => {
    if (phase !== 'flow') return;
    setError('');
    if (connected.length === 0) {
      setError('Connect a channel first. Callum needs your mailbox, LinkedIn or X to write from.');
      return;
    }
    const found = finder.found;
    if (!imported && (!found || kept.length === 0)) {
      setError('Choose who Callum should meet first.');
      return;
    }
    setPhase('starting');
    try {
      let made = project;
      const text = offer.trim();
      const audience = finder.way === 'describe' && finder.descText.trim() ? finder.descText.trim() : undefined;
      if (!made) {
        made = await api.createProject({ offer: text, name, tone, ...(audience ? { audience } : {}) });
      } else {
        const patch: { offer?: string; name?: string; tone?: Tone } = {};
        if (text !== (made.offer ?? '')) patch.offer = text;
        if (name !== made.name) patch.name = name;
        if (tone !== made.tone) patch.tone = tone;
        if (Object.keys(patch).length > 0) made = await api.updateProject(made.id, patch);
      }
      setProject(made);
      const words = drafts[tone];
      if (words !== undefined && words !== made.sample) made = await api.updateProject(made.id, { sample: words });
      let added = imported;
      if (!added && found) {
        added = await peopleApi.commit({ batchId: found.batchId, projectId: made.id, drop: finder.dropped });
        if (added.added.length === 0) {
          setPhase('flow');
          setStep(1);
          finder.reset();
          setError(`Nobody new joined ${made.name}. Choose another list or search to go on.`);
          return;
        }
        setImported(added);
      }
      const started = await api.start(made.id);
      setFirstSendAt(started.firstSendAt);
      setPhase('ready');
      void refresh();
    } catch (e) {
      setPhase('flow');
      setError(messageOf(e));
    }
  };

  const open = async () => {
    if (!project || opened.current) return;
    opened.current = true;
    try {
      await api.setCurrentProject(project.id);
      await refresh();
    } catch (e) {
      toast(messageOf(e));
    }
    onOpen(project);
  };

  const again = () => {
    opened.current = false;
    setStep(0);
    setPhase('flow');
    setOffer('');
    setNameOverride(null);
    setEditing(false);
    setNameError('');
    setTone('warm');
    setDrafts({});
    setError('');
    setProject(null);
    setImported(null);
    setFirstSendAt('');
    finder.reset();
    finder.setWay('describe');
    void refresh();
  };

  const current = state.projects.find((p) => p.id === state.settings.currentProjectId) ?? null;
  const chosen = kept.length;
  const addedPeople = imported?.added ?? [];
  const sharedWith = joinNames(others.map((p) => p.name));
  const channelLine = connected.length === 0
    ? 'No channel is connected yet. Connect one in Your Callum before you start.'
    : `Uses ${joinNames(connected)}.${sharedWith ? ` Their daily limits are shared with ${sharedWith}.` : ''}`;

  return (
    <main className="np-root" data-screen="new-project" data-phase={phase}>
      <header className="np-header">
        <Wordmark />
        <div className="np-header-right">
          {phase === 'flow' ? (
            <div className="np-dots">
              {[0, 1, 2].map((i) => <span key={i} className="np-dot" data-state={i === step ? 'now' : i < step ? 'done' : 'next'} aria-hidden="true" />)}
              <span className="sr-only">{`${step + 1} of 3`}</span>
            </div>
          ) : null}
          {current ? <span className="np-keeps"><i aria-hidden="true" />{`${current.name} keeps going`}</span> : null}
          <button type="button" className="np-close" aria-label={current ? `Back to ${current.name}` : 'Close'} onClick={onClose}>
            <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </header>

      <div className="np-main">
        {phase === 'flow' && step === 0 ? (
          <section className="np-step step-in" aria-labelledby="np-q0">
            <h1 id="np-q0" className="np-title">What do you offer?</h1>
            <div className="np-col">
              <label htmlFor="np-offer" className="sr-only">What you offer, in one line</label>
              <textarea
                id="np-offer"
                className="np-offer"
                rows={2}
                value={offer}
                placeholder="One line, in your words"
                onChange={(e) => { setOffer(e.target.value); setNameError(''); }}
              />
              <div className="np-name">
                {hasOffer && name ? (
                  <>
                    <i className="np-name-dot" aria-hidden="true" />
                    <span className="np-name-text">Callum will call this</span>
                    {editing ? (
                      <>
                        <label htmlFor="np-pname" className="sr-only">Project name</label>
                        <input
                          id="np-pname"
                          className="np-name-input"
                          type="text"
                          autoFocus
                          value={draftName}
                          onChange={(e) => { setDraftName(e.target.value); setNameError(''); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); saveName(); }
                            else if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setNameError(''); }
                          }}
                        />
                        <button type="button" className="np-btn np-btn-ink np-btn-sm" onClick={saveName}>Save</button>
                        <button type="button" className="np-btn np-btn-ghost np-btn-sm" onClick={() => { setEditing(false); setNameError(''); }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <strong className="np-name-value">{name}</strong>
                        <button type="button" className="np-pencil" aria-label="Rename this project" onClick={() => { setDraftName(name); setNameError(''); setEditing(true); }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" /></svg>
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <span className="np-name-text">Callum suggests a short name as you type.</span>
                    <button type="button" className="np-btn np-btn-quiet np-btn-xs" onClick={() => { setOffer(EXAMPLE_OFFER); setNameOverride(null); }}>Try the Payroll example</button>
                  </>
                )}
              </div>
              {hasOffer && name && (nameError || clashText) ? <AlertLine>{nameError || clashText}</AlertLine> : null}
            </div>
            <div className="np-actions">
              <button type="button" className="np-btn np-btn-ink" aria-disabled={nameBlocked} onClick={() => { if (!nameBlocked) go(1); }}>Next</button>
              {nameBlocked ? <span className="np-why">{!hasOffer ? 'Write one line about what you offer first.' : clash ? 'Pick another name to continue.' : 'Callum needs a name to continue.'}</span> : null}
            </div>
          </section>
        ) : null}

        {phase === 'flow' && step === 1 ? (
          <section className="np-step np-wide step-in" aria-labelledby="np-q1">
            <h1 id="np-q1" className="np-title np-title-s">Who should Callum meet?</h1>
            <WhoPanel
              finder={finder}
              compact
              order={['describe', 'csv', 'paste', 'link']}
              title={(_, n) => `${n} ${n === 1 ? 'person joins' : 'people join'} ${name}`}
              hint="Tap a face to see who it is, or to leave someone out."
              onNotFit={(p) => toast(`${firstOf(p)} stays out of ${name}`)}
            />
            {error ? <AlertLine>{error}</AlertLine> : null}
            <div className="np-actions">
              <button type="button" className="np-btn np-btn-quiet" onClick={() => go(0)}>Back</button>
              <button type="button" className="np-btn np-btn-ink" aria-disabled={chosen === 0} onClick={() => { if (chosen > 0) go(2); }}>
                {chosen > 0 ? `These ${chosen} look right` : 'Next'}
              </button>
              {chosen === 0 ? (
                <span className="np-why">
                  {finder.phase === 'looking' || finder.phase === 'reading' ? 'Callum is still looking.' : finder.found ? 'Everyone was left out. Bring someone back.' : 'Describe someone, or bring a list, to continue.'}
                </span>
              ) : null}
            </div>
          </section>
        ) : null}

        {phase === 'flow' && step === 2 ? (
          <section className="np-step np-voice step-in" aria-labelledby="np-q2">
            <h1 id="np-q2" className="np-title">How should you sound?</h1>
            <div className="np-tone-wrap">
              <div className="np-seg" role="group" aria-label="Tone">
                {TONES.map((t) => (
                  <button key={t.key} type="button" aria-pressed={tone === t.key} onClick={() => setTone(t.key)}>{t.name}</button>
                ))}
              </div>
              <span className="np-quiet">{`${name} sounds ${TONES.find((t) => t.key === tone)?.name ?? 'Warm'}. Each project has its own voice.`}</span>
            </div>
            <div className="np-sample">
              <div className="np-sample-for">
                <Marble seed={first ? seedOf(first.key + first.name) : 700} size={34} tone="grey" />
                <span>{`A first hello to ${target}`}</span>
              </div>
              <label htmlFor="np-draft" className="sr-only">{`First message to ${(sample?.to.name ?? 'the first person').split(' ')[0]}`}</label>
              <textarea
                id="np-draft"
                className="np-bubble"
                rows={3}
                value={message}
                aria-busy={writing}
                placeholder={writing ? 'Callum is writing' : ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [tone]: e.target.value }))}
              />
              <span className="np-quiet np-bubble-hint">{edited ? 'Callum will use your words.' : 'Click the message to change any words.'}</span>
            </div>
            {sampleError?.key === sampleKey ? <AlertLine>{sampleError.message}</AlertLine> : null}
            <div className="np-channels">
              <span className="np-channel-icons" aria-hidden="true">
                <i><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M4 7.5l8 6 8-6" /></svg></i>
                <i className="np-in">in</i>
                <i><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.6" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg></i>
              </span>
              <span>{channelLine}</span>
            </div>
            {error ? <AlertLine>{error}</AlertLine> : null}
            <div className="np-actions">
              <button type="button" className="np-btn np-btn-quiet np-btn-lg" disabled={imported !== null} onClick={() => go(1)}>Back</button>
              <button type="button" className="np-btn np-btn-ink np-btn-lg np-start" onClick={() => void start()}>
                <i aria-hidden="true" />
                {`Start ${name}`}
              </button>
            </div>
          </section>
        ) : null}

        {phase === 'starting' ? (
          <section className="np-step np-starting step-in" aria-labelledby="np-qs">
            <span className="np-ring" aria-hidden="true">
              <i className="np-ring-glow" />
              <svg viewBox="0 0 132 132">
                <circle cx="66" cy="66" r="60" fill="none" stroke="#E7E9F0" strokeWidth="5" />
                <circle className="np-ring-draw" cx="66" cy="66" r="60" fill="none" stroke="#3F52D9" strokeWidth="5" strokeLinecap="round" transform="rotate(-90 66 66)" />
              </svg>
              <b />
            </span>
            <h1 id="np-qs" className="np-title np-title-s" role="status">{`Setting up ${name}`}</h1>
            <p className="np-lede">{connected.length > 0 ? `${joinNames(connected.map((c) => c.charAt(0).toUpperCase() + c.slice(1)))} ${connected.length === 1 ? 'is' : 'are'} already connected.` : 'Callum is getting everything ready.'}</p>
          </section>
        ) : null}

        {phase === 'ready' ? (
          <section className="np-step np-ready step-in" aria-labelledby="np-qr">
            <span className="np-check" aria-hidden="true">
              <svg className="pop-in" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </span>
            <div className="np-ready-text">
              <h1 id="np-qr" className="np-title np-title-m">{`${project?.name ?? name} is ready`}</h1>
              <p className="np-lede">{`You'll OK the first 10 hellos ${fromWords(firstSendAt, tz, now())}.`}</p>
              {imported?.creditsUsed !== undefined ? <p className="np-quiet">{`${imported.added.length} ${imported.added.length === 1 ? 'person joined' : 'people joined'}. That used ${imported.creditsUsed.toLocaleString('en-US')} Apollo ${imported.creditsUsed === 1 ? 'credit' : 'credits'}.`}</p> : null}
              {imported?.warning ? <AlertLine>{imported.warning}</AlertLine> : null}
            </div>
            <div className="np-actions">
              <button type="button" className="np-btn np-btn-ink np-btn-lg np-start" onClick={() => void open()}>
                {`See ${project?.name ?? name} at home`}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
              <button type="button" className="np-btn np-btn-quiet np-btn-lg" onClick={again}>Start another project</button>
            </div>
          </section>
        ) : null}
      </div>

      <div className="np-river" data-ready={phase === 'ready'}>
        <River people={phase === 'ready' ? addedPeople : []} blank={phase !== 'ready'} />
      </div>
    </main>
  );
}
