/** Opt-out line appended to every email body, after a blank line. */
export const OPT_OUT_LINE = "If this isn't for you, just reply stop and I won't write again.";

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

export function withOptOut(body: string): string {
  return body.includes(OPT_OUT_LINE) ? body : `${body}\n\n${OPT_OUT_LINE}`;
}

/** Plain-words explanation for a placeholder the user has to fill in. */
export function placeholderMessage(ph: string): string {
  const never = `Callum never sends a message with ${ph} in it.`;
  if (ph.startsWith('[')) {
    const what = ph.slice(1, -1).trim().toLowerCase().replace(/^your\s+/, '');
    return `Add your ${what} first. ${never}`;
  }
  return `Fill in ${ph} first. ${never}`;
}
