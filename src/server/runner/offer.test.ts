import { describe, expect, it } from 'vitest';
import { updateProject, wrapProject } from '../services/projects.js';
import { askForOffer, offerSaysEnough, offerWithSite } from './offer.js';
import { Runner } from './runner.js';
import { ctxWith, harness, NOW } from './testing.test-helpers.js';

describe('offerSaysEnough', () => {
  it('wants a few words about what the user does, not a link, a name or a blank', () => {
    for (const bad of [null, '', '   ', 'tethers.com', 'https://tethers.com/about', 'Tethers', 'Tethers, tethers.com', '[WHAT YOU OFFER]', 'I help [WHO]']) {
      expect(offerSaysEnough(bad)).toBe(false);
    }
    for (const good of ['I help YC founders find their first enterprise customers', 'Payroll for small teams', 'We build payroll software (tethers.com)']) {
      expect(offerSaysEnough(good)).toBe(true);
    }
  });
});

describe('asking for what the user offers', () => {
  const HELLO_DUE = { touches: 0, stage: 'stranger' as const, nextTouchAt: NOW };

  it('passes on the question Claude asked, once however many people are due, and writes once told', async () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { approvalsLeft: 0 });
    h.person({ ...HELLO_DUE });
    h.person({ ...HELLO_DUE });
    let offerKnown = false;
    const ctx = ctxWith(h, {
      write: async () => (offerKnown ? { subject: 'Hello', body: 'Hi, I help YC founders find enterprise customers. Worth a chat?' } : { subject: 'Hello', body: '', missing: 'What does Tethers do for YC founders?' }),
    });
    const runner = new Runner(ctx, { spacing: false });
    await runner.tick();
    await runner.tick();
    const asks = h.ctx.repo.listIncidents({ open: true });
    expect(asks).toHaveLength(1);
    expect(JSON.parse(asks[0]?.detail ?? '{}')).toEqual({ projectId: h.project.id, question: 'What does Tethers do for YC founders?' });
    expect(h.ctx.repo.listOutbox()).toEqual([]);
    expect(h.adapters.email.sent).toEqual([]);

    offerKnown = true;
    updateProject(h.ctx, h.project.id, { offer: 'I help YC founders find their first enterprise customers' });
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
    await runner.tick();
    expect(h.adapters.email.sent.map((m) => m.body.split('\n')[0])).toEqual([
      'Hi, I help YC founders find enterprise customers. Worth a chat?',
      'Hi, I help YC founders find enterprise customers. Worth a chat?',
    ]);
  });

  it('keeps the ask when the line saved still says too little, and settles it when the project is wrapped up', () => {
    const h = harness();
    askForOffer(h.ctx, h.project);
    updateProject(h.ctx, h.project.id, { offer: 'tethers.com' });
    expect(h.ctx.repo.listIncidents({ open: true })).toHaveLength(1);
    wrapProject(h.ctx, h.project.id);
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
  });
});

describe('offerWithSite', () => {
  const page = 'We help YC founders close their first enterprise deals. Tethers pairs you with buyers.';

  it('reads the website the user gave and says what the company does, keeping what they typed', async () => {
    const h = harness();
    const asked: string[] = [];
    const read = async (d: string) => { asked.push(d); return page; };
    expect(await offerWithSite(h.ctx, 'tethers.com', read)).toBe('You help YC founders close their first enterprise deals. (tethers.com)');
    expect(await offerWithSite(h.ctx, 'https://www.tethers.com/about', read)).toBe('You help YC founders close their first enterprise deals. (https://www.tethers.com/about)');
    expect(await offerWithSite(h.ctx, 'YC founders at tethers.com', read)).toBe('You help YC founders close their first enterprise deals. (YC founders at tethers.com)');
    expect(asked).toEqual(['tethers.com', 'tethers.com', 'tethers.com']);
    expect(offerSaysEnough('You help YC founders close their first enterprise deals. (tethers.com)')).toBe(true);
  });

  it('leaves the words alone when they already say enough, have no site, or the site says nothing useful', async () => {
    const h = harness();
    let reads = 0;
    const read = async () => { reads++; return page; };
    const long = 'I help YC founders close their first enterprise deals through warm intros, see tethers.com';
    expect(await offerWithSite(h.ctx, long, read)).toBe(long);
    expect(await offerWithSite(h.ctx, 'Payroll for small teams', read)).toBe('Payroll for small teams');
    expect(await offerWithSite(h.ctx, 'write to gabriel@tethers.com', read)).toBe('write to gabriel@tethers.com');
    expect(reads).toBe(0);
    expect(await offerWithSite(h.ctx, 'tethers.com', async () => '')).toBe('tethers.com');
    expect(await offerWithSite(h.ctx, 'tethers.com', async () => 'Welcome. Sign in.')).toBe('tethers.com');
    expect(await offerWithSite(h.ctx, 'tethers.com', async () => { throw new Error('offline'); })).toBe('tethers.com');
  });
});
