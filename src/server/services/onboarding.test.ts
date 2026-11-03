import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importPeople } from '../leads/import.js';
import { planProjectNow } from '../runner/runner.js';
import { createProject, updateProject } from './projects.js';
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
    const { body: warm, to } = await sample(h.ctx, h.project.id, 'warm');
    const { body: direct } = await sample(h.ctx, h.project.id, 'direct');
    expect(to).toEqual({ name: 'Tunde Ade', company: 'Fieldnote' });
    expect(warm).toContain('Tunde');
    expect(warm).toContain('Fieldnote');
    expect(direct).toContain('Tunde');
    expect(direct).not.toBe(warm);
    expect(warm).not.toContain('!');
  });

  it('uses Kemi Eze at Oko Pay when nobody is there yet, and never saves anything', async () => {
    const h = harness();
    const { body, to } = await sample(h.ctx, h.project.id, 'playful');
    expect(to).toEqual({ name: 'Kemi Eze', company: 'Oko Pay' });
    expect(body).toContain('Kemi');
    expect(body).toContain('Oko Pay');
    expect(h.ctx.repo.listPeople()).toEqual([]);
    expect(h.ctx.repo.getProject(h.project.id)?.tone).toBe('warm');
  });

  it('writes an invite when the first stranger is on LinkedIn', async () => {
    const h = harness({ connected: ['linkedin'] });
    h.person({ name: 'Tunde Ade', email: null, linkedinUrl: 'https://www.linkedin.com/in/tunde' });
    expect((await sample(h.ctx, h.project.id, 'warm')).body.length).toBeLessThanOrEqual(280);
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

  it('never removes people it cannot reach yet: they wait, and are planned once their channel is connected', async () => {
    const h = harness();
    const reachable = h.person();
    const stuck = h.person({ name: 'Tunde Ade', email: null, linkedinUrl: 'https://www.linkedin.com/in/stuck' });
    expect(planPreview(h.ctx, h.project.id).waiting).toEqual({ count: 1, line: '1 person waits for LinkedIn. Connect it to reach them.' });
    await start(h.ctx, h.project.id);
    expect(h.ctx.repo.getPerson(stuck.id)).toMatchObject({ status: 'active', channel: null });
    expect(h.ctx.repo.getPerson(reachable.id)?.status).toBe('active');
    expect(h.ctx.repo.listOutbox().map((i) => i.personId)).toEqual([reachable.id]);

    // Re-importing the same person adds nobody, and the person is still there and still active.
    const again = importPeople(h.ctx.repo, h.project.id, [{ name: 'Tunde Ade', source: 'csv', linkedinUrl: 'https://www.linkedin.com/in/stuck' }]);
    expect(again.added).toEqual([]);
    expect(h.ctx.repo.listPeople()).toHaveLength(2);

    // LinkedIn gets connected. The next planning gives the person a channel, and their invite is queued at its slot.
    h.ctx.repo.updateChannel('linkedin', { status: 'connected', connectedAt: '2026-11-02T08:00:00.000Z' });
    await planProjectNow(h.ctx, h.project.id);
    expect(h.ctx.repo.getPerson(stuck.id)).toMatchObject({ status: 'active', channel: 'linkedin' });
    h.clock.set('2026-11-03T08:30:00.000Z');
    await planProjectNow(h.ctx, h.project.id);
    expect(h.ctx.repo.listOutbox({ personId: stuck.id })).toMatchObject([{ kind: 'invite', channel: 'linkedin', state: 'awaiting_ok' }]);
  });

  it('says which channels the waiting people need', () => {
    const h = harness();
    h.person({ email: null, linkedinUrl: 'https://www.linkedin.com/in/a' });
    h.person({ email: null, xHandle: 'someone' });
    h.person();
    expect(planPreview(h.ctx, h.project.id).waiting).toEqual({ count: 2, line: '2 people wait for LinkedIn or X. Connect one to reach them.' });
    h.ctx.repo.updateChannel('linkedin', { status: 'connected' });
    expect(planPreview(h.ctx, h.project.id).waiting).toEqual({ count: 1, line: '1 person waits for X. Connect it to reach them.' });
    h.ctx.repo.updateChannel('x', { status: 'connected' });
    expect(planPreview(h.ctx, h.project.id).waiting).toEqual({ count: 0, line: null });
  });

  it('does not offer the limits another project has already taken that day', async () => {
    const h = harness();
    const other = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const firstDay = new Date('2026-11-03T08:00:00.000Z');
    for (let i = 0; i < 15; i++) {
      const p = h.person({ projectId: other.id, channel: 'email' });
      h.ctx.outbox.queueAuto(p.id, 'hello', 'Hi', 'Hello', firstDay, i % 2 === 0);
    }
    // Yesterday's leftovers and a user reply do not count.
    const old = h.person({ projectId: other.id, channel: 'email' });
    h.ctx.outbox.queueAuto(old.id, 'hello', 'Hi', 'Hello', new Date('2026-11-02T12:00:00.000Z'), false);
    h.strangers(12);
    const preview = planPreview(h.ctx, h.project.id);
    expect(preview.byChannel.email).toBe(5);
    expect(preview.line).toBe('Tomorrow from 9:00 their time: 5 hellos, 5 by email. Nothing goes out today.');
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
    h.ctx.repo.updateProject(h.project.id, { startedAt: null });
    h.ctx.repo.updateProject(h.project.id, { state: 'wrapped', startedAt: null });
    await expect(start(h.ctx, h.project.id)).rejects.toThrow('Reconciliation is wrapped up.');
  });

  it('writes no hello until it knows what the user offers, asks for it once, and writes once told', async () => {
    for (const offer of [null, 'tethers.com', 'https://tethers.com', '[WHAT YOU OFFER]']) {
      const h = harness({ offer });
      h.person();
      await start(h.ctx, h.project.id);
      await planProjectNow(h.ctx, h.project.id, { early: true });
      expect(h.ctx.repo.listOutbox()).toEqual([]);
      const asks = h.ctx.repo.listIncidents({ open: true });
      expect(asks).toMatchObject([{ kind: 'needs_offer' }]);
      expect(asks[0]?.message).toBe(`Callum won't write to anyone in ${h.project.name} until it can say what you do. Nothing has been sent.`);
      expect(JSON.parse(asks[0]?.detail ?? '{}')).toEqual({ projectId: h.project.id, question: `What does ${h.project.name} do, and for whom, in one line?` });

      updateProject(h.ctx, h.project.id, { offer: 'I help YC founders find their first enterprise customers' });
      expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
      await planProjectNow(h.ctx, h.project.id, { early: true });
      const [item] = h.ctx.repo.listOutbox();
      expect(item?.state).toBe('awaiting_ok');
      expect(item?.body).toContain('enterprise customers');
    }
  });

  it('takes back a first hello written with a blank before, and writes it again or asks for what it lacked', async () => {
    for (const offer of ["You help fintech teams take reconciliation off their ops team's plate", 'tethers.com']) {
      const h = harness({ offer });
      const p = h.person();
      await start(h.ctx, h.project.id);
      for (const i of h.ctx.repo.listOutbox()) h.ctx.repo.updateOutbox(i.id, { state: 'cancelled' });
      const old = h.ctx.outbox.queueAuto(p.id, 'hello', 'Hi, I help YC founders [WHAT TETHERS DOES] at tethers.com.', 'Hello', h.clock.now(), true);
      await planProjectNow(h.ctx, h.project.id, { early: true });
      expect(h.ctx.repo.getOutbox(old.id)?.state).toBe('cancelled');
      const waiting = h.ctx.repo.listOutbox({ state: ['awaiting_ok'] });
      if (offer === 'tethers.com') {
        expect(waiting).toEqual([]);
        expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{ kind: 'needs_offer' }]);
      } else {
        expect(waiting).toHaveLength(1);
        expect(waiting[0]?.body).not.toContain('[');
        expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
      }
    }
  });

  it('does not start anything after Callum was wrapped up', async () => {
    const h = harness();
    h.person();
    h.ctx.repo.updateSettings({ pauseState: 'wrapped' });
    await expect(start(h.ctx, h.project.id)).rejects.toThrow('Callum is wrapped up. Start again first.');
    expect(h.ctx.repo.getProject(h.project.id)?.startedAt).toBeNull();
    expect(h.ctx.repo.getSettings().pauseState).toBe('wrapped');
  });

  it('is saved and succeeds even when writing the first hellos fails, and says what went wrong', async () => {
    const h = harness();
    h.strangers(3);
    const problems: unknown[] = [];
    h.ctx.onError = (e) => problems.push(e);
    vi.spyOn(h.ctx.writer, 'write').mockRejectedValue(new Error('Claude is busy'));
    await expect(start(h.ctx, h.project.id)).resolves.toEqual({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    expect(h.ctx.repo.getProject(h.project.id)?.startedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(problems.map((e) => (e as Error).message)).toEqual(['Claude is busy']);
  });
});
