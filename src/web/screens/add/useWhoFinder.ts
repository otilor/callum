import { useCallback, useMemo, useRef, useState } from 'react';
import type { Described, PreviewPerson, SkipGroup } from '../../../shared/types.js';
import { ApiError, peopleApi } from '../../api.js';
import { useToast } from '../../ui/Toast.js';

export type Way = 'csv' | 'paste' | 'link' | 'describe';
export type Phase = 'idle' | 'reading' | 'preview' | 'nosource' | 'narrow' | 'looking' | 'nobody';

/** The people a list, a paste, a search link or a description brought up, waiting for the user's yes. */
export interface Found {
  batchId: string;
  people: PreviewPerson[];
  groups: SkipGroup[];
  /** Found by description: Apollo has not been asked to look anyone up yet, and that is what costs credits. */
  apollo: boolean;
  /** What to call them in the title: `new people`, `people from the search`, `close fits`. */
  word: string;
}

export const LINKEDIN_PEOPLE_SEARCH = /linkedin\.com\/search\/results\/people/i;
export const SAMPLE_SEARCH = 'https://www.linkedin.com/search/results/people/?keywords=fintech%20founder';

export function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

function readBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The people in a file, before the server has read it: the lines under the header. */
function rowsIn(buf: ArrayBuffer): number {
  const lines = new TextDecoder().decode(buf).split(/\r?\n/).filter((l) => l.trim() !== '');
  return Math.max(0, lines.length - 1);
}

const isNoApollo = (detail: unknown): boolean => typeof detail === 'object' && detail !== null && (detail as { code?: unknown }).code === 'no_apollo';

export interface WhoFinder {
  way: Way;
  setWay(way: Way): void;
  phase: Phase;
  found: Found | null;
  /** The people still in the batch: everyone found except those the user said were not a fit. */
  kept: PreviewPerson[];
  dropped: string[];
  peek: PreviewPerson | null;
  togglePeek(key: string): void;
  notFit(key: string): PreviewPerson | null;
  error: string;
  /** Back to the empty way, as if nothing had been read. */
  reset(): void;
  /** Reads the same thing again for a fresh batch, keeping who was left out. Used after Undo. */
  rerun(): Promise<void>;

  fileName: string;
  readTotal: number;
  chooseFile(file: File | undefined): void;

  pasteText: string;
  setPasteText(text: string): void;
  readPaste(): void;

  linkText: string;
  setLinkText(text: string): void;
  linkBad: boolean;
  readLink(sample?: string): void;

  descText: string;
  setDescText(text: string): void;
  look(query?: string): void;
  narrow: { described: Described; selected: string[] } | null;
  toggleNarrow(chip: string): void;
  findClosest(): void;
  nobodyLine: string;
  /** The key box under "Describing people needs a people search connected". */
  apollo: { open: boolean; key: string; busy: boolean };
  openApollo(): void;
  setApolloKey(key: string): void;
  connectApollo(): void;
}

/**
 * Everything the four ways of adding people have in common: what the user gave, what the server made of it, and who
 * was left out. `projectId` is the project they join, or null while the project is still being set up.
 */
export function useWhoFinder(projectId: number | null, opts: { initialWay?: Way } = {}): WhoFinder {
  const toast = useToast();
  const [way, setWayState] = useState<Way>(opts.initialWay ?? 'csv');
  const [phase, setPhase] = useState<Phase>('idle');
  const [found, setFound] = useState<Found | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [fileName, setFileName] = useState('');
  const [readTotal, setReadTotal] = useState(0);
  const [pasteText, setPasteText] = useState('');
  const [linkText, setLinkText] = useState('');
  const [linkBad, setLinkBad] = useState(false);
  const [descText, setDescText] = useState('');
  const [narrow, setNarrow] = useState<{ described: Described; selected: string[] } | null>(null);
  const [nobodyLine, setNobodyLine] = useState('');
  const [apolloOpen, setApolloOpen] = useState(false);
  const [apolloKey, setApolloKey] = useState('');
  const [apolloBusy, setApolloBusy] = useState(false);

  // An answer that arrives after the person moved on is ignored.
  const ticket = useRef(0);
  const last = useRef<(() => Promise<void>) | null>(null);

  const clear = useCallback(() => {
    ticket.current++;
    setFound(null);
    setNarrow(null);
    setDropped([]);
    setPeekKey(null);
    setError('');
    setLinkBad(false);
    setPhase('idle');
  }, []);

  const setWay = useCallback((next: Way) => {
    clear();
    setWayState(next);
  }, [clear]);

  /** Runs a request that brings up a batch of people. */
  const bring = useCallback(async (request: () => Promise<{ batchId: string; people: PreviewPerson[]; groups: SkipGroup[] }>, word: string, nextPhase: Phase = 'reading') => {
    const mine = ++ticket.current;
    setError('');
    setPhase(nextPhase);
    try {
      const res = await request();
      if (mine !== ticket.current) return;
      setFound({ batchId: res.batchId, people: res.people, groups: res.groups, apollo: false, word });
      setPhase('preview');
    } catch (e) {
      if (mine !== ticket.current) return;
      setError(messageOf(e));
      setPhase('idle');
    }
  }, []);

  const fresh = useCallback((run: () => Promise<void>) => {
    last.current = run;
    setDropped([]);
    setPeekKey(null);
    setFound(null);
    return run();
  }, []);

  const chooseFile = useCallback((file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setReadTotal(0);
    setError('');
    setPhase('reading');
    const mine = ++ticket.current;
    void readBuffer(file).then(
      (buf) => {
        if (mine !== ticket.current) return;
        setReadTotal(rowsIn(buf));
        const csvBase64 = toBase64(buf);
        void fresh(() => bring(async () => {
          const res = await peopleApi.preview({ csvBase64, projectId });
          return { batchId: res.batchId, people: res.added, groups: res.groups };
        }, 'new people'));
      },
      () => {
        if (mine !== ticket.current) return;
        setError("Callum couldn't read that file. Try saving it as a CSV again.");
        setPhase('idle');
      },
    );
  }, [bring, fresh, projectId]);

  const readPaste = useCallback(() => {
    const text = pasteText.trim();
    if (!text) return;
    void fresh(() => bring(async () => {
      const res = await peopleApi.preview({ paste: text, projectId });
      return { batchId: res.batchId, people: res.added, groups: res.groups };
    }, 'new people'));
  }, [bring, fresh, pasteText, projectId]);

  const readLink = useCallback((sample?: string) => {
    const text = (sample ?? linkText).trim();
    if (sample) setLinkText(sample);
    if (!LINKEDIN_PEOPLE_SEARCH.test(text)) {
      setLinkBad(true);
      return;
    }
    setLinkBad(false);
    const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    void fresh(() => bring(async () => {
      const res = await peopleApi.preview({ linkedinSearchUrl: url, projectId });
      return { batchId: res.batchId, people: res.added, groups: res.groups };
    }, 'people from the search'));
  }, [bring, fresh, linkText, projectId]);

  const lookFor = useCallback(async (query: string, filters: string[], keepRows = false) => {
    const mine = ++ticket.current;
    setError('');
    setPhase('looking');
    try {
      const d = await peopleApi.describe({ query, filters, projectId });
      if (mine !== ticket.current) return;
      if (!d.batchId || d.people.length === 0) {
        setNobodyLine(d.line);
        setPhase('nobody');
      } else if (d.narrow && filters.length === 0 && !keepRows) {
        setNarrow({ described: d, selected: [] });
        setPhase('narrow');
      } else {
        setFound({ batchId: d.batchId, people: d.people, groups: [], apollo: true, word: 'close fits' });
        setPhase('preview');
      }
    } catch (e) {
      if (mine !== ticket.current) return;
      if (e instanceof ApiError && isNoApollo(e.detail)) {
        setPhase('nosource');
        return;
      }
      setError(messageOf(e));
      setPhase('idle');
    }
  }, [projectId]);

  const look = useCallback((query?: string) => {
    const text = (query ?? descText).trim();
    if (!text) {
      setError('Describe them in a few words first.');
      return;
    }
    setDescText(text);
    setNarrow(null);
    void fresh(() => lookFor(text, []));
  }, [descText, fresh, lookFor]);

  const toggleNarrow = useCallback((chip: string) => {
    setNarrow((n) => (n ? { ...n, selected: n.selected.includes(chip) ? n.selected.filter((c) => c !== chip) : [...n.selected, chip] } : n));
  }, []);

  const findClosest = useCallback(() => {
    if (!narrow) return;
    const d = narrow.described;
    if (narrow.selected.length === 0 && d.batchId) {
      last.current = () => lookFor(descText.trim(), [], true);
      setFound({ batchId: d.batchId, people: d.people, groups: [], apollo: true, word: 'close fits' });
      setNarrow(null);
      setPhase('preview');
      return;
    }
    const filters = narrow.selected;
    void fresh(() => lookFor(descText.trim(), filters));
  }, [descText, fresh, lookFor, narrow]);

  const connectApollo = useCallback(() => {
    if (apolloBusy) return;
    setApolloBusy(true);
    setError('');
    peopleApi.connectApollo(apolloKey).then(
      () => {
        setApolloBusy(false);
        setApolloOpen(false);
        setApolloKey('');
        toast('Apollo is connected. Callum can look for people now.');
        look();
      },
      (e: unknown) => {
        setApolloBusy(false);
        setError(messageOf(e));
      },
    );
  }, [apolloBusy, apolloKey, look, toast]);

  const reset = useCallback(() => {
    clear();
    last.current = null;
    setFileName('');
    setPasteText('');
    setLinkText('');
    setDescText('');
  }, [clear]);

  const rerun = useCallback(async () => {
    const again = last.current;
    if (!again) return;
    setFound(null);
    await again();
  }, []);

  const kept = useMemo(() => (found ? found.people.filter((p) => !dropped.includes(p.key)) : []), [found, dropped]);
  const peek = useMemo(() => (found && peekKey !== null ? (kept.find((p) => p.key === peekKey) ?? null) : null), [found, kept, peekKey]);

  const notFit = useCallback((key: string): PreviewPerson | null => {
    const person = found?.people.find((p) => p.key === key) ?? null;
    if (!person) return null;
    setDropped((d) => (d.includes(key) ? d : [...d, key]));
    setPeekKey(null);
    return person;
  }, [found]);

  return {
    way, setWay, phase, found, kept, dropped, peek,
    togglePeek: (key) => setPeekKey((k) => (k === key ? null : key)),
    notFit, error, reset, rerun,
    fileName, readTotal, chooseFile,
    pasteText, setPasteText, readPaste,
    linkText, setLinkText: (text) => { setLinkText(text); setLinkBad(false); }, linkBad, readLink,
    descText, setDescText, look, narrow, toggleNarrow, findClosest, nobodyLine,
    apollo: { open: apolloOpen, key: apolloKey, busy: apolloBusy },
    openApollo: () => setApolloOpen(true), setApolloKey, connectApollo,
  };
}
