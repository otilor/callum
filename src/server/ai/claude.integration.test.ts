import { describe, expect, it } from 'vitest';
import { systemClock } from '../engine/clock.js';
import { ClaudeWriter } from './claude.js';
import { outbound, testCtx } from './testing.test-helpers.js';
import { TemplateWriter } from './templates.js';
import { DEFAULT_MODEL } from './writer.js';

// Real calls to the Claude API: runs only when ANTHROPIC_API_KEY is set.
const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.CALLUM_MODEL || DEFAULT_MODEL;

describe.skipIf(!key)('ClaudeWriter against the real API', () => {
  const writer = () => new ClaudeWriter(key ?? '', model, new TemplateWriter(systemClock), undefined, systemClock);

  it('write: a hello that reads like a person wrote it', async () => {
    const w = writer();
    const out = await w.write('hello', testCtx());
    expect(w.lastError).toBeNull(); // a null here means Claude answered, not the template fallback
    expect(out.subject).toBe('Quick question, Kemi');
    expect(out.body).toContain('Kemi');
    expect(out.body).not.toContain('!');
    expect(out.body.split(/\s+/).length).toBeLessThan(120);
    expect(out.body).not.toMatch(/\{[^}]*\}/);
  }, 90_000);

  it('classify: reads a referral reply', async () => {
    const w = writer();
    const out = await w.classify('Not me, I am afraid. You should talk to Sam Bello (sam@okopay.com), she runs finance.', testCtx({ history: [outbound()] }));
    expect(w.lastError).toBeNull();
    expect(out.kind).toBe('referral');
    expect(out.referral?.name).toBe('Sam Bello');
    expect(out.referral?.email).toBe('sam@okopay.com');
    expect(out.language).toBe('en');
  }, 90_000);

  it('offerLine: one second-person sentence from site text', async () => {
    const w = writer();
    const line = await w.offerLine('Oko Pay. We help fintech teams reconcile payments across banks and wallets in minutes, not days. Book a demo.', 'okopay.com');
    expect(w.lastError).toBeNull();
    expect(line).toMatch(/^You help /);
    expect(line).not.toContain('!');
  }, 90_000);

  it('parseAsk: turns an instruction into an intent', async () => {
    const w = writer();
    const out = await w.parseAsk('switch Nneka and Temi to email', [{ id: 1, name: 'Kemi Eze' }, { id: 2, name: 'Nneka Obi' }, { id: 3, name: 'Temi Alade' }]);
    expect(w.lastError).toBeNull();
    expect(out).toEqual({ intent: 'switch', personIds: [2, 3], channel: 'email' });
  }, 90_000);

  it('projectName: a short name for what is offered', async () => {
    const w = writer();
    const name = await w.projectName('You help growing teams in Lagos and Accra run payroll without spreadsheets.');
    expect(w.lastError).toBeNull();
    expect(name.split(' ').length).toBeLessThanOrEqual(3);
    expect(name.toLowerCase()).toContain('payroll');
  }, 90_000);
});
