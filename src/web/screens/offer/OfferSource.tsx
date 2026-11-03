import { useState } from 'react';
import { api } from '../../api.js';
import { messageOf } from '../add/useWhoFinder.js';
import './OfferSource.css';

export type OfferWay = 'words' | 'site';

const WAYS: { key: OfferWay; label: string }[] = [
  { key: 'words', label: 'Describe it' },
  { key: 'site', label: 'Use my website' },
];

/** The two ways to tell Callum what you offer: in your own words, or by pointing it at your website. */
export function OfferWays({ way, onWay }: { way: OfferWay; onWay(way: OfferWay): void }) {
  return (
    <div className="os-ways" role="radiogroup" aria-label="How to tell Callum what you offer">
      {WAYS.map((w) => (
        <button
          key={w.key}
          type="button"
          role="radio"
          aria-checked={way === w.key}
          className="os-way"
          onClick={() => onWay(w.key)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

export interface SiteFieldProps {
  /** Callum read the site: the line it wrote, and the site's domain. */
  onRead(line: string, domain: string): void;
  /** The website to start with, e.g. one read before. */
  initial?: string;
}

type Reading = { state: 'idle' } | { state: 'done' } | { state: 'reading'; domain: string } | { state: 'failed'; message: string };

/** A website box: Callum reads the site and writes one line about what the company does. */
export function SiteField({ onRead, initial = '' }: SiteFieldProps) {
  const [site, setSite] = useState(initial);
  // A site read before (e.g. on the way back to this step) needs no hint about what reading does.
  const [reading, setReading] = useState<Reading>(initial ? { state: 'done' } : { state: 'idle' });
  const busy = reading.state === 'reading';

  const read = async () => {
    const typed = site.trim();
    if (busy) return;
    if (!typed) return setReading({ state: 'failed', message: 'Type your website first, like yourcompany.com.' });
    setReading({ state: 'reading', domain: typed.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '') });
    try {
      const res = await api.readSite(typed);
      if (res.offer && res.domain) {
        setReading({ state: 'done' });
        onRead(res.offer, res.domain);
      } else {
        const where = res.domain ?? typed;
        setReading({ state: 'failed', message: `Callum couldn't tell what you do from ${where}. Check the address, or describe it in your own words.` });
      }
    } catch (e) {
      setReading({ state: 'failed', message: messageOf(e) });
    }
  };

  return (
    <div className="os-site">
      <div className="os-site-row">
        <label htmlFor="os-site" className="sr-only">Your website</label>
        <input
          id="os-site"
          className="os-site-input"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={site}
          placeholder="yourcompany.com"
          onChange={(e) => { setSite(e.target.value); if (reading.state !== 'reading') setReading({ state: 'idle' }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void read(); } }}
        />
        <button type="button" className="os-read" aria-busy={busy} disabled={busy} onClick={() => void read()}>
          {busy ? 'Reading' : 'Read my site'}
        </button>
      </div>
      <p className="os-status" role="status">
        {reading.state === 'reading'
          ? `Callum is reading ${reading.domain} to see what you do.`
          : reading.state === 'failed'
            ? reading.message
            : reading.state === 'idle'
              ? 'Callum reads your site and writes one line about what you do. You can change any word.'
              : ''}
      </p>
    </div>
  );
}

/** The offer as saved: the line, with the website it came from kept beside it so Callum knows the sender's own site. */
export function withSite(line: string, domain: string | null): string {
  const text = line.trim();
  if (!text || !domain || text.toLowerCase().includes(domain.toLowerCase())) return text;
  return `${text} (${domain})`;
}

/** A project name from a website: "tethers.com" is "Tethers". */
export function siteName(domain: string): string {
  const root = domain.toLowerCase().replace(/^www\./, '').split('.')[0] ?? '';
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : '';
}
