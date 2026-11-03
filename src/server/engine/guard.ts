/** Opt-out line appended to every email body, after a blank line. */
export const OPT_OUT_LINE = "If this isn't for you, just reply stop and I won't write again.";

export { findPlaceholders } from '../../shared/placeholders.js';
import { findPlaceholders } from '../../shared/placeholders.js';

export function withOptOut(body: string): string {
  return body.includes(OPT_OUT_LINE) ? body : `${body}\n\n${OPT_OUT_LINE}`;
}

/** Plain-words explanation for a placeholder the user has to fill in. */
export function placeholderMessage(ph: string): string {
  const never = `Callum never sends a message with ${ph} in it.`;
  if (ph.startsWith('[')) {
    const what = ph.slice(1, -1).replace(/_/g, ' ').trim().toLowerCase().replace(/^your(\s+|$)/, '');
    if (what) return `Add your ${what} first. ${never}`;
  }
  return `Fill in ${ph} first. ${never}`;
}
