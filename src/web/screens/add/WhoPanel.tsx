import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { PreviewPerson } from '../../../shared/types.js';
import { Marble } from '../../ui/Marble.js';
import { useCountUp } from '../firstrun/motion.js';
import { faceLabel, seedOf, shownName, shownSub, skipDetail, credits } from './words.js';
import type { Found, Way, WhoFinder } from './useWhoFinder.js';
import './AddPeople.css';

const IDEAS = ['Seed-stage fintech founders in Lagos', 'Heads of finance at fintechs', 'Startups that raised this year'];

function WayIcon({ way, ink }: { way: Way; ink: string }) {
  if (way === 'link') return <span className="ap-in" style={{ color: ink }} aria-hidden="true">in</span>;
  const common = { fill: 'none', stroke: ink, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
  if (way === 'csv') return <svg width="26" height="26" viewBox="0 0 24 24" {...common}><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>;
  if (way === 'paste') return <svg width="26" height="26" viewBox="0 0 24 24" {...common}><rect x="5" y="4.5" width="14" height="16" rx="2.5" /><path d="M9 9.5h6M9 13h6M9 16.5h3.5" /></svg>;
  return <svg width="26" height="26" viewBox="0 0 24 24" {...common}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>;
}

const WAY_LABEL: Record<Way, string> = { csv: 'Drop a CSV', paste: 'Paste names', link: 'LinkedIn search link', describe: 'Describe who' };

function Pulses() {
  return (
    <span className="ap-pulses" aria-hidden="true"><span /><span /><span /></span>
  );
}

export function AlertLine({ children }: { children: ReactNode }) {
  return (
    <p className="ap-alert fade-in" role="alert">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D9480F" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.6v.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

/** `Heads of finance in Accra` becomes `Heads of finance`: a wider search to offer when nobody matched. */
function widerSearch(query: string): string | null {
  const wider = query.replace(/\s+(?:in|near|around)\s+[\p{Lu}][\p{L}'.\s-]*$/u, '').trim();
  return wider !== '' && wider !== query.trim() ? wider : null;
}

export interface WhoPanelProps {
  finder: WhoFinder;
  /** The order of the four ways. */
  order?: Way[];
  compact?: boolean;
  /** The title over the faces. Callum found 20, or 41 new people. */
  title?: (found: Found, kept: number) => string;
  /** Said when nothing is peeked. */
  hint?: string;
  /** Buttons that go under the preview, such as Add 41 people. */
  children?: ReactNode;
  /** Shown in place of the way's own content, for example once the people have been added. */
  replace?: ReactNode;
  /** Called when the user says someone is not a fit, so the screen can say so. */
  onNotFit?(person: PreviewPerson): void;
}

export function WhoPanel({ finder, order = ['csv', 'paste', 'link', 'describe'], compact = false, title, hint, children, replace, onNotFit }: WhoPanelProps) {
  const { way, phase, found, kept } = finder;
  const shownRows = useCountUp(finder.readTotal);
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<number>(-1);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    finder.chooseFile(e.dataTransfer.files[0]);
  };

  const lines = finder.pasteText.split('\n').map((l) => l.trim()).filter((l) => l.length > 1);
  const noWay = lines.filter((l) => !/@|linkedin\.com\/in\//i.test(l)).length;
  const reachable = lines.length - noWay;
  const pasteNote = lines.length === 0
    ? 'Callum checks every name and skips people you already know.'
    : `${lines.length} ${lines.length === 1 ? 'person' : 'people'}${noWay > 0 ? `. ${noWay} ${noWay === 1 ? 'has' : 'have'} no email, LinkedIn or X yet, so Callum will skip ${noWay === 1 ? 'that row' : 'those rows'}.` : ', all reachable.'}`;

  const describing = way === 'describe' && phase !== 'preview';
  const heading = found ? (title ? title(found, kept.length) : found.apollo ? `Callum found ${kept.length}` : `${kept.length} ${found.word}`) : '';
  const skippedTotal = found?.groups.reduce((n, g) => n + g.names.length, 0) ?? 0;
  const peek = finder.peek;
  const peekHint = hint ?? (found?.apollo
    ? 'Tap a face to check anyone. Not a fit leaves them out before anything is spent.'
    : way === 'link' ? 'Tap a face to check anyone. Callum will invite them on LinkedIn, 15 a day.' : 'Tap a face to check anyone before they join.');

  return (
    <div className={compact ? 'ap-who ap-compact' : 'ap-who'}>
      <div className="ap-ways" role="tablist" aria-label="Ways to add people">
        {order.map((w) => {
          const on = way === w;
          return (
            <button key={w} type="button" role="tab" className="ap-way" aria-selected={on} onClick={() => finder.setWay(w)}>
              <span className="ap-disc" data-on={on} aria-hidden="true"><WayIcon way={w} ink={on ? '#FFFFFF' : '#1D2140'} /></span>
              <span className="ap-way-label" data-on={on}>{WAY_LABEL[w]}</span>
            </button>
          );
        })}
      </div>

      <section className="ap-stage step-in" key={way} aria-live="polite">
        {replace ?? null}
        {replace ? null : (<>
        {phase === 'idle' && way === 'csv' ? (
          <button
            type="button"
            className="ap-drop"
            data-over={over}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
            <span className="ap-drop-title">Drop a CSV here, or choose one</span>
            <span className="ap-drop-note">A name and an email, a LinkedIn link or an X handle on each row. Callum checks every name and skips people you already know.</span>
          </button>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          className="sr-only"
          aria-label="Choose a CSV"
          tabIndex={-1}
          onChange={(e) => {
            finder.chooseFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        {phase === 'reading' && way === 'csv' ? (
          <div className="ap-reading fade-in" role="status">
            <Pulses />
            <span className="ap-reading-title">{`Reading ${finder.fileName}`}</span>
            <span className="ap-reading-count">{shownRows.toLocaleString('en-US')}</span>
            <span className="ap-reading-note">people so far</span>
          </div>
        ) : null}
        {phase === 'reading' && way === 'paste' ? <p className="ap-looking fade-in" role="status"><Pulses />Callum is reading your names</p> : null}
        {phase === 'reading' && way === 'link' ? <p className="ap-looking fade-in" role="status"><Pulses />Callum is reading the search on this computer</p> : null}
        {phase === 'looking' ? <p className="ap-looking fade-in" role="status"><Pulses />Callum is looking</p> : null}

        {way === 'paste' && phase === 'idle' ? (
          <div className="ap-paste">
            <label htmlFor="ap-paste" className="ap-paste-label">One person per line. A name, then an email, a LinkedIn link or an X handle.</label>
            <textarea
              id="ap-paste"
              className="ap-soft"
              value={finder.pasteText}
              onChange={(e) => finder.setPasteText(e.target.value)}
              placeholder={'Kwame Asante, kwame@osupay.com, Osu Pay\nAbena Mensah, linkedin.com/in/abena-mensah\nYaw Darko, @yawdarko'}
            />
            <div className="ap-paste-foot">
              <span className="ap-paste-note" data-warn={noWay > 0}>{pasteNote}</span>
              <button type="button" className="ap-btn ap-btn-ink" aria-disabled={reachable <= 0} disabled={reachable <= 0} onClick={finder.readPaste}>Read the names</button>
            </div>
          </div>
        ) : null}

        {way === 'link' && (phase === 'idle') ? (
          <div className="ap-link">
            <form className="ap-pill" onSubmit={(e) => { e.preventDefault(); finder.readLink(); }}>
              <label htmlFor="ap-link" className="sr-only">LinkedIn search link</label>
              <input id="ap-link" type="text" inputMode="url" value={finder.linkText} onChange={(e) => finder.setLinkText(e.target.value)} placeholder="Paste a LinkedIn people search link" />
              <button type="submit" className="ap-btn ap-btn-ink ap-btn-sm">Read it</button>
            </form>
            {finder.linkBad ? <AlertLine>That isn't a LinkedIn people search. It should start with linkedin.com/search/results/people.</AlertLine> : (
              <>
                <p className="ap-note">Search LinkedIn the way you normally would, then copy the link. Callum reads up to 100 people from it, on this computer, at a human pace.</p>
                <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => finder.readLink('https://www.linkedin.com/search/results/people/?keywords=fintech%20founder')}>Try a sample search</button>
              </>
            )}
          </div>
        ) : null}

        {describing ? (
          <div className="ap-describe">
            <form className="ap-pill" onSubmit={(e) => { e.preventDefault(); finder.look(); }}>
              <span className="ap-sun" aria-hidden="true" />
              <label htmlFor="ap-desc" className="sr-only">Describe who you want to meet</label>
              <input id="ap-desc" type="text" value={finder.descText} onChange={(e) => finder.setDescText(e.target.value)} placeholder="Describe who you want to meet" disabled={phase === 'looking'} />
              <button type="submit" className="ap-look" aria-label="Look" disabled={phase === 'looking'}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </form>
            {phase === 'idle' ? (
              <div className="ap-chips">
                {IDEAS.map((t) => <button key={t} type="button" className="ap-chip" onClick={() => { finder.setDescText(t); finder.look(t); }}>{t}</button>)}
              </div>
            ) : null}

            {phase === 'nosource' ? (
              <div className="ap-nosource fade-in">
                <p>Describing people needs a people search connected. Bring a list instead, or connect Apollo and Callum can look for you.</p>
                {!finder.apollo.open ? (
                  <div className="ap-row">
                    <button type="button" className="ap-btn ap-btn-ink ap-btn-sm" onClick={finder.openApollo}>Connect Apollo</button>
                    <button type="button" className="ap-btn ap-btn-white ap-btn-sm" onClick={() => finder.setWay('csv')}>Bring a list</button>
                  </div>
                ) : (
                  <form className="ap-apollo fade-in" onSubmit={(e) => { e.preventDefault(); finder.connectApollo(); }}>
                    <div className="ap-row">
                      <label htmlFor="ap-key" className="sr-only">Apollo API key</label>
                      <input id="ap-key" type="password" autoComplete="off" className="ap-soft ap-key" value={finder.apollo.key} onChange={(e) => finder.setApolloKey(e.target.value)} placeholder="Apollo API key" />
                      <button type="submit" className="ap-btn ap-btn-ink ap-btn-sm" aria-busy={finder.apollo.busy} disabled={finder.apollo.busy || finder.apollo.key.trim() === ''}>Connect</button>
                    </div>
                    <span className="ap-note">Find it in Apollo under Settings, then API. Callum uses it to find people and their emails. Adding people uses Apollo credits.</span>
                  </form>
                )}
              </div>
            ) : null}

            {phase === 'narrow' && finder.narrow ? (
              <div className="ap-narrow fade-in">
                <p>
                  <strong>{finder.narrow.described.line.split('. ')[0]}.</strong> {finder.narrow.described.line.split('. ').slice(1).join('. ')}
                </p>
                <div className="ap-chips">
                  {(finder.narrow.described.narrow ?? []).map((c) => {
                    const on = finder.narrow?.selected.includes(c) ?? false;
                    return <button key={c} type="button" className="ap-chip" data-on={on} aria-pressed={on} onClick={() => finder.toggleNarrow(c)}>{c}</button>;
                  })}
                </div>
                <button type="button" className="ap-btn ap-btn-ink" onClick={finder.findClosest}>{`Find the ${finder.narrow.described.people.length} closest fits`}</button>
              </div>
            ) : null}

            {phase === 'nobody' ? (
              <div className="ap-nobody fade-in">
                <p>{finder.nobodyLine}</p>
                {widerSearch(finder.descText) ? (
                  <div className="ap-chips">
                    <button type="button" className="ap-chip" onClick={() => { const w = widerSearch(finder.descText) ?? ''; finder.setDescText(w); finder.look(w); }}>{widerSearch(finder.descText)}</button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {finder.error ? <AlertLine>{finder.error}</AlertLine> : null}

        {phase === 'preview' && found ? (
          <>
            <div className="ap-preview fade-in">
              <div className="ap-preview-main">
                <p className="ap-preview-title">{heading}</p>
                <ul className="ap-faces" aria-label={heading}>
                  {kept.map((p, i) => {
                    const on = peek?.key === p.key;
                    return (
                      <li key={p.key}>
                        <button
                          type="button"
                          className="ap-peek pour"
                          aria-label={faceLabel(p)}
                          aria-pressed={on}
                          onClick={() => finder.togglePeek(p.key)}
                          style={{ animationDelay: `${Math.min(i, 40) * 25}ms` }}
                        >
                          <Marble seed={seedOf(p.key + p.name)} size={compact ? 36 : 32} tone={on ? 'warm' : 'grey'} ring={on ? '#3F52D9' : '#D5D9E4'} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {peek ? (
                  <div className="ap-peekcard fade-in">
                    <Marble seed={seedOf(peek.key + peek.name)} size={40} tone="grey" />
                    <span className="ap-peekcard-text">
                      <strong>{shownName(peek)}</strong>
                      <span>{shownSub(peek)}</span>
                    </span>
                    <button type="button" className="ap-btn ap-btn-white ap-btn-sm" onClick={() => { const out = finder.notFit(peek.key); if (out) onNotFit?.(out); }}>Not a fit</button>
                  </div>
                ) : <p className="ap-hint">{kept.length === 0 ? 'Everyone was left out. Choose another list to go on.' : peekHint}</p>}
                {found.apollo && kept.length > 0 ? <p className="ap-credits">{`Adding uses about ${credits(kept.length)}.`}</p> : null}
              </div>
              {found.groups.length > 0 ? (
                <div className="ap-skipped">
                  <p className="ap-skipped-title">{`${skippedTotal} skipped, and why`}</p>
                  {found.groups.map((g, i) => (
                    <div key={`${g.reason}-${g.projectName ?? ''}`} className="ap-group">
                      <button type="button" className="ap-grow" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
                        <span className="ap-count">{g.names.length}</span>
                        <span className="ap-reason">{g.line.replace(/^\d+ /, '')}</span>
                        <svg className="ap-chev" data-open={open === i} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#646B85" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                      {open === i ? <p className="ap-detail fade-in">{skipDetail(g)}</p> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {children}
          </>
        ) : null}
        </>)}
      </section>
    </div>
  );
}
