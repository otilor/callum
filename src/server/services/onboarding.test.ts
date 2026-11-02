import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from './projects.js';
import { planPreview, sample, start, suggestOffer } from './onboarding.js';
import { harness } from './testing.test-helpers.js';

const site = vi.hoisted(() => ({ text: '' }));
vi.mock('../leads/site.js', async (importActual) => ({
  ...(await importActual<typeof import('../leads/site.js')>()),
  fetchSiteText: vi.fn(async () => site.text),
}));

beforeEach(() => {
  site.text = '';
});

describe('suggestOffer', () => {
  it('reads the company site behind a work email', async () => {
    const h = harness();
    h.ctx.repo.updateSettings({ senderEmail: 'ada@fieldnote.com' });
    site.text = 'We help fintech teams close their books in two days. Book a demo.';
    expect(await suggestOffer(h.ctx)).toBe('You help fintech teams close their books in two days.');
  });

  it('gives nothing for free mail, no address, or a site that says nothing usable', async () => {
    const h = harness();
    h.ctx.repo.updateSettings({ senderEmail: 'ada@gmail.com' });
    site.text = 'We help fintech teams close their books.';
    expect(await suggestOffer(h.ctx)).toBeNull();
    h.ctx.repo.updateSettings({ senderEmail: null });
    expect(await suggestOffer(h.ctx)).toBeNull();
    h.ctx.repo.updateSettings({ senderEmail: 'ada@fieldnote.com' });
    site.text = '';
    expect(await suggestOffer(h.ctx)).toBeNull();
    site.text = 'Welcome to our home page';
    expect(await suggestOffer(h.ctx)).toBeNull();
  });
});

describe('sample', () => {
  it('writes the hello for the first stranger in the tone asked for', async () => {
    const h = harness();
    h.person({ name: 'Tunde Ade', company: 'Fieldnote' });
    const warm = await sample(h.ctx, h.project.id, 'warm');
    const direct = await sample(h.ctx, h.project.id, 'direct');
    expect(warm).toContain('Tunde');
    expect(warm).toContain('Fieldnote');
    expect(direct).toContain('Tunde');
    expect(direct).not.toBe(warm);
    expect(warm).not.toContain('!');
  });

  it('uses Kemi Eze at Oko Pay when nobody is there yet, and never saves anything', async () => {
    const h = harness();
    const body = await sample(h.ctx, h.project.id, 'playful');
    expect(body).toContain('Kemi');
    expect(body).toContain('Oko Pay');
    expect(h.ctx.repo.listPeople()).toEqual([]);
    expect(h.ctx.repo.getProject(h.project.id)?.tone).toBe('warm');
  });

  it('writes an invite when the first stranger is on LinkedIn', async () => {
    const h = harness({ connected: ['linkedin'] });
    h.person({ name: 'Tunde Ade', email: null, linkedinUrl: 'https://www.linkedin.com/in/tunde' });
    expect((await sample(h.ctx, h.project.id, 'warm')).length).toBeLessThanOrEqual(280);
  });
});

describe('planPreview', () => {
  it('counts the first day by channel inside the daily limits', () => {
    const h = harness();
    h.strangers(12);
    const preview = planPreview(h.ctx, h.project.id);
    expect(preview.line).toBe('Tomorrow from 9:00 their time: 12 hellos, 12 by email. Nothing goes out today.');
    expect(preview).toMatchObject({ firstSendAt: '2026-11-03T08:00:00.000Z', total: 12, byChannel: { email: 12, linkedin: 0, x: 0 } });
  });

  it('lists two and three channels naturally', () => {
    const h = harness({ connected: ['email', 'linkedin', 'x'] });
    h.strangers(8);
    for (let i = 0; i < 4; i++) h.person({ email: null, linkedinUrl: `https://www.linkedin.com/in/l${i}` });
    expect(planPreview(h.ctx, h.project.id).line).toBe('Tomorrow from 9:00 their time: 12 hellos, 8 by email and 4 on LinkedIn. Nothing goes out today.');
    for (let i = 0; i < 2; i++) h.person({ email: null, xHandle: `x${i}` });
    expect(planPreview(h.ctx, h.project.id).line).toBe('Tomorrow from 9:00 their time: 14 hellos, 8 by email, 4 on LinkedIn and 2 on X. Nothing goes out today.');
  });

  it('stops at the email limit for the first week', () => {
    const h = harness();
    h.strangers(25);
    const preview = planPreview(h.ctx, h.project.id);
    expect(preview.total).toBe(20);
    expect(preview.line).toContain('20 hellos, 20 by email');
  });

  it('stops at 15 invites on LinkedIn', () => {
    const h = harness({ connected: ['linkedin'] });
    for (let i = 0; i < 18; i++) h.person({ email: null, linkedinUrl: `https://www.linkedin.com/in/l${i}` });
    expect(planPreview(h.ctx, h.project.id).byChannel.linkedin).toBe(15);
  });

  it('says Monday when tomorrow is a weekend, and says a single hello in the singular', () => {
    const h = harness({ now: '2026-11-06T10:00:00.000Z' });
    h.person();
    expect(planPreview(h.ctx, h.project.id)).toMatchObject({
      firstSendAt: '2026-11-09T08:00:00.000Z',
      line: 'Monday from 9:00 their time: 1 hello, 1 by email. Nothing goes out today.',
    });
  });

  it('does not count people Callum cannot reach, or people who already heard from it', () => {
    const h = harness();
    h.person();
    h.person({ email: null, linkedinUrl: 'https://www.linkedin.com/in/nope' });
    h.person({ stage: 'hello', touches: 1 });
    expect(planPreview(h.ctx, h.project.id).total).toBe(1);
  });

  it('has nothing to promise when nobody is ready', () => {
    const h = harness();
    expect(planPreview(h.ctx, h.project.id)).toMatchObject({ total: 0, line: 'Nobody is ready for a first hello yet. Nothing goes out today.' });
  });
});

describe('start', () => {
  it('needs a connected channel', async () => {
    const h = harness({ connected: [] });
    h.person();
    await expect(start(h.ctx, h.project.id)).rejects.toMatchObject({ name: 'UserError', message: 'Connect a channel first' });
  });

  it('needs at least one person in that project', async () => {
    const h = harness();
    const other = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    h.person();
    await expect(start(h.ctx, other.id)).rejects.toMatchObject({ message: 'Add some people first' });
  });

  it('queues the first 10 hellos for the OK, to go out Tuesday at 9:00 in Lagos', async () => {
    const h = harness();
    const people = h.strangers(12);
    const res = await start(h.ctx, h.project.id);
    expect(res).toEqual({ firstSendAt: '2026-11-03T08:00:00.000Z' });

    const items = h.ctx.repo.listOutbox();
    expect(items).toHaveLength(10);
    expect(items.every((i) => i.state === 'awaiting_ok' && i.kind === 'hello' && i.origin === 'auto')).toBe(true);
    expect(items.every((i) => i.sendAfter === '2026-11-03T08:00:00.000Z')).toBe(true);
    expect(items.map((i) => i.personId)).toEqual(people.slice(0, 10).map((p) => p.id));

    const project = h.ctx.repo.getProject(h.project.id);
    expect(project).toMatchObject({ startedAt: '2026-11-02T10:00:00.000Z', approvalsLeft: 10, state: 'running' });
    expect(h.ctx.repo.getSettings()).toMatchObject({ onboarded: true, pauseState: 'running', currentProjectId: h.project.id });
    for (const p of h.ctx.repo.listPeople()) {
      expect(p.channel).toBe('email');
      expect(p.nextTouchAt).toBe('2026-11-03T08:00:00.000Z');
    }
    expect(h.scopes).toEqual(expect.arrayContaining(['projects', 'settings', 'people', 'outbox']));
    expect(planPreview(h.ctx, h.project.id).line).toBe('Tomorrow from 9:00 their time: 12 hellos, 12 by email. Nothing goes out today.');
  });

  it('removes people it cannot reach on any connected channel', async () => {
    const h = harness();
    const reachable = h.person();
    const stuck = h.person({ email: null, linkedinUrl: 'https://www.linkedin.com/in/stuck' });
    await start(h.ctx, h.project.id);
    expect(h.ctx.repo.getPerson(stuck.id)?.status).toBe('removed');
    expect(h.ctx.repo.getPerson(reachable.id)?.status).toBe('active');
    expect(h.ctx.repo.listOutbox().map((i) => i.personId)).toEqual([reachable.id]);
  });

  it('writes an invite for a LinkedIn person and uses each person\'s own time zone', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const lon = h.person({ timezone: 'Europe/London' });
    const li = h.person({ email: null, linkedinUrl: 'https://www.linkedin.com/in/tunde' });
    await start(h.ctx, h.project.id);
    expect(h.ctx.repo.getPerson(lon.id)?.nextTouchAt).toBe('2026-11-03T09:00:00.000Z');
    const invite = h.ctx.repo.listOutbox({ personId: li.id })[0];
    expect(invite).toMatchObject({ kind: 'invite', channel: 'linkedin', state: 'awaiting_ok' });
    expect(invite?.body.length).toBeLessThanOrEqual(280);
  });

  it('starts the second project without touching the first', async () => {
    const h = harness();
    h.strangers(3);
    await start(h.ctx, h.project.id);
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    h.person({ projectId: second.id });
    await start(h.ctx, second.id);
    expect(h.ctx.repo.listOutbox()).toHaveLength(4);
    expect(h.ctx.repo.getProject(second.id)?.approvalsLeft).toBe(10);
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(10);
  });

  it('keeps a break the user took, and refuses to start twice or a wrapped project', async () => {
    const h = harness();
    h.person();
    h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' });
    await start(h.ctx, h.project.id);
    expect(h.ctx.repo.getSettings().pauseState).toBe('paused');
    await expect(start(h.ctx, h.project.id)).rejects.toThrow('Reconciliation has already started.');
    h.ctx.repo.updateProject(h.project.id, { state: 'wrapped', startedAt: null });
    await expect(start(h.ctx, h.project.id)).rejects.toThrow('Reconciliation is wrapped up.');
  });

  it('queues a hello even when the offer is blank (the runner refuses to send a blank at send time)', async () => {
    const h = harness({ offer: null });
    h.person();
    await start(h.ctx, h.project.id);
    const [item] = h.ctx.repo.listOutbox();
    expect(item?.state).toBe('awaiting_ok');
  });
});
