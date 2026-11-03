const PLACEHOLDER_PATTERNS = [
  /\[[A-Z][A-Z0-9 _'’-]*\]/g, // [YOUR PRICE]
  /\{\{[^}]*\}\}/g,           // {{first_name}}
  /\{[a-z_]+\}/g,             // {first_name}
];

/**
 * Unique placeholders in text, in order of appearance. A match that sits inside a
 * larger one (the `{x}` inside `{{x}}`) is not reported on its own.
 */
export function findPlaceholders(text: string): string[] {
  const found: { start: number; end: number; text: string }[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      found.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: string[] = [];
  let coveredUntil = 0;
  for (const f of found) {
    if (f.start < coveredUntil) continue;
    coveredUntil = f.end;
    if (!out.includes(f.text)) out.push(f.text);
  }
  return out;
}

/** Enough words to say what the sender does: not empty, no blank to fill in, and more than a link or a name. */
export function offerSaysEnough(offer: string | null | undefined): boolean {
  const text = offer?.trim() ?? '';
  if (!text || findPlaceholders(text).length > 0) return false;
  const words = text
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/g, ' ')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  return words.length >= 3;
}
