import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState, Channel, ChannelAccount, Project } from '../../../shared/types.js';
import { CHANNELS } from '../../../shared/types.js';
import { api, channelSetup, claudeKeyApi, type ChannelSummary, type MicrosoftSetup } from '../../api.js';
import { joinNames } from '../../ui/format.js';
import { marbleBackground } from '../../ui/Marble.js';
import { useHeadingFocus } from '../../ui/useHeadingFocus.js';
import { useToast } from '../../ui/Toast.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { pickCurrentProject } from '../../useAppState.js';
import { ConnectSheet } from '../connect/ConnectSheet.js';
import { messageOf } from '../connect/EmailConnect.js';
import { CHANNEL_NAMES, ChannelGlyph, Chevron, Spinner } from '../connect/parts.js';
import { ProjectCard } from './ProjectCard.js';
import './YourCallum.css';

export interface YourCallumProps {
  state: AppState;
  /** Fetches the app state again after something was saved. */
  refresh(): Promise<void>;
  onBack?: () => void;
  /** Opens the Take a break or wrap up sheet. */
  onLeave?: () => void;
  onAddPeople?: (projectId: number) => void;
  /** Starts a download. The browser follows the link; tests replace this. */
  download?: (url: string) => void;
  now?: () => Date;
  pollMs?: number;
}

function browserDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function Row({ id, title, summary, open, onToggle, children }: { id: string; title: string; summary: ReactNode; open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <section className="yc-row" data-row={id}>
      <button type="button" className="yc-rowhead" onClick={onToggle} aria-expanded={open}>
        <span className="yc-row-title">{title}</span>{' '}
        <span className="yc-row-summary">{summary}</span>
        <span className="yc-chev" data-open={open}><Chevron /></span>
      </button>
      {open ? <div className="yc-open fade-in">{children}</div> : null}
    </section>
  );
}

function Switch({ title, sub, on, onToggle }: { title: string; sub: string; on: boolean; onToggle(): void }) {
  return (
    <div className="yc-tap">
      <span className="yc-tap-text"><span className="yc-tap-title">{title}</span><span className="yc-tap-sub">{sub}</span></span>
      <button type="button" role="switch" aria-checked={on} aria-label={title} className="yc-switch" onClick={onToggle}><span className="yc-knob" aria-hidden="true" /></button>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The sentence under a Disconnect: what waits until the channel is connected again. */
export function disconnectText(ch: Channel, summary: ChannelSummary | undefined, sharedBy: string | null): string {
  const name = ch === 'email' ? 'email' : CHANNEL_NAMES[ch];
  const p = summary?.pending ?? { invites: 0, followUps: 0, emails: 0, messages: 0 };
  const parts: string[] = [];
  if (p.invites) parts.push(plural(p.invites, 'invite', 'invites'));
  if (p.followUps) parts.push(plural(p.followUps, 'follow-up', 'follow-ups'));
  if (p.emails) parts.push(plural(p.emails, 'email', 'emails'));
  if (p.messages) parts.push(plural(p.messages, 'message', 'messages'));
  const total = p.invites + p.followUps + p.emails + p.messages;
  const where = sharedBy ? `, in ${sharedBy}` : '';
  const head = `Disconnect ${name}? `;
  const body = total === 0 ? 'Nobody is waiting on it.' : `${joinNames(parts)} ${total === 1 ? 'waits' : 'wait'} until you connect again${where}.`;
  return ch === 'email' ? `${head}${body} Replies still reach your inbox.` : `${head}${body}`;
}

function statusOf(a: ChannelAccount | undefined): 'off' | 'on' | 'paused' | 'error' {
  if (!a || a.status === 'disconnected') return 'off';
  return a.status === 'connected' ? 'on' : a.status;
}

export function YourCallum({ state, refresh, onBack, onLeave, onAddPeople, download = browserDownload, now = () => new Date(), pollMs }: YourCallumProps) {
  const toast = useToast();
  const headingRef = useHeadingFocus();
  const { settings } = state;
  const current = pickCurrentProject(state);
  const [open, setOpen] = useState<Record<string, boolean>>({ projects: true });
  const [openProject, setOpenProject] = useState<number | null>(current?.id ?? null);
  const [nameDraft, setNameDraft] = useState(settings.senderName ?? '');
  const [nameError, setNameError] = useState('');
  const [taps, setTaps] = useState({ notifications: settings.notifications === true, morningBrief: settings.morningBrief });
  const [summaries, setSummaries] = useState<Partial<Record<Channel, ChannelSummary>>>({});
  const [confirming, setConfirming] = useState<Channel | null>(null);
  const [busy, setBusy] = useState<Channel | null>(null);
  const [sheet, setSheet] = useState<{ channel: Channel; reconnect: boolean } | null>(null);
  const [channelError, setChannelError] = useState('');
  const [openAtLogin, setOpenAtLogin] = useState(settings.openAtLogin === true);
  const [msSetup, setMsSetup] = useState<MicrosoftSetup | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientIdMsg, setClientIdMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [claudeKey, setClaudeKey] = useState('');
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [claudeMsg, setClaudeMsg] = useState('');

  const desktop = typeof window !== 'undefined' ? window.callumDesktop : undefined;
  const toggleRow = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  useEffect(() => setTaps({ notifications: settings.notifications === true, morningBrief: settings.morningBrief }), [settings.notifications, settings.morningBrief]);
  useEffect(() => setOpenAtLogin(settings.openAtLogin === true), [settings.openAtLogin]);

  const accounts = useMemo(() => {
    const out: Partial<Record<Channel, ChannelAccount>> = {};
    for (const a of state.channels) out[a.channel] = a;
    return out;
  }, [state.channels]);

  const liveProjects = state.projects.filter((p) => p.state !== 'wrapped');
  const wrapped = state.projects.filter((p) => p.state === 'wrapped');
  const sharedBy = liveProjects.length < 2 ? null : liveProjects.length === 2 ? 'both projects' : `all ${liveProjects.length} projects`;

  // How fast each channel sends and what waits on it, asked again whenever any of that could have changed.
  const stamp = [
    ...CHANNELS.map((ch) => `${accounts[ch]?.status}:${accounts[ch]?.identity}:${accounts[ch]?.halfPaceUntil}`),
    state.outbox.length,
    liveProjects.length,
  ].join('|');
  useEffect(() => {
    let live = true;
    for (const ch of CHANNELS) {
      api
        .channelSummary(ch)
        .then((s) => live && setSummaries((all) => ({ ...all, [ch]: s })))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [stamp]);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    channelSetup
      .microsoft()
      .then((s) => live && setMsSetup(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [desktop]);

  const emailAddress = accounts.email?.status === 'connected' ? accounts.email.identity : null;
  const sender = emailAddress ?? settings.senderEmail;
  const connectedNames = CHANNELS.filter((ch) => accounts[ch]?.status === 'connected').map((ch) => (ch === 'email' ? 'email' : CHANNEL_NAMES[ch]));

  const saveName = async () => {
    const value = nameDraft.trim();
    if (value === (settings.senderName ?? '')) return;
    setNameError('');
    try {
      await api.settings({ senderName: value });
      await refresh();
    } catch (e) {
      setNameError(messageOf(e));
    }
  };

  const setTap = async (key: 'notifications' | 'morningBrief') => {
    const next = !taps[key];
    setTaps((t) => ({ ...t, [key]: next }));
    try {
      await api.settings({ [key]: next });
      await refresh();
    } catch (e) {
      setTaps((t) => ({ ...t, [key]: !next }));
      toast(messageOf(e));
    }
  };

  const toggleOpenAtLogin = async () => {
    if (!desktop) return;
    const next = !openAtLogin;
    setOpenAtLogin(next);
    try {
      // The computer has the last word: it answers with what it now does.
      setOpenAtLogin(await desktop.setOpenAtLogin(next));
      await refresh();
    } catch (e) {
      setOpenAtLogin(!next);
      toast(messageOf(e));
    }
  };

  const disconnect = async (ch: Channel) => {
    setBusy(ch);
    setChannelError('');
    try {
      await api.disconnect(ch);
      setConfirming(null);
      toast(`${CHANNEL_NAMES[ch]} is disconnected. Everyone there waits${sharedBy ? `, in ${sharedBy}` : ''}.`);
      await refresh();
    } catch (e) {
      setChannelError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const saveClientId = async () => {
    setClientIdMsg(null);
    try {
      setMsSetup(await channelSetup.saveMicrosoftClientId(clientId));
      setClientId('');
      setClientIdMsg({ text: 'Saved. Microsoft sign-in is ready.', bad: false });
    } catch (e) {
      setClientIdMsg({ text: messageOf(e), bad: true });
    }
  };

  const saveClaudeKey = async () => {
    setClaudeMsg('');
    setClaudeBusy(true);
    try {
      await claudeKeyApi.save(claudeKey.trim());
      setClaudeKey('');
      await refresh();
      toast('Callum will write with Claude');
    } catch (e) {
      setClaudeMsg(messageOf(e));
    } finally {
      setClaudeBusy(false);
    }
  };

  const removeClaudeKey = async () => {
    setClaudeMsg('');
    setClaudeBusy(true);
    try {
      await claudeKeyApi.remove();
      await refresh();
      toast('Callum is back to its own templates');
    } catch (e) {
      setClaudeMsg(messageOf(e));
    } finally {
      setClaudeBusy(false);
    }
  };

  const connectedAll = useCallback(async (account: ChannelAccount | undefined, ch: Channel) => {
    toast(`${CHANNEL_NAMES[ch]} is connected${account?.identity ? ` as ${account.identity}` : ''}`);
    await refresh();
  }, [refresh, toast]);

  const subline =
    connectedNames.length === 0
      ? 'Nothing is connected, so nobody hears from Callum'
      : liveProjects.length >= 2
        ? `${liveProjects.length === 2 ? 'Two' : liveProjects.length} projects, sharing ${joinNames(connectedNames)}`
        : `${liveProjects.length === 1 ? 'One project, using' : 'Running on'} ${joinNames(connectedNames)}`;

  const tapsSummary =
    taps.notifications && taps.morningBrief ? 'Replies, and a brief at 8:30'
    : taps.notifications ? 'Replies only'
    : taps.morningBrief ? 'A brief at 8:30 only'
    : 'None. Replies wait here';

  const status = settings.pauseState === 'paused' ? 'Paused' : settings.pauseState === 'wrapped' ? 'Wrapped up' : 'Running';
  const projectsSummary = liveProjects.map((p) => p.name).join(', ') || 'None running';
  const peopleOf = (p: Project) => state.people.filter((x) => x.projectId === p.id);
  const nowDate = now();

  return (
    <main className="yc-root" data-screen="your-callum">
      <header className="yc-bar">
        <Wordmark />
        <div className="yc-bar-right">
          <span className="yc-chip"><span className="yc-dot" data-state={settings.pauseState === 'running' ? 'on' : 'off'} aria-hidden="true" />{status}</span>
          {onBack ? <button type="button" className="yc-back" onClick={onBack}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>Back to the river</button> : null}
        </div>
      </header>

      <div className="yc-wrap">
        <div className="yc-head">
          <span className="yc-avatar" aria-hidden="true" style={{ background: marbleBackground(7) }} />
          <div>
            <h1 ref={headingRef} tabIndex={-1} className="yc-title">Your Callum</h1>
            <p className="yc-subline">{subline}</p>
          </div>
        </div>

        <div className="yc-cols">
          <div className="yc-col yc-col-rows">
            <Row id="you" title="You" summary={`${settings.senderName || 'You'}, ${sender ? `sending as ${sender}` : 'email is not connected yet'}`} open={Boolean(open.you)} onToggle={() => toggleRow('you')}>
              <label htmlFor="yc-name" className="yc-label">Your first name, as people see it</label>
              <input
                id="yc-name"
                className="yc-input"
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              {nameError ? <p className="yc-alert" role="alert"><span className="yc-alert-dot" aria-hidden="true" />{nameError}</p> : null}
              <span className="yc-aside">
                <ChannelGlyph channel="email" size={16} />
                {sender ? `Emails go out from ${sender}${liveProjects.length > 1 ? ', in every project' : ''}` : 'Connect email to send from your own address'}
              </span>
            </Row>

            <Row id="projects" title="Projects" summary={projectsSummary} open={Boolean(open.projects)} onToggle={() => toggleRow('projects')}>
              <div className="yc-projects">
                {liveProjects.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    others={state.projects.filter((o) => o.id !== p.id)}
                    othersLive={liveProjects.filter((o) => o.id !== p.id).length}
                    people={peopleOf(p)}
                    outbox={state.outbox}
                    timezone={settings.timezone}
                    now={nowDate}
                    open={openProject === p.id}
                    onToggle={() => setOpenProject((id) => (id === p.id ? null : p.id))}
                    onChanged={refresh}
                    onWrapped={() => setOpenProject(liveProjects.find((o) => o.id !== p.id)?.id ?? null)}
                    {...(onAddPeople ? { onAddPeople } : {})}
                    download={download}
                  />
                ))}
                {wrapped.length > 0 ? (
                  <div className="yc-wrapped">
                    <h3 className="yc-wrapped-title">Wrapped</h3>
                    {wrapped.map((p) => (
                      <div key={p.id} className="yc-wrapped-row">
                        <span className="yc-wrapped-name">{p.name}</span>
                        <button type="button" className="yc-pill" aria-label={`Download ${p.name}`} onClick={() => download(api.exportCsvUrl(p.id))}>Download</button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </Row>
          </div>

          <div className="yc-col">
            <section className="yc-channels" aria-labelledby="yc-ch-title">
              <div className="yc-ch-head">
                <h2 id="yc-ch-title" className="yc-h2">Where Callum reaches people</h2>
                {sharedBy ? <span className="yc-aside">Shared by every project</span> : null}
              </div>
              <div className="yc-ch-list">
                {CHANNELS.map((ch) => {
                  const account = accounts[ch];
                  const st = statusOf(account);
                  const summary = summaries[ch];
                  const working = busy === ch;
                  const accountText = st === 'off' ? 'Not connected' : st === 'error' ? 'Sign in again' : st === 'paused' ? 'Paused' : (account?.identity ?? 'Connected');
                  const pace = st === 'off' ? `Nobody hears from Callum here${sharedBy ? ', in any project' : ''}.` : summary?.paceLine ? `${summary.paceLine}.` : '';
                  return (
                    <div key={ch} className="yc-ch" data-channel={ch}>
                      <div className="yc-ch-main">
                        <span className="yc-disc" data-off={st === 'off'} aria-hidden="true">
                          <ChannelGlyph channel={ch} size={20} />
                          {working ? <svg className="yc-disc-spin" viewBox="0 0 56 56"><circle cx="28" cy="28" r="26" fill="none" stroke="#3F52D9" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="40 200" /></svg> : null}
                        </span>
                        <span className="yc-ch-text">
                          <span className="yc-ch-name">
                            {CHANNEL_NAMES[ch]}
                            <span className="yc-status-dot" data-state={st} aria-hidden="true" />
                            <span className="yc-ch-account">{accountText}</span>
                          </span>
                          <span className="yc-ch-pace">{pace}</span>
                        </span>
                        {confirming === ch ? null : (
                          <span className="yc-ch-buttons">
                            {st === 'off' ? (
                              <button type="button" className="yc-pill" aria-label={`Connect ${CHANNEL_NAMES[ch]}`} onClick={() => setSheet({ channel: ch, reconnect: false })}>Connect</button>
                            ) : (
                              <>
                                <button type="button" className="yc-pill" aria-label={`Reconnect ${CHANNEL_NAMES[ch]}`} onClick={() => setSheet({ channel: ch, reconnect: true })}>Reconnect</button>
                                <button type="button" className="yc-pill" aria-label={`Disconnect ${CHANNEL_NAMES[ch]}`} onClick={() => { setChannelError(''); setConfirming(ch); }}>Disconnect</button>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      {confirming === ch ? (
                        <div className="yc-confirm yc-confirm-inline fade-in">
                          <span>{disconnectText(ch, summary, sharedBy)}</span>
                          <span className="yc-confirm-actions">
                            <button type="button" className="yc-pill" onClick={() => setConfirming(null)}>Keep it</button>
                            <button type="button" className="yc-solid" disabled={working} aria-busy={working} onClick={() => void disconnect(ch)}>{working ? <Spinner light /> : null}Disconnect</button>
                          </span>
                        </div>
                      ) : null}
                      {confirming === ch && channelError ? <p className="yc-alert" role="alert"><span className="yc-alert-dot" aria-hidden="true" />{channelError}</p> : null}
                      {ch === 'email' && desktop ? (
                        <details className="yc-setup">
                          <summary>Microsoft setup</summary>
                          <div className="yc-setup-body">
                            <p className="yc-aside">
                              {msSetup?.configured
                                ? msSetup.source === 'env' ? 'The app is set up from the CALLUM_MICROSOFT_CLIENT_ID setting.' : 'The app is set up. Paste a new ID to change it.'
                                : 'Microsoft needs a one-time app setup on this computer first. Paste the application (client) ID of the app you registered.'}
                            </p>
                            <div className="yc-inline">
                              <input className="yc-input" type="text" aria-label="Application (client) ID" value={clientId} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
                              <button type="button" className="yc-solid" disabled={!clientId.trim()} onClick={() => void saveClientId()}>Save</button>
                            </div>
                            {clientIdMsg ? (
                              <p className={clientIdMsg.bad ? 'yc-alert' : 'yc-hint'} role={clientIdMsg.bad ? 'alert' : 'status'}>{clientIdMsg.text}</p>
                            ) : null}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="yc-col-rows">
              <Row id="when" title="When Callum sends" summary="Weekdays, 9:00 to 17:00 their time" open={Boolean(open.when)} onToggle={() => toggleRow('when')}>
                <div className="yc-week" aria-hidden="true">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => (
                    <div key={d} className="yc-day" data-work={i < 5}>
                      <span className="yc-day-bar"><span /></span>
                      <span className="yc-day-name">{d}</span>
                    </div>
                  ))}
                </div>
                <p className="yc-aside">Messages land when people read them, in each person's own time zone. Callum never sends at night or on weekends.</p>
              </Row>

              <Row id="taps" title="Taps" summary={tapsSummary} open={Boolean(open.taps)} onToggle={() => toggleRow('taps')}>
                <Switch
                  title="When someone replies"
                  sub={taps.notifications ? `A tap the moment a person writes back${liveProjects.length > 1 ? ', from any project' : ''}` : 'Replies wait for you here'}
                  on={taps.notifications}
                  onToggle={() => void setTap('notifications')}
                />
                <Switch
                  title="Morning brief at 8:30"
                  sub={taps.morningBrief ? `Who wants to talk${liveProjects.length > 1 ? ', across every project' : ', in one line'}` : 'No morning brief'}
                  on={taps.morningBrief}
                  onToggle={() => void setTap('morningBrief')}
                />
              </Row>

              <Row id="claude" title="Claude key" summary={state.claudeConnected ? 'Connected' : 'Not connected'} open={Boolean(open.claude)} onToggle={() => toggleRow('claude')}>
                <p className="yc-aside">Callum writes hellos with Claude when a key is here. Without one it uses its own templates.</p>
                {state.claudeConnected ? (
                  <div className="yc-inline">
                    <span className="yc-hint" role="status">Connected</span>
                    <button type="button" className="yc-pill" disabled={claudeBusy} aria-busy={claudeBusy} onClick={() => void removeClaudeKey()}>Remove</button>
                  </div>
                ) : (
                  <form className="yc-inline" onSubmit={(e) => { e.preventDefault(); if (claudeKey.trim() && !claudeBusy) void saveClaudeKey(); }}>
                    <input className="yc-input" type="password" aria-label="Claude API key" value={claudeKey} placeholder="sk-ant-..." spellCheck={false} autoComplete="off" onChange={(e) => setClaudeKey(e.target.value)} />
                    <button type="submit" className="yc-solid" disabled={!claudeKey.trim() || claudeBusy} aria-busy={claudeBusy}>{claudeBusy ? <Spinner light /> : null}Save</button>
                  </form>
                )}
                {claudeMsg ? <p className="yc-alert" role="alert"><span className="yc-alert-dot" aria-hidden="true" />{claudeMsg}</p> : null}
              </Row>

              {desktop ? (
                <Row id="computer" title="This computer" summary={openAtLogin ? 'Opens when your computer starts' : 'Opens when you open it'} open={Boolean(open.computer)} onToggle={() => toggleRow('computer')}>
                  <Switch
                    title="Open Callum when your computer starts"
                    sub={openAtLogin ? 'Callum is ready before you sit down' : 'Callum waits until you open it'}
                    on={openAtLogin}
                    onToggle={() => void toggleOpenAtLogin()}
                  />
                </Row>
              ) : null}

              <section className="yc-row yc-data" data-row="data">
                <div className="yc-rowhead yc-data-head">
                  <span className="yc-row-title">Your data</span>
                  <span className="yc-data-actions">
                    <button type="button" className="yc-pill" onClick={() => download(api.exportJsonUrl())}>Download everything</button>
                    {onLeave ? <button type="button" className="yc-pill" onClick={onLeave}>Take a break or wrap up</button> : null}
                  </span>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>

      {sheet ? (
        <ConnectSheet
          channel={sheet.channel}
          reconnect={sheet.reconnect}
          accounts={accounts}
          onConnected={connectedAll}
          onClose={() => setSheet(null)}
          {...(pollMs === undefined ? {} : { pollMs })}
        />
      ) : null}
    </main>
  );
}
