import { describe, expect, it } from 'vitest';
import { readEnv } from './env.js';

describe('readEnv', () => {
  it('has sensible defaults and stays on this computer', () => {
    expect(readEnv({})).toEqual({
      port: 4600, host: '127.0.0.1', dataDir: './data', demo: false, password: null,
      anthropicKey: null, model: 'claude-opus-5-5', apolloKey: null, timezone: null,
    });
  });

  it('reads every variable', () => {
    const env = readEnv({
      PORT: '8080', CALLUM_DATA_DIR: '/var/callum', CALLUM_DEMO: 'true', CALLUM_PASSWORD: 'open sesame',
      ANTHROPIC_API_KEY: 'sk-x', CALLUM_MODEL: 'claude-sonnet-5-5', APOLLO_API_KEY: 'ap', TZ_DEFAULT: 'Africa/Lagos',
    });
    expect(env).toEqual({
      port: 8080, host: '0.0.0.0', dataDir: '/var/callum', demo: true, password: 'open sesame',
      anthropicKey: 'sk-x', model: 'claude-sonnet-5-5', apolloKey: 'ap', timezone: 'Africa/Lagos',
    });
  });

  it('opens to the network only when there is a password', () => {
    expect(readEnv({ CALLUM_PASSWORD: '  ' }).host).toBe('127.0.0.1');
    expect(readEnv({ CALLUM_PASSWORD: 'x' }).host).toBe('0.0.0.0');
  });

  it('takes 1 and true as demo, nothing else', () => {
    expect(readEnv({ CALLUM_DEMO: '1' }).demo).toBe(true);
    expect(readEnv({ CALLUM_DEMO: 'TRUE' }).demo).toBe(true);
    expect(readEnv({ CALLUM_DEMO: '0' }).demo).toBe(false);
    expect(readEnv({ CALLUM_DEMO: 'yes' }).demo).toBe(false);
  });

  it('falls back to 4600 for a port that is not one', () => {
    expect(readEnv({ PORT: 'abc' }).port).toBe(4600);
    expect(readEnv({ PORT: '70000' }).port).toBe(4600);
    expect(readEnv({ PORT: '0' }).port).toBe(0);
  });
});
