import type { ReactNode } from 'react';
import type { AppState, Person } from '../../../shared/types.js';
import { marbleBackground } from '../../ui/Marble.js';
import { formatSlot, joinNames } from '../../ui/format.js';

/** The quiet pills under the top bar: what happened since yesterday and when the next hello goes. No percentages. */
export function Brief({ state, now }: { state: AppState; now: Date }) {
  const { brief } = state;
  const tz = state.settings.timezone;
  const accepted = brief.acceptedRecently;
  const face: Person | undefined = accepted.length > 0 ? state.people.find((p) => p.firstName === accepted[0]) : undefined;
  const since: { key: string; node: ReactNode; text: string }[] = [];

  if (brief.wantToTalk > 0) {
    since.push({ key: 'talk', node: <span className="brief-dot brief-dot-sun" aria-hidden="true" />, text: `${brief.wantToTalk} want to talk` });
  }
  if (brief.sentYesterday > 0) {
    since.push({
      key: 'sent',
      node: <span className="brief-dot brief-dot-ring" aria-hidden="true" />,
      text: `${brief.sentYesterday} ${brief.sentYesterday === 1 ? 'hello went' : 'hellos went'} out yesterday`,
    });
  }
  if (accepted.length > 0) {
    since.push({
      key: 'accepted',
      node: face ? <span className="brief-face" aria-hidden="true" style={{ background: marbleBackground(300 + face.id) }} /> : <span className="brief-dot brief-dot-ring" aria-hidden="true" />,
      text: `${joinNames(accepted)} accepted`,
    });
  }
  const next = brief.nextSendAt ? { key: 'next', node: <span className="brief-dot brief-dot-clock" aria-hidden="true" />, text: `Next hello ${formatSlot(brief.nextSendAt, tz, now)}` } : null;

  if (since.length === 0 && !next) return null;
  return (
    <div className="brief" aria-label="Since yesterday">
      {since.length > 0 ? <span className="brief-label">Since yesterday</span> : null}
      {[...since, ...(next ? [next] : [])].map((p) => (
        <span key={p.key} className="brief-pill">
          {p.node}
          {p.text}
        </span>
      ))}
    </div>
  );
}
