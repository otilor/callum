import { useState, type ReactNode } from 'react';
import type { AppState, Project } from '../../../shared/types.js';
import { PhoneAsk } from './PhoneAsk.js';
import { PhoneNotice, usePhoneNotice } from './PhoneNotice.js';
import { PhoneRiver } from './PhoneRiver.js';
import { PhoneYou } from './PhoneYou.js';
import { PHONE_TABS, wantToTalk, type PhoneTab } from './phoneCopy.js';
import './PhoneApp.css';

export interface PhoneTabsProps {
  state: AppState;
  /** The project on screen. */
  project: Project | null;
  refresh(): Promise<void> | void;
  /** The tab shown. Leave out to let the bar keep it. */
  tab?: PhoneTab;
  onTab?(tab: PhoneTab): void;
  /** Draws the River tab instead of the built-in one. */
  river?: ReactNode;
  onOpenSettings?(): void;
  onLeave?(): void;
  now?: () => Date;
}

function Glyph({ tab }: { tab: PhoneTab }) {
  if (tab === 'river') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
        <path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0" />
      </svg>
    );
  }
  if (tab === 'ask') return <span className="pa-glyph-ask" aria-hidden="true" />;
  return <span className="pa-glyph-you" aria-hidden="true" />;
}

/** The bottom bar of the phone: River, Ask, You. */
export function PhoneTabs({ state, project, refresh, tab, onTab, river, onOpenSettings, onLeave, now = () => new Date() }: PhoneTabsProps) {
  const [own, setOwn] = useState<PhoneTab>('river');
  const current = tab ?? own;
  const { notice, notify, clear } = usePhoneNotice();
  const tz = state.settings.timezone;
  const at = now();
  const waiting = wantToTalk(state.people).length;

  const pick = (next: PhoneTab) => {
    setOwn(next);
    onTab?.(next);
  };

  return (
    <div className="pa-app">
      <div className="pa-panel" id={`pa-panel-${current}`} role="region" aria-label={PHONE_TABS.find((t) => t.id === current)?.label}>
        {current === 'river' ? (
          river ?? <PhoneRiver state={state} project={project} tz={tz} now={at} notify={notify} refresh={refresh} />
        ) : null}
        {current === 'ask' ? <PhoneAsk state={state} project={project} notify={notify} refresh={refresh} /> : null}
        {current === 'you' ? (
          <PhoneYou
            state={state}
            project={project}
            tz={tz}
            now={at}
            notify={notify}
            refresh={refresh}
            {...(onOpenSettings ? { onOpenSettings } : {})}
            {...(onLeave ? { onLeave } : {})}
          />
        ) : null}
      </div>

      <PhoneNotice notice={notice} onDone={clear} />

      <nav className="pa-nav" aria-label="Places">
        {PHONE_TABS.map((t) => {
          const showCount = t.id === 'river' && waiting > 0 && current !== 'river';
          return (
            <button
              key={t.id}
              type="button"
              className="pa-nav-btn"
              aria-current={current === t.id ? 'page' : undefined}
              onClick={() => pick(t.id)}
            >
              <span className="pa-nav-icon">
                <Glyph tab={t.id} />
                {showCount ? <span className="pa-nav-count" aria-label={`${waiting} want to talk`}>{waiting}</span> : null}
              </span>
              {t.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
