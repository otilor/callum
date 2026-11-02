import { useState } from 'react';
import { Button } from '../../ui/Button.js';
import { ErrorLine, GlobeIcon, PencilIcon } from './icons.js';

export interface OfferProps {
  offer: string;
  onOffer(text: string): void;
  /** Where Callum read the offer from, e.g. `yourcompany.com`, when the text is still the one it wrote. */
  readFrom: string | null;
  reading: boolean;
  /** The name Callum would give the project, or the one the person typed. Empty when there is nothing to name yet. */
  name: string;
  onRename(name: string): void;
  /** Something went wrong with the offer or the save. */
  error: string;
  /** The server refused the name, for example because another project already has it. Shown beside the pencil. */
  nameProblem: string;
  busy: boolean;
  onBack(): void;
  onNext(): void;
}

export function Offer({ offer, onOffer, readFrom, reading, name, onRename, error, nameProblem, busy, onBack, onNext }: OfferProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameError, setNameError] = useState('');

  const startRename = () => {
    setDraft(name);
    setNameError('');
    setEditing(true);
  };
  const saveName = () => {
    const v = draft.trim();
    if (!v) return setNameError(`A project needs a name. Callum kept "${name}". Type a name to save.`);
    onRename(v);
    setEditing(false);
  };

  return (
    <section className="fr-step fr-offer step-in" aria-labelledby="q2">
      <h1 id="q2" className="fr-title">What do you offer?</h1>
      <div className="fr-offer-col">
        <span className="fr-offer-note">
          {readFrom ? (
            <>
              <GlobeIcon />
              Callum read {readFrom} and wrote this. Change any word.
            </>
          ) : reading ? (
            'Callum is reading your site'
          ) : (
            'One line, in your words'
          )}
        </span>
        <label htmlFor="offer" className="sr-only">What you offer, in one line</label>
        <textarea
          id="offer"
          className="fr-offer-line"
          rows={2}
          value={offer}
          placeholder="One line, in your words"
          onChange={(e) => onOffer(e.target.value)}
        />
        <div className="fr-name">
          {name ? (
            <>
              <span className="fr-name-dot" aria-hidden="true" />
              <span className="fr-name-text">Callum will call this</span>
              {editing ? (
                <>
                  <label htmlFor="pname" className="sr-only">Project name</label>
                  <input
                    id="pname"
                    className="fr-name-input"
                    type="text"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveName();
                      } else if (e.key === 'Escape') {
                        e.stopPropagation();
                        setEditing(false);
                      }
                    }}
                  />
                  <Button className="btn-sm" onClick={saveName}>Save</Button>
                  <Button className="btn-sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span className="fr-name-value">{name}</span>
                  <button type="button" className="fr-pencil" aria-label="Rename this project" onClick={startRename}>
                    <PencilIcon />
                  </button>
                </>
              )}
            </>
          ) : (
            <span className="fr-name-text">Callum suggests a short name as you type.</span>
          )}
        </div>
        {nameError || nameProblem ? <ErrorLine>{nameError || nameProblem}</ErrorLine> : null}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </div>
      <div className="fr-actions">
        <Button variant="quiet" onClick={onBack}>Back</Button>
        <Button aria-busy={busy} disabled={busy} onClick={onNext}>Looks right</Button>
      </div>
    </section>
  );
}
