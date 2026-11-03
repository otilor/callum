import { useRef, type ChangeEvent } from 'react';
import { splitPlaceholders } from './highlight.js';
import './DraftField.css';

export interface DraftFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}

/**
 * A text box that marks `[PLACEHOLDERS]` as you read. A textarea cannot colour part of its text, so the same words are
 * drawn underneath it, with the placeholders highlighted, and the textarea on top is see-through.
 */
export function DraftField({ id, value, onChange, label, disabled }: DraftFieldProps) {
  const back = useRef<HTMLDivElement>(null);
  const parts = splitPlaceholders(value);
  return (
    <div className="draft">
      <div className="draft-back" ref={back} aria-hidden="true">
        {parts.map((p, i) =>
          p.placeholder ? (
            <mark key={i} className="draft-hole">{p.text}</mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {/* A trailing newline would not take up room without this. */}
        {value.endsWith('\n') ? '​' : null}
      </div>
      <textarea
        id={id}
        aria-label={label}
        className="draft-text"
        value={value}
        disabled={disabled}
        spellCheck
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        onScroll={(e) => {
          if (back.current) back.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
