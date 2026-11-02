import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { marbleBackground } from '../../ui/Marble.js';
import './SignIn.css';

export const WRONG_PASSWORD = "That's not the password. Ask whoever set up this Callum, or check CALLUM_PASSWORD on the server.";
export const PAUSED = "That's 5 wrong tries, so sign-in is paused for a minute. Nothing else changed.";
const BROKEN = 'Something went wrong. Callum kept everything as it was.';

export interface SignInProps {
  /** `starting` while the first fetch is pending; `locked` once the server answered 401. */
  mode: 'starting' | 'locked';
  /** Fetches the app state again; the app swaps this screen out once it is allowed in. */
  refresh(): Promise<void>;
  /** How long "Callum is waking up" shows before the app appears. */
  wakeMs?: number;
}

// The river behind the card: four groups of faces, grey while Callum sleeps and in colour once it wakes.
const GROUPS = [
  { n: 8, x0: 5, x1: 26, size: 20, ring: '#D5D9E4', filter: 'grayscale(1) brightness(1.12)', op: 0.62 },
  { n: 8, x0: 29, x1: 50, size: 24, ring: '#A9B8F5', filter: 'grayscale(0.62)', op: 0.9 },
  { n: 6, x0: 53, x1: 72, size: 28, ring: '#6E86F2', filter: 'grayscale(0.28)', op: 1 },
  { n: 4, x0: 76, x1: 93, size: 34, ring: '#3F52D9', filter: 'none', op: 1 },
];

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

interface Face { id: number; x: number; y: number; size: number; ring: string; filter: string; op: number }

function makeFaces(): Face[] {
  const faces: Face[] = [];
  let id = 0;
  for (const g of GROUPS) {
    const cols = Math.ceil(g.n / 2);
    const cw = (g.x1 - g.x0) / cols;
    for (let k = 0; k < g.n; k++) {
      const col = Math.floor(k / 2);
      const row = k % 2;
      const x = g.x0 + (col + 0.5) * cw + (hash(id * 3.1 + 1) - 0.5) * cw * 0.4;
      const y = 0.42 + row * 0.24 + (col % 2) * 0.06 + (hash(id * 5.7 + 2) - 0.5) * 0.05;
      faces.push({ id, x, y, size: g.size, ring: g.ring, filter: g.filter, op: g.op });
      id += 1;
    }
  }
  return faces;
}

function River({ awake }: { awake: boolean }) {
  const faces = useMemo(makeFaces, []);
  return (
    <div className="si-river" aria-hidden="true">
      <svg viewBox="0 0 1000 300" preserveAspectRatio="none">
        <defs>
          <linearGradient id="si-bed" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#EEF0F6" stopOpacity="0" />
            <stop offset="0.07" stopColor="#EEF0F6" />
            <stop offset="0.5" stopColor="#ECEFFB" />
            <stop offset="0.82" stopColor="#FFF4DD" />
            <stop offset="1" stopColor="#FFEBC2" />
          </linearGradient>
          <linearGradient id="si-grey" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#F2F3F7" stopOpacity="0" />
            <stop offset="0.07" stopColor="#F2F3F7" />
            <stop offset="1" stopColor="#F2F3F7" />
          </linearGradient>
        </defs>
        <path d="M0 120 C 220 90, 420 170, 640 130 S 900 100, 1000 118 L1000 210 C 860 232, 700 190, 520 214 S 200 236, 0 204 Z" fill="url(#si-grey)" />
        <path className="si-tint" style={{ opacity: awake ? 1 : 0 }} d="M0 120 C 220 90, 420 170, 640 130 S 900 100, 1000 118 L1000 210 C 860 232, 700 190, 520 214 S 200 236, 0 204 Z" fill="url(#si-bed)" />
      </svg>
      {faces.map((f) => (
        <span
          key={f.id}
          className="si-face"
          style={{
            left: `${f.x.toFixed(2)}%`,
            top: `${(f.y * 100).toFixed(1)}%`,
            width: f.size,
            height: f.size,
            margin: `-${f.size / 2}px 0 0 -${f.size / 2}px`,
            background: marbleBackground(300 + f.id),
            filter: awake ? f.filter : 'grayscale(1) brightness(1.1)',
            opacity: awake ? f.op : 0.35,
            boxShadow: `0 0 0 1.5px ${awake ? f.ring : '#E7E9F0'}`,
            transitionDelay: awake ? `${f.id * 45}ms` : '0ms',
            animationDelay: `${f.id * 30}ms`,
          }}
        />
      ))}
    </div>
  );
}

const Eye = ({ off }: { off: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#646B85" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {off ? (
      <path d="M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.3 6.9A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.2-1" />
    ) : (
      <>
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="3" />
      </>
    )}
  </svg>
);

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The password gate: starting, locked, then waking up. */
export function SignIn({ mode, refresh, wakeMs }: SignInProps) {
  const [phase, setPhase] = useState<'locked' | 'waking'>('locked');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The lockout counts down live, from a deadline, so a busy tab cannot make it run slow.
  const cool = until > now ? Math.ceil((until - now) / 1000) : 0;
  const locked = until > 0;
  useEffect(() => {
    if (!locked) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= until) {
        setUntil(0);
        setError('');
        field.current?.focus();
      }
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [locked, until]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (checking || cool > 0 || phase !== 'locked') return;
    if (!password) {
      setError('Type the password first.');
      setShake((n) => n + 1);
      return;
    }
    setChecking(true);
    setError('');
    try {
      await api.login(password);
    } catch (err) {
      if (!alive.current) return;
      setChecking(false);
      setShake((n) => n + 1);
      if (err instanceof ApiError && err.status === 429) {
        const t = Date.now();
        setNow(t);
        setUntil(t + Math.max(1, err.retryAfter ?? 60) * 1000);
        // The button the person pressed is now disabled; keep them in the field.
        field.current?.focus();
        setError(PAUSED);
      } else if (err instanceof ApiError && err.status === 401) {
        setError(WRONG_PASSWORD);
      } else {
        setError(err instanceof ApiError ? err.message : BROKEN);
      }
      return;
    }
    if (!alive.current) return;
    setChecking(false);
    setPhase('waking');
    const wait = wakeMs ?? (reducedMotion() ? 0 : 1600);
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (alive.current) await refresh();
  };

  const awake = phase === 'waking';
  const status = awake ? 'Waking up' : mode === 'starting' ? 'Starting' : 'Locked';

  return (
    <main className="si-root" data-screen="sign-in" data-awake={awake}>
      <header className="si-bar">
        <Wordmark />
        <span className="si-status"><span className="si-dot" data-state={awake ? 'on' : mode === 'starting' ? 'starting' : 'off'} aria-hidden="true" />{status}</span>
      </header>

      <div className="si-main">
        {mode === 'starting' ? (
          <section className="si-wait fade-in" aria-live="polite">
            <span className="si-pulses" aria-hidden="true"><span /><span /><span /></span>
            <h1 className="si-title">Callum is starting</h1>
            <p className="si-sub">The server just came back. This takes a few seconds, and nothing was sent while it was down.</p>
          </section>
        ) : awake ? (
          <section className="si-wait fade-in" aria-live="polite">
            <span className="si-sun" aria-hidden="true" />
            <h1 className="si-title">Callum is waking up</h1>
            <p className="si-sub">Picking up where it left off</p>
          </section>
        ) : (
          <form className="si-card step-in" onSubmit={(e) => void submit(e)} aria-labelledby="si-title">
            <span className="si-lock" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="11" width="14" height="9" rx="2.5" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              <span className="si-sun si-sun-small" />
            </span>
            <div className="si-copy">
              <h1 id="si-title" className="si-title">This Callum is private</h1>
              <p className="si-sub">Enter the password you set when you installed it.</p>
            </div>
            <div className="si-fields" data-shake={error ? (shake % 2 ? 'a' : 'b') : 'off'}>
              <div className="si-pw">
                <label htmlFor="si-password" className="sr-only">Password</label>
                <input
                  id="si-password"
                  className="si-input"
                  type={show ? 'text' : 'password'}
                  value={password}
                  ref={field}
                  readOnly={cool > 0}
                  aria-invalid={error && cool === 0 ? true : undefined}
                  autoComplete="current-password"
                  autoFocus
                  placeholder="Password"
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (cool === 0) setError('');
                  }}
                />
                <button type="button" className="si-eye" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={() => setShow((s) => !s)}>
                  <Eye off={!show} />
                </button>
              </div>
              <button type="submit" className="si-go" disabled={checking || cool > 0 || password.length === 0} aria-busy={checking}>
                {checking ? (
                  <svg className="si-spin" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                    <circle cx="9" cy="9" r="7" fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="2.4" />
                    <path d="M9 2a7 7 0 0 1 7 7" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                ) : null}
                {checking ? 'Checking' : cool > 0 ? `Try again in ${cool} s` : 'Sign in'}
              </button>
            </div>
            {error ? (
              <p className="si-error fade-in" role="alert">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D9480F" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7.5v5.5M12 16.6v.01" />
                </svg>
                <span>{error}</span>
              </p>
            ) : null}
          </form>
        )}
      </div>

      <River awake={awake} />
    </main>
  );
}
