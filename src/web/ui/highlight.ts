import { findPlaceholders as guardPlaceholders } from '../../server/engine/guard.js';

export interface TextPart { text: string; placeholder: boolean }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text in order, with each placeholder as a part of its own. What counts as a placeholder is decided by the same
 * function the server uses before it sends, so what is marked here is exactly what would be refused there.
 */
export function splitPlaceholders(text: string): TextPart[] {
  const holes = guardPlaceholders(text);
  if (holes.length === 0) return text ? [{ text, placeholder: false }] : [];
  const pattern = new RegExp([...holes].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g');
  const parts: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > at) parts.push({ text: text.slice(at, start), placeholder: false });
    parts.push({ text: m[0], placeholder: true });
    at = start + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), placeholder: false });
  return parts;
}

/** Each placeholder once, in the order it first appears. */
export function findPlaceholders(text: string): string[] {
  return guardPlaceholders(text);
}

/** Where the sentence around `at` starts and ends: at . ! ? followed by space, or at a line break. */
function sentenceAround(text: string, at: number, length: number): [number, number] {
  let start = 0;
  for (const m of text.slice(0, at).matchAll(/[.!?]+\s+|\n+/g)) start = (m.index ?? 0) + m[0].length;
  const rest = text.slice(at + length);
  const end = /[.!?]+(?=\s|$)|(?=\n)/.exec(rest);
  return [start, end ? at + length + end.index + end[0].length : text.length];
}

/** Takes out every sentence that holds `placeholder`, and keeps the spacing between what is left. */
export function removePlaceholderSentence(text: string, placeholder: string): string {
  let out = text;
  for (let guard = 0; guard < 50; guard++) {
    const at = out.indexOf(placeholder);
    if (at < 0) break;
    const [start, end] = sentenceAround(out, at, placeholder.length);
    const before = out.slice(0, start);
    const after = out.slice(end);
    const gapBefore = /\s*$/.exec(before)?.[0] ?? '';
    const gapAfter = /^\s*/.exec(after)?.[0] ?? '';
    const kept = before.trimEnd();
    const rest = after.trimStart();
    const gap = !kept || !rest ? '' : /\n/.test(gapBefore) ? gapBefore : /\n/.test(gapAfter) ? gapAfter : ' ';
    out = kept + gap + rest;
  }
  return out;
}

function noun(placeholder: string): string | null {
  if (!placeholder.startsWith('[')) return null;
  const inner = placeholder.slice(1, -1).toLowerCase();
  return inner.startsWith('your ') ? inner.slice(5) : inner;
}

/** The line that says why Reply is off: `Add your price first. Callum never sends a message with [YOUR PRICE] in it.` */
export function guardLine(placeholder: string): string {
  const n = noun(placeholder);
  return `${n ? `Add your ${n} first.` : `Fill in ${placeholder} first.`} Callum never sends a message with ${placeholder} in it.`;
}

/** The quick fix beside the guard: `Leave the price out`. */
export function leaveOutLabel(placeholder: string): string {
  const n = noun(placeholder);
  return n ? `Leave the ${n} out` : 'Leave it out';
}
