import { useCallback, useEffect, useRef, useState } from 'react';
import type { Person, Tone as ToneName } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { Button } from '../../ui/Button.js';
import { Marble } from '../../ui/Marble.js';
import { ErrorLine } from './icons.js';

const TONES: { key: ToneName; name: string }[] = [
  { key: 'warm', name: 'Warm' },
  { key: 'direct', name: 'Direct' },
  { key: 'playful', name: 'Playful' },
];

/** What the person chose and wrote on this step; kept by First run so going Back and forward loses nothing. */
export interface ToneStore {
  tone: ToneName;
  /** The person's own words, per tone. */
  drafts: Partial<Record<ToneName, string>>;
  /** What Callum wrote, per tone. */
  samples: Partial<Record<ToneName, string>>;
  setTone(tone: ToneName): void;
  setDraft(tone: ToneName, text: string): void;
  setSample(tone: ToneName, text: string): void;
}

export function useToneStore(initial: ToneName): ToneStore {
  const [tone, setTone] = useState<ToneName>(initial);
  const [drafts, setDrafts] = useState<Partial<Record<ToneName, string>>>({});
  const [samples, setSamples] = useState<Partial<Record<ToneName, string>>>({});
  const setDraft = useCallback((t: ToneName, text: string) => setDrafts((d) => ({ ...d, [t]: text })), []);
  const setSample = useCallback((t: ToneName, text: string) => setSamples((d) => ({ ...d, [t]: text })), []);
  return { tone, drafts, samples, setTone, setDraft, setSample };
}

export interface ToneProps {
  projectId: number;
  /** The first person in the list: the sample is written to them. */
  first: Person;
  store: ToneStore;
  error: string;
  busy: boolean;
  onBack(): void;
  onNext(): void;
}

export function Tone({ projectId, first, store, error, busy, onBack, onNext }: ToneProps) {
  const { tone, drafts, samples, setSample } = store;
  const [failure, setFailure] = useState<{ tone: ToneName; message: string } | null>(null);
  // Two names for one animation, so the bubble can play it again each time the tone changes.
  const flip = useRef({ tone, n: 0 });
  if (flip.current.tone !== tone) flip.current = { tone, n: flip.current.n + 1 };
  const edited = drafts[tone] !== undefined;
  const has = samples[tone] !== undefined;

  useEffect(() => {
    if (has || edited) return;
    let current = true;
    setFailure(null);
    api
      .sample(tone, projectId)
      .then((res) => {
        if (current) setSample(tone, res.body);
      })
      .catch((e: unknown) => {
        if (current) setFailure({ tone, message: e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.' });
      });
    return () => {
      current = false;
    };
  }, [tone, projectId, has, edited, setSample]);

  const failed = failure?.tone === tone ? failure.message : '';
  const writing = !has && !edited && !failed;
  const message = drafts[tone] ?? samples[tone] ?? '';
  const target = [first.name, first.company ? `at ${first.company}` : ''].filter(Boolean).join(' ');

  return (
    <section className="fr-step fr-tone step-in" aria-labelledby="q4">
      <h1 id="q4" className="fr-title">How should Callum sound?</h1>
      <div className="fr-tone-seg" role="group" aria-label="Tone">
        {TONES.map((t) => (
          <button key={t.key} type="button" className="seg-btn" aria-pressed={tone === t.key} onClick={() => store.setTone(t.key)}>{t.name}</button>
        ))}
      </div>
      <div className="fr-sample">
        <div className="fr-sample-for">
          <Marble seed={300 + first.id} size={34} tone="grey" />
          <span>{`First hello to ${target}`}</span>
        </div>
        <label htmlFor="draft" className="sr-only">{`First message to ${first.firstName}`}</label>
        <textarea
          id="draft"
          className={`fr-bubble ${flip.current.n % 2 ? 'bubble-a' : 'bubble-b'}`}
          rows={3}
          value={message}
          aria-busy={writing}
          placeholder={writing ? 'Callum is writing' : ''}
          onChange={(e) => store.setDraft(tone, e.target.value)}
        />
        <span className="fr-bubble-hint">{edited ? 'Callum will use your words.' : 'Click the message to change any words.'}</span>
      </div>
      {failed ? <ErrorLine>{failed}</ErrorLine> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="fr-actions">
        <Button variant="quiet" onClick={onBack}>Back</Button>
        <Button aria-busy={busy} disabled={busy} onClick={onNext}>Next</Button>
      </div>
    </section>
  );
}
