import { useEffect, useRef, useState } from 'react';
import type { OutboxItem, Person, Project, Tone } from '../../../shared/types.js';
import { api } from '../../api.js';
import { formatSlot } from '../../ui/format.js';
import { marbleBackground } from '../../ui/Marble.js';
import { useToast } from '../../ui/Toast.js';
import { messageOf } from '../connect/EmailConnect.js';
import { Chevron } from '../connect/parts.js';

const TONES: { key: Tone; name: string }[] = [
  { key: 'warm', name: 'Warm' },
  { key: 'direct', name: 'Direct' },
  { key: 'playful', name: 'Playful' },
];

// Letters and digits with dots, then an optional path: cal.com/gabriel, https://cal.com/gabriel/payroll.
const LINK = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const noScheme = (url: string | null) => (url ?? '').replace(/^https?:\/\//i, '');

type Field = 'name' | 'cal' | 'offer' | 'tone' | 'sample' | 'wrap';

export interface ProjectCardProps {
  project: Project;
  /** The other projects, wrapped ones too: a name is taken either way. */
  others: Project[];
  /** How many other projects are still going. Wrapping the last one is not allowed. */
  othersLive: number;
  people: Person[];
  outbox: OutboxItem[];
  timezone: string;
  now: Date;
  open: boolean;
  onToggle(): void;
  /** A project was saved; the page fetches state again. */
  onChanged(): Promise<void>;
  /** The project was wrapped. */
  onWrapped(): void;
  onAddPeople?: (projectId: number) => void;
  download(url: string): void;
}

function poss(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export function ProjectCard({
  project, others, othersLive, people, outbox, timezone, now, open, onToggle, onChanged, onWrapped, onAddPeople, download,
}: ProjectCardProps) {
  const toast = useToast();
  const [nameDraft, setNameDraft] = useState(project.name);
  const [calDraft, setCalDraft] = useState(noScheme(project.calendarUrl));
  const [offerDraft, setOfferDraft] = useState(project.offer ?? '');
  const [audienceDraft, setAudienceDraft] = useState(project.audience ?? '');
  const [tone, setTone] = useState<Tone>(project.tone);
  const [sample, setSample] = useState<string | null>(project.sample);
  const [sampleEdited, setSampleEdited] = useState(false);
  const [writing, setWriting] = useState(false);
  const [err, setErr] = useState<{ field: Field; text: string } | null>(null);
  const [offerSaved, setOfferSaved] = useState(false);
  const [calSaved, setCalSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [bubbleKey, setBubbleKey] = useState(0);
  const ticket = useRef(0);
  const asked = useRef(false);

  const live = people.filter((p) => p.status !== 'removed');
  const talking = live.filter((p) => p.stage === 'talking');
  const paused = project.state === 'paused';
  const first = live[0] ?? null;

  const line = paused
    ? project.pausedUntil
      ? `Paused until ${formatSlot(project.pausedUntil, timezone, now)}`
      : 'Paused'
    : `${live.length} ${live.length === 1 ? 'person' : 'people'}, ${talking.length} talking`;

  // A hello the person has not seen yet: written when the project opens with none saved.
  useEffect(() => {
    if (!open || sample !== null || asked.current) return;
    asked.current = true;
    api
      .sample(tone, project.id)
      .then((res) => setSample((s) => s ?? res.body))
      .catch(() => {
        // Nothing to show yet; choosing a voice asks again.
        asked.current = false;
      });
  }, [open, sample, tone, project.id]);

  const fail = (field: Field, text: string) => setErr({ field, text });
  const clear = () => setErr(null);

  const save = async (patch: Parameters<typeof api.updateProject>[1], field: Field): Promise<boolean> => {
    try {
      await api.updateProject(project.id, patch);
      await onChanged();
      return true;
    } catch (e) {
      fail(field, messageOf(e));
      return false;
    }
  };

  const saveName = async () => {
    const value = nameDraft.trim();
    if (value === project.name) return clear();
    if (!value) return fail('name', `A project needs a name. Callum kept "${project.name}". Type a name to save.`);
    if (others.some((o) => o.name.toLowerCase() === value.toLowerCase())) {
      return fail('name', `You already have a project called ${value}. Callum kept the old name. Pick another name.`);
    }
    if (await save({ name: value }, 'name')) clear();
  };

  const saveCal = async () => {
    const value = calDraft.trim();
    if (value === noScheme(project.calendarUrl)) return clear();
    setCalSaved(false);
    if (value && !LINK.test(value)) {
      return fail('cal', `That doesn't look like a link. Callum kept ${noScheme(project.calendarUrl) || 'the old link'}. Try something like cal.com/gabriel.`);
    }
    const url = value ? (/^https?:\/\//i.test(value) ? value : `https://${value}`) : null;
    if (await save({ calendarUrl: url }, 'cal')) {
      clear();
      setCalSaved(Boolean(url));
    }
  };

  const saveOffer = async () => {
    const value = offerDraft.trim();
    if (value === (project.offer ?? '')) return;
    setOfferSaved(false);
    if (!value) return fail('offer', `Say what you offer in one line. Callum kept the old words.`);
    if (await save({ offer: value }, 'offer')) {
      clear();
      setOfferSaved(true);
    }
  };

  const saveAudience = async () => {
    const value = audienceDraft.trim();
    if (value === (project.audience ?? '')) return;
    if (await save({ audience: value }, 'offer')) clear();
  };

  const pickTone = async (next: Tone) => {
    if (next === tone) return;
    const mine = ++ticket.current;
    const before = tone;
    setTone(next);
    setWriting(true);
    clear();
    try {
      const res = await api.sample(next, project.id);
      if (mine !== ticket.current) return;
      setSample(res.body);
      setSampleEdited(false);
      setBubbleKey((k) => k + 1);
      await api.updateProject(project.id, { tone: next, sample: res.body });
      await onChanged();
    } catch (e) {
      if (mine !== ticket.current) return;
      setTone(before);
      fail('tone', messageOf(e));
    } finally {
      if (mine === ticket.current) setWriting(false);
    }
  };

  const saveSample = async () => {
    const value = (sample ?? '').trim();
    if (!value || value === (project.sample ?? '')) return;
    if (await save({ sample: value }, 'sample')) {
      clear();
      setSampleEdited(true);
    }
  };

  const togglePause = async () => {
    try {
      if (paused) {
        await api.resumeProject(project.id);
        toast(`${project.name} is back to work`);
      } else {
        await api.pauseProject(project.id, null);
        const keepsGoing = others.find((o) => o.state === 'running');
        toast(`${project.name} is paused. ${keepsGoing ? `${keepsGoing.name} keeps going.` : 'Nothing else is running.'}`);
      }
      await onChanged();
    } catch (e) {
      fail('wrap', messageOf(e));
    }
  };

  const wrap = async (andDownload: boolean) => {
    try {
      if (andDownload) download(api.exportCsvUrl(project.id));
      const res = await api.wrapProject(project.id);
      setConfirming(false);
      toast(res.summary, { ms: 6000 });
      onWrapped();
      await onChanged();
    } catch (e) {
      setConfirming(false);
      fail('wrap', messageOf(e));
    }
  };

  const ids = new Set(people.map((p) => p.id));
  const scheduled = outbox.filter((o) => ids.has(o.personId) && o.origin === 'auto' && (o.state === 'scheduled' || o.state === 'awaiting_ok')).length;
  const canWrap = othersLive > 0 && project.state !== 'wrapped';
  const bad = (f: Field) => (err?.field === f ? true : undefined);
  const sampleFor = `A first hello${first ? ` to ${first.firstName}${first.company ? ` at ${first.company}` : ''}` : ''}, in your ${TONES.find((t) => t.key === tone)?.name ?? ''} voice`;

  return (
    <div className="yc-proj" data-open={open}>
      <button type="button" className="yc-rowhead" onClick={onToggle} aria-expanded={open}>
        <span className="yc-strip" aria-hidden="true">
          {live.slice(0, 6).map((p) => (
            <span key={p.id} className="yc-strip-face" style={{ background: marbleBackground(p.id), filter: paused ? 'grayscale(1)' : undefined, opacity: paused ? 0.6 : 1 }} />
          ))}
        </span>
        <span className="yc-proj-name">
          <span className="yc-proj-title">{project.name}</span>{' '}
          <span className="yc-proj-line">{line}</span>
        </span>
        <span className="yc-chev" data-open={open}><Chevron /></span>
      </button>

      {open ? (
        <div className="yc-open fade-in">
          <div className="yc-two">
            <label className="yc-field">
              <span>Name</span>
              <input
                className="yc-input"
                type="text"
                value={nameDraft}
                aria-invalid={bad('name')}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
            <label className="yc-field">
              <span>Calendar link</span>
              <input
                className="yc-input"
                type="text"
                value={calDraft}
                aria-invalid={bad('cal')}
                placeholder="cal.com/gabriel"
                onChange={(e) => setCalDraft(e.target.value)}
                onBlur={() => void saveCal()}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
          </div>
          {err && (err.field === 'name' || err.field === 'cal') ? (
            <p className="yc-alert fade-in" role="alert"><span className="yc-alert-dot" aria-hidden="true" />{err.text}</p>
          ) : (
            <p className="yc-hint">
              {calSaved ? 'Saved. Book a call sends this link.' : calDraft.trim() ? 'Used when you tap Book a call.' : 'Add one so Book a call works'}
            </p>
          )}

          <label className="yc-field">
            <span>What you offer</span>
            <textarea
              className="yc-input yc-offer"
              rows={2}
              value={offerDraft}
              aria-invalid={bad('offer')}
              onChange={(e) => {
                setOfferDraft(e.target.value);
                setOfferSaved(false);
              }}
              onBlur={() => void saveOffer()}
            />
          </label>
          {err?.field === 'offer' ? <p className="yc-alert fade-in" role="alert"><span className="yc-alert-dot" aria-hidden="true" />{err.text}</p> : null}
          {offerSaved ? <p className="yc-hint">Got it. Callum uses your words from the next hello.</p> : null}

          <div className="yc-who">
            <label className="yc-field yc-who-field">
              <span>Who to meet</span>
              <input
                className="yc-input"
                type="text"
                value={audienceDraft}
                placeholder="Ops teams at fintechs in Lagos"
                onChange={(e) => setAudienceDraft(e.target.value)}
                onBlur={() => void saveAudience()}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
            {onAddPeople ? <button type="button" className="yc-pill" onClick={() => onAddPeople(project.id)}>Add people</button> : null}
          </div>

          <div className="yc-voice">
            <div className="yc-voice-head">
              <span className="yc-label">How you sound</span>
              <div className="yc-seg" role="group" aria-label={`Tone for ${project.name}`}>
                {TONES.map((t) => (
                  <button key={t.key} type="button" aria-pressed={tone === t.key} onClick={() => void pickTone(t.key)}>{t.name}</button>
                ))}
              </div>
            </div>
            {confirming ? null : (
              <div className="yc-sample">
                <span className="yc-sample-face" aria-hidden="true" style={{ background: marbleBackground(first?.id ?? 300) }} />
                <div className="yc-sample-body">
                  <label htmlFor={`yc-sample-${project.id}`} className="yc-sample-for">{sampleFor}</label>
                  <textarea
                    id={`yc-sample-${project.id}`}
                    key={bubbleKey}
                    className="yc-bubble"
                    rows={3}
                    value={sample ?? ''}
                    aria-busy={writing}
                    data-writing={writing}
                    placeholder={writing || sample === null ? 'Callum is writing' : ''}
                    onChange={(e) => setSample(e.target.value)}
                    onBlur={() => void saveSample()}
                  />
                  <span className="yc-hint">{sampleEdited ? 'Saved. Callum starts from your words.' : 'Click the message to change any words.'}</span>
                </div>
              </div>
            )}
            {err?.field === 'tone' || err?.field === 'sample' ? <p className="yc-alert fade-in" role="alert"><span className="yc-alert-dot" aria-hidden="true" />{err.text}</p> : null}
          </div>

          {confirming ? (
            <div className="yc-confirm fade-in">
              <p>
                {`Wrap up ${project.name}? ${scheduled} scheduled ${scheduled === 1 ? 'message is' : 'messages are'} cancelled. `}
                {`${talking.length} ${talking.length === 1 ? 'person' : 'people'} you're talking with stay in your dock. Download ${poss(project.name)} people first.`}
              </p>
              <div className="yc-confirm-actions">
                <button type="button" className="yc-solid" onClick={() => void wrap(true)}>Download and wrap up</button>
                <button type="button" className="yc-pill" onClick={() => void wrap(false)}>Wrap up</button>
                <button type="button" className="yc-ghost" onClick={() => setConfirming(false)}>Keep it</button>
              </div>
            </div>
          ) : (
            <div className="yc-actions">
              <button type="button" className="yc-pill" onClick={() => void togglePause()}>{paused ? `Resume ${project.name}` : `Pause ${project.name}`}</button>
              <button type="button" className="yc-pill" aria-disabled={!canWrap} onClick={() => canWrap && setConfirming(true)}>{`Wrap up ${project.name}`}</button>
              {canWrap ? null : <span className="yc-hint">Callum keeps at least one project. Use Take a break to pause everything.</span>}
            </div>
          )}
          {err?.field === 'wrap' ? <p className="yc-alert fade-in" role="alert"><span className="yc-alert-dot" aria-hidden="true" />{err.text}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
