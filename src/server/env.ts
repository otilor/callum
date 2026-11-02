export interface Env {
  port: number;
  host: string;
  dataDir: string;
  demo: boolean;
  password: string | null;
  anthropicKey: string | null;
  model: string;
  apolloKey: string | null;
  timezone: string | null;
  /** Behind a reverse proxy that sets X-Forwarded-For: the sign-in lockout counts the address the proxy saw. */
  trustProxy: boolean;
}

export const DEFAULT_PORT = 4600;
export const DEFAULT_MODEL = 'claude-opus-5-5';

const clean = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

function readPort(v: string | undefined): number {
  const t = clean(v);
  if (t === null || !/^\d+$/.test(t)) return DEFAULT_PORT;
  const n = Number(t);
  return n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/** The settings Callum starts with, from environment variables. */
export function readEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const password = clean(e.CALLUM_PASSWORD);
  const demo = ['1', 'true'].includes((e.CALLUM_DEMO ?? '').trim().toLowerCase());
  return {
    port: readPort(e.PORT),
    // With a password Callum is meant to be reached from other machines; without one it stays on this computer.
    host: password ? '0.0.0.0' : '127.0.0.1',
    dataDir: clean(e.CALLUM_DATA_DIR) ?? './data',
    demo,
    password,
    anthropicKey: clean(e.ANTHROPIC_API_KEY),
    model: clean(e.CALLUM_MODEL) ?? DEFAULT_MODEL,
    apolloKey: clean(e.APOLLO_API_KEY),
    timezone: clean(e.TZ_DEFAULT),
    trustProxy: clean(e.CALLUM_TRUST_PROXY) === '1',
  };
}
