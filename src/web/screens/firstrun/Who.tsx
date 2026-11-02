import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { Person } from '../../../shared/types.js';
import { api, ApiError, type Skipped } from '../../api.js';
import { Button } from '../../ui/Button.js';
import { formatCount, skippedLine } from '../../ui/format.js';
import { lookForStage, Marble } from '../../ui/Marble.js';
import { useToast } from '../../ui/Toast.js';
import { ArrowUp, CloseIcon, ErrorLine, UploadIcon } from './icons.js';
import { useCountUp } from './motion.js';

export const SEARCH_COUNT = 25;
/** Past this many matches the describe bar asks for a narrower search. */
export const TOO_MANY = 5000;

const CHIPS = ['Seed-stage fintech founders in Lagos', 'Heads of finance at fintechs', 'Startups'];
const NARROW = ['20 to 200 people'];
const LINKEDIN_LINK = /^(https?:\/\/)?([\w-]+\.)*linkedin\.com\/\S+$/i;
const PEEKS = 8;

export function describePerson(p: Person): string {
  return [p.role, p.company].filter(Boolean).join(' at ');
}

function credits(n: number): string {
  return `${formatCount(n)} Apollo ${n === 1 ? 'credit' : 'credits'}`;
}

function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

export interface WhoProps {
  projectId: number;
  people: Person[];
  /** Adds people the server just took in (new ones only). */
  onAdded(added: Person[]): void;
  onRemoved(id: number): void;
  /** The words used to describe them, kept on the project when going on. */
  onBack(): void;
  onNext(audience: string | null): void;
}

export function Who({ projectId, people, onAdded, onRemoved, onBack, onNext }: WhoProps) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [looking, setLooking] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [listText, setListText] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const [peek, setPeek] = useState<number | null>(null);
  const [out, setOut] = useState('');
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  // A search can spend Apollo credits, so it waits here, with its price, until the person says go.
  const [asking, setAsking] = useState<string | null>(null);
  const [tooMany, setTooMany] = useState<{ total: number; query: string } | null>(null);
  const [audience, setAudience] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const count = people.length;
  const shown = useCountUp(count);
  const peeks = people.slice(0, PEEKS);
  const peeked = peek === null ? null : (people.find((p) => p.id === peek) ?? null);
  const idle = count === 0 && !tooMany;

  const take = (added: Person[], skipped: Skipped[], extra: string[] = []) => {
    const known = new Set(people.map((p) => p.id));
    const fresh = added.filter((p) => !known.has(p.id));
    if (fresh.length > 0) onAdded(fresh);
    setNotes([skippedLine(skipped), ...extra].filter(Boolean));
    setOut('');
    setPeek(null);
  };

  const search = async (query: string) => {
    const text = query.trim();
    if (!text || looking) return;
    setQ(text);
    setAsking(null);
    setError('');
    setTooMany(null);
    setListOpen(false);
    setLooking(true);
    try {
      const res = await api.search(text, SEARCH_COUNT, projectId);
      setAudience(text);
      if (res.total > TOO_MANY) setTooMany({ total: res.total, query: text });
      const extra: string[] = [];
      // Apollo's own count when the server has it; otherwise everyone it looked up, kept or skipped.
      const spent = res.creditsUsed ?? res.added.length + res.skipped.length;
      if (spent > 0) extra.push(`That used ${res.creditsUsed === undefined ? 'about ' : ''}${credits(spent)}.`);
      else if (res.total <= TOO_MANY) extra.push(`Nobody matched "${text}". Try a wider role or a nearby city.`);
      take(res.added, res.skipped, extra);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLooking(false);
    }
  };

  const useList = async () => {
    if (looking) return;
    const text = listText.trim();
    if (!file && !text) return setError('Paste some names or a LinkedIn link first, or drop a CSV.');
    const body = file && !text
      ? { csv: file.text }
      : LINKEDIN_LINK.test(text) && !text.includes('\n')
        ? { linkedinSearchUrl: /^https?:\/\//i.test(text) ? text : `https://${text}` }
        : { paste: text };
    setError('');
    setTooMany(null);
    setLooking(true);
    try {
      const res = await api.importLeads({ ...body, projectId });
      take(res.added, res.skipped, res.added.length === 0 ? ['Nobody new came from that list.'] : []);
      setListOpen(false);
      setListText('');
      setFile(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLooking(false);
    }
  };

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setFile({ name: f.name, text: await f.text() });
      setError('');
    } catch {
      setError("Callum couldn't read that file. Try saving it as a CSV again.");
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void readFile(e.dataTransfer.files[0]);
  };

  const notFit = async () => {
    if (!peeked) return;
    try {
      await api.remove(peeked.id);
      onRemoved(peeked.id);
      setOut(`${peeked.firstName} is out and will not hear from Callum.`);
      setPeek(null);
    } catch (e) {
      toast(messageOf(e));
    }
  };

  const askFor = (query: string) => {
    const text = query.trim();
    if (!text || looking) return;
    setQ(text);
    setError('');
    setTooMany(null);
    setListOpen(false);
    setAsking(text);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return setError('Describe them in a few words, or bring a list.');
    askFor(q);
  };

  return (
    <section className="fr-step fr-who step-in" aria-labelledby="q3">
      <h1 id="q3" className="fr-title">Who do you want to meet?</h1>
      <form className="ask-pill" onSubmit={submit}>
        <span className="ask-dot" aria-hidden="true" />
        <label htmlFor="who" className="sr-only">Describe who you want to meet</label>
        <input
          id="who"
          className="ask-input"
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Describe them like you would to a friend"
        />
        <button type="submit" className="ask-go" aria-label="Find people" disabled={looking}><ArrowUp /></button>
      </form>

      {!listOpen && !looking && !asking ? (
        <div className="chip-row">
          {idle ? CHIPS.map((c) => (
            <button key={c} type="button" className="chip" onClick={() => askFor(c)}>{c}</button>
          )) : null}
          <button type="button" className="chip chip-dashed" onClick={() => setListOpen(true)}><UploadIcon />Bring a list</button>
        </div>
      ) : null}

      {asking ? (
        <div className="fr-estimate fade-in">
          <p>{`Callum can look for ${SEARCH_COUNT} people. That uses about ${SEARCH_COUNT} Apollo credits.`}</p>
          <div className="fr-actions">
            <Button className="btn-sm" variant="ghost" onClick={() => setAsking(null)}>Not now</Button>
            <Button className="btn-sm" onClick={() => void search(asking)}>Find them</Button>
          </div>
        </div>
      ) : null}

      {listOpen ? (
        <div
          className="fr-list fade-in"
          data-over={over}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <div className="fr-list-head">
            <strong>Drop a CSV here, or paste a LinkedIn search link</strong>
            <span>Callum checks every name and skips people you already know.</span>
          </div>
          <label htmlFor="list" className="sr-only">Paste names, one per line, or a LinkedIn search link</label>
          <textarea
            id="list"
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            placeholder={'Kemi Eze, kemi@okopay.com\nlinkedin.com/in/tundebello'}
          />
          <div className="fr-list-foot">
            {file ? <span className="fr-file">{file.name}</span> : null}
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              aria-label="Choose a CSV"
              tabIndex={-1}
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button className="btn-sm" variant="quiet" onClick={() => fileInput.current?.click()}>Choose a CSV</Button>
            <Button className="btn-sm" variant="ghost" onClick={() => { setListOpen(false); setError(''); }}>Cancel</Button>
            <Button className="btn-sm" aria-busy={looking} disabled={looking} onClick={() => void useList()}>Use my list</Button>
          </div>
        </div>
      ) : null}

      {tooMany ? (
        <div className="fr-narrow fade-in">
          <p>
            <strong>{`That's about ${formatCount(tooMany.total)} people.`}</strong> Narrow it down?
          </p>
          <div className="chip-row">
            {NARROW.map((c) => (
              <button key={c} type="button" className="chip chip-soft" onClick={() => askFor(`${tooMany.query}, ${c}`)}>{c}</button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}

      <div className="fr-live" aria-live="polite">
        <span className="sr-only">{looking ? 'Callum is looking' : count > 0 ? `${count} people found` : ''}</span>
        {looking ? (
          <div className="fr-looking fade-in" aria-hidden="true">
            <span className="fr-pulses"><span /><span /><span /></span>
            Callum is looking
          </div>
        ) : null}
        {count > 0 ? (
          <div className="fr-found">
            <div className="fr-count" aria-hidden="true">
              <strong data-testid="found-count">{shown}</strong>
              <span>{shown === count ? 'people found' : 'and counting'}</span>
            </div>
            {shown === count ? (
              <div className="fr-found fade-in">
                <div className="fr-peeks">
                  <div className="fr-peek-row" role="group" aria-label="Some of the people Callum found">
                    {peeks.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="peek"
                        aria-label={[p.name, describePerson(p)].filter(Boolean).join(', ')}
                        aria-expanded={peek === p.id}
                        onClick={() => setPeek(peek === p.id ? null : p.id)}
                      >
                        <Marble seed={300 + p.id} size={40} {...lookForStage(p.stage)} style={{ display: 'block', width: '100%', height: '100%' }} />
                      </button>
                    ))}
                  </div>
                  {count > peeks.length ? <span className="fr-more">{`and ${formatCount(count - peeks.length)} more`}</span> : null}
                </div>
                {peeked ? (
                  <div className="fr-peek-card fade-in">
                    <Marble seed={300 + peeked.id} size={42} tone="grey" />
                    <span className="fr-peek-who">
                      <strong>{peeked.name}</strong>
                      <span>{describePerson(peeked)}</span>
                    </span>
                    <Button className="btn-sm" variant="quiet" onClick={() => void notFit()}>Not a fit</Button>
                    <button type="button" className="fr-icon-btn" aria-label="Close" onClick={() => setPeek(null)}><CloseIcon /></button>
                  </div>
                ) : null}
                <p className="fr-found-note">{out || 'Tap a face to check anyone. Nobody hears from Callum yet.'}</p>
                {notes.map((n) => (
                  <p key={n} className="fr-quiet">{n}</p>
                ))}
              </div>
            ) : null}
          </div>
        ) : notes.length > 0 && !looking ? (
          <div className="fr-found">
            {notes.map((n) => (
              <p key={n} className="fr-quiet">{n}</p>
            ))}
          </div>
        ) : null}
      </div>

      <div className="fr-actions">
        <Button variant="quiet" onClick={onBack}>Back</Button>
        <Button disabled={count === 0 || looking} onClick={() => onNext(audience)}>Next</Button>
      </div>
    </section>
  );
}
