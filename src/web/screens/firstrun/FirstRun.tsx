import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Channel, ChannelAccount, Person, Project } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { suggestProjectName } from '../../ui/format.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { pickCurrentProject } from '../../useAppState.js';
import { Channels } from './Channels.js';
import { EmailSheet } from './EmailSheet.js';
import './FirstRun.css';
import { ConnectedSheet, LinkedinSheet, XSheet } from './OtherSheets.js';
import { Offer } from './Offer.js';
import { Plan } from './Plan.js';
import { RiverStrip } from './RiverStrip.js';
import { Tone, useToneStore } from './Tone.js';
import { Welcome } from './Welcome.js';
import { Who } from './Who.js';

type Step = 0 | 1 | 2 | 3 | 4 | 5;
type Sheet = { kind: 'email'; provider: 'google' | 'microsoft' } | { kind: 'linkedin' } | { kind: 'x' } | { kind: 'connected'; channel: Channel };

export interface FirstRunProps {
  state: AppState;
  refresh(): Promise<void>;
  /** The clock; only the wording of "tomorrow" depends on it. */
  now?: () => Date;
  /** How often to ask Microsoft whether the code was entered. */
  pollMs?: number;
}

function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

function domainOf(address: string | null | undefined): string | null {
  const domain = address?.split('@')[1]?.trim().toLowerCase();
  return domain || null;
}

export function FirstRun({ state, refresh, now = () => new Date(), pollMs }: FirstRunProps) {
  const existing = useMemo(() => pickCurrentProject(state), [state]);

  const [step, setStep] = useState<Step>(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [local, setLocal] = useState<Partial<Record<Channel, ChannelAccount>>>({});
  const [busy, setBusy] = useState<Channel | null>(null);
  const [ringing, setRinging] = useState<{ channel: Channel; key: number } | null>(null);

  const [project, setProject] = useState<Project | null>(existing);
  const [offer, setOffer] = useState(existing?.offer ?? '');
  const [offerTouched, setOfferTouched] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [offerError, setOfferError] = useState('');
  const [nameProblem, setNameProblem] = useState('');
  const [offerBusy, setOfferBusy] = useState(false);

  const [people, setPeople] = useState<Person[]>(() => (existing ? state.people.filter((p) => p.projectId === existing.id) : []));
  const [audience, setAudience] = useState<string | null>(null);
  const tone = useToneStore(existing?.tone ?? 'warm');
  const [toneError, setToneError] = useState('');
  const [toneBusy, setToneBusy] = useState(false);
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const ringKey = useRef(0);

  // Once the server's state shows what a sign-in just did, the local copy has done its job.
  useEffect(() => {
    setLocal((l) => {
      const keep: Partial<Record<Channel, ChannelAccount>> = {};
      let changed = false;
      for (const ch of Object.keys(l) as Channel[]) {
        const mine = l[ch];
        const theirs = state.channels.find((a) => a.channel === ch);
        if (mine && theirs && theirs.status === mine.status && theirs.identity === mine.identity) changed = true;
        else if (mine) keep[ch] = mine;
      }
      return changed ? keep : l;
    });
  }, [state.channels]);

  const accounts = useMemo(() => {
    const merged: Partial<Record<Channel, ChannelAccount>> = {};
    for (const a of state.channels) merged[a.channel] = a;
    return { ...merged, ...local };
  }, [state.channels, local]);

  // ---- channels ----------------------------------------------------------------------------------------

  const connected = useCallback(
    async (account: ChannelAccount | undefined, channel: Channel) => {
      if (account) setLocal((l) => ({ ...l, [channel]: account }));
      ringKey.current += 1;
      setRinging({ channel, key: ringKey.current });
      setSheet(null);
      await refresh();
    },
    [refresh],
  );

  const connect = useCallback(
    async (channel: Channel, fields: Record<string, string>) => {
      setBusy(channel);
      try {
        const account = await api.connect(channel, fields);
        await connected(account, channel);
      } finally {
        setBusy(null);
      }
    },
    [connected],
  );

  const pick = (channel: Channel) => {
    if (accounts[channel]?.status === 'connected') return setSheet({ kind: 'connected', channel });
    setSheet(channel === 'email' ? { kind: 'email', provider: 'google' } : { kind: channel });
  };

  const welcome = (provider: 'google' | 'microsoft') => {
    setStep(1);
    if (accounts.email?.status !== 'connected') setSheet({ kind: 'email', provider });
  };

  const disconnect = async (channel: Channel) => {
    const account = await api.disconnect(channel);
    setLocal((l) => ({ ...l, [channel]: account }));
    setSheet(null);
    await refresh();
  };

  // ---- offer and project -------------------------------------------------------------------------------

  const mailDomain = domainOf(accounts.email?.identity) ?? domainOf(state.settings.senderEmail);

  const suggestAsked = useRef(false);
  useEffect(() => {
    if (step !== 2 || project || offerTouched || offer || suggestAsked.current) return;
    suggestAsked.current = true;
    setReading(true);
    api
      .suggestOffer()
      .then((res) => {
        setSuggested(res.offer ?? '');
        if (res.offer) setOffer((o) => o || (res.offer ?? ''));
      })
      .catch(() => {
        // Callum could not read the site; the field stays empty for the person to write.
        setSuggested('');
      })
      .finally(() => setReading(false));
  }, [step, project, offerTouched, offer]);

  const name = nameOverride ?? (project && offer.trim() === (project.offer ?? '') ? project.name : suggestProjectName(offer));
  const readFrom = suggested && offer === suggested && mailDomain ? mailDomain : null;

  const submitOffer = async () => {
    const text = offer.trim();
    if (!text) return setOfferError('Say what you offer in one line.');
    setOfferError('');
    setNameProblem('');
    setOfferBusy(true);
    try {
      // The project is called what the page shows, so there is never a second name Callum picked behind the person's back.
      let saved: Project;
      if (!project) {
        saved = await api.createProject({ offer: text, ...(name ? { name } : {}) });
      } else {
        const patch: { offer?: string; name?: string } = {};
        if (text !== (project.offer ?? '')) patch.offer = text;
        if (name && name !== project.name) patch.name = name;
        saved = Object.keys(patch).length > 0 ? await api.updateProject(project.id, patch) : project;
      }
      setProject(saved);
      setNameOverride(null);
      setStep(3);
      void refresh();
    } catch (e) {
      // A refused name (a duplicate) is shown beside the pencil, everything else under the offer.
      if (e instanceof ApiError && e.status === 422 && name) setNameProblem(e.message);
      else setOfferError(messageOf(e));
    } finally {
      setOfferBusy(false);
    }
  };

  // ---- who ---------------------------------------------------------------------------------------------

  const addPeople = useCallback((added: Person[]) => setPeople((all) => [...all, ...added]), []);
  const dropPerson = useCallback((id: number) => setPeople((all) => all.filter((p) => p.id !== id)), []);

  const leaveWho = (said: string | null) => {
    if (said) setAudience(said);
    setStep(4);
  };

  // ---- tone --------------------------------------------------------------------------------------------

  const submitTone = async () => {
    if (!project) return;
    setToneError('');
    setToneBusy(true);
    try {
      const patch: { tone: typeof tone.tone; sample: string | null; audience?: string } = { tone: tone.tone, sample: tone.drafts[tone.tone]?.trim() ? (tone.drafts[tone.tone] ?? null) : null };
      if (audience) patch.audience = audience;
      setProject(await api.updateProject(project.id, patch));
      setStep(5);
    } catch (e) {
      setToneError(messageOf(e));
    } finally {
      setToneBusy(false);
    }
  };

  // ---- plan --------------------------------------------------------------------------------------------

  const start = async () => {
    if (!project) return;
    setStartError('');
    setStarting(true);
    try {
      await api.start(project.id);
      await refresh();
    } catch (e) {
      setStartError(messageOf(e));
      setStarting(false);
    }
  };

  const first = people[0];
  const firstChannel = (['email', 'linkedin', 'x'] as const).find((ch) => accounts[ch]?.status === 'connected') ?? 'email';
  const sheetNode = !sheet ? null : sheet.kind === 'email' ? (
    <EmailSheet
      provider={sheet.provider}
      onClose={() => setSheet(null)}
      onConnect={(fields) => connect('email', fields)}
      onConnected={(account) => void connected(account, 'email')}
      {...(pollMs === undefined ? {} : { pollMs })}
    />
  ) : sheet.kind === 'linkedin' ? (
    <LinkedinSheet onClose={() => setSheet(null)} onConnect={(fields) => connect('linkedin', fields)} />
  ) : sheet.kind === 'x' ? (
    <XSheet onClose={() => setSheet(null)} onConnect={(fields) => connect('x', fields)} />
  ) : accounts[sheet.channel] ? (
    <ConnectedSheet account={accounts[sheet.channel] as ChannelAccount} onClose={() => setSheet(null)} onDisconnect={() => disconnect(sheet.channel)} />
  ) : null;

  return (
    <div className="fr-root" data-screen="first-run">
      <header className="fr-header">
        <Wordmark project={project?.name ?? null} />
        {step > 0 ? (
          <div className="fr-dots">
            {[1, 2, 3, 4, 5].map((n) => (
              <span key={n} className="fr-dot" aria-hidden="true" data-state={n === step ? 'now' : n < step ? 'done' : 'next'} />
            ))}
            <span className="sr-only">{`${step} of 5`}</span>
          </div>
        ) : null}
      </header>

      <main className="fr-main">
        {step === 0 ? <Welcome onContinue={welcome} /> : null}
        {step === 1 ? <Channels accounts={accounts} busy={busy} ringing={ringing} onPick={pick} onNext={() => setStep(2)} /> : null}
        {step === 2 ? (
          <Offer
            offer={offer}
            onOffer={(text) => {
              setOffer(text);
              setOfferTouched(true);
              setOfferError('');
            }}
            readFrom={readFrom}
            reading={reading}
            name={name}
            onRename={(n) => {
              setNameOverride(n);
              setNameProblem('');
            }}
            error={offerError}
            nameProblem={nameProblem}
            busy={offerBusy}
            onBack={() => setStep(1)}
            onNext={() => void submitOffer()}
          />
        ) : null}
        {step === 3 && project ? (
          <Who projectId={project.id} people={people} onAdded={addPeople} onRemoved={dropPerson} onBack={() => setStep(2)} onNext={leaveWho} />
        ) : null}
        {step === 4 && project && first ? (
          <Tone projectId={project.id} first={first} channel={firstChannel} store={tone} error={toneError} busy={toneBusy} onBack={() => setStep(3)} onNext={() => void submitTone()} />
        ) : null}
        {step === 5 && project ? (
          <Plan
            projectId={project.id}
            people={people}
            timezone={state.settings.timezone}
            now={now()}
            error={startError}
            starting={starting}
            onBack={() => setStep(4)}
            onStart={() => void start()}
          />
        ) : null}
      </main>

      <RiverStrip people={people} planning={step === 5} />
      {sheetNode}
    </div>
  );
}
