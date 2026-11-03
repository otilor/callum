import { describe, expect, it } from 'vitest';
import { updateProject, wrapProject } from '../services/projects.js';
import { askForOffer, offerSaysEnough } from './offer.js';
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
