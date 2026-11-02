import { describe, expect, it } from 'vitest';
import { TemplateWriter } from '../ai/templates.js';
import { UserError } from './errors.js';
import {
  createProject, moveToProject, pauseProject, renameProject, resumeProject, setCurrentProject, updateProject, wrapProject,
} from './projects.js';
import { harness } from './testing.test-helpers.js';

describe('createProject', () => {
  it('suggests a name from the offer, and a second project gets its own suggested name', async () => {
    const h = harness();
    const a = await createProject(h.ctx, { offer: 'We make payroll painless for small teams' });
    const b = await createProject(h.ctx, { offer: 'You help founders collect invoices faster' });
    expect(a.name).not.toBe(b.name);
    expect(a.name).toBe(await new TemplateWriter(h.clock).projectName('We make payroll painless for small teams'));
    expect(h.ctx.repo.listProjects().map((p) => p.name)).toEqual(['Reconciliation', a.name, b.name]);
    expect(h.scopes).toContain('projects');
  });

  it('adds 2, 3 when the suggested name is taken', async () => {
    const h = harness();
    const first = await createProject(h.ctx, { offer: 'You help teams with payroll' });
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll' });
    const third = await createProject(h.ctx, { offer: 'You help teams with payroll' });
    expect(second.name).toBe(`${first.name} 2`);
    expect(third.name).toBe(`${first.name} 3`);
  });

  it('refuses a name the user chose when it is taken, ignoring case', async () => {
    const h = harness();
    await expect(createProject(h.ctx, { offer: 'x', name: 'reconciliation' })).rejects.toMatchObject({
      name: 'UserError', message: 'You already have a project called reconciliation. Pick another name.',
    });
  });

  it('keeps the audience and tone, and makes the first project the one being viewed', async () => {
    const h = harness();
    h.ctx.repo.updateSettings({ currentProjectId: null });
    const p = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll', audience: 'Heads of finance', tone: 'direct' });
    expect(p).toMatchObject({ name: 'Payroll', audience: 'Heads of finance', tone: 'direct', state: 'running', startedAt: null, approvalsLeft: 10 });
    expect(h.ctx.repo.getSettings().currentProjectId).toBe(p.id);
  });

  it('does not move the project being viewed when one is already set', async () => {
    const h = harness();
    await createProject(h.ctx, { offer: 'You help teams with payroll' });
    expect(h.ctx.repo.getSettings().currentProjectId).toBe(h.project.id);
  });

  it('treats a blank name as no name, and rejects an unknown tone and a name that is too long', async () => {
    const h = harness();
    expect((await createProject(h.ctx, { offer: 'You help teams with payroll', name: '   ' })).name).not.toBe('');
    await expect(createProject(h.ctx, { offer: 'x', name: 'N'.repeat(61) })).rejects.toBeInstanceOf(UserError);
    await expect(createProject(h.ctx, { offer: 'x', name: 'Ok', tone: 'rude' as never })).rejects.toBeInstanceOf(UserError);
  });
});

describe('renameProject and updateProject', () => {
  it('renames, and refuses a name another project has', async () => {
    const h = harness();
    const payroll = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    expect(renameProject(h.ctx, payroll.id, 'Pay runs').name).toBe('Pay runs');
    expect(() => renameProject(h.ctx, payroll.id, 'RECONCILIATION')).toThrow('You already have a project called RECONCILIATION. Pick another name.');
    expect(renameProject(h.ctx, payroll.id, 'pay runs').name).toBe('pay runs');
  });

  it('patches offer, audience, tone, sample and calendar link', async () => {
    const h = harness();
    const p = updateProject(h.ctx, h.project.id, {
      offer: 'You help CFOs close faster', audience: 'CFOs', tone: 'playful', sample: 'Hey, quick one', calendarUrl: 'https://cal.example.com/new',
    });
    expect(p).toMatchObject({ offer: 'You help CFOs close faster', audience: 'CFOs', tone: 'playful', sample: 'Hey, quick one', calendarUrl: 'https://cal.example.com/new' });
    expect(updateProject(h.ctx, h.project.id, { calendarUrl: '  ' }).calendarUrl).toBeNull();
  });

  it('refuses a calendar link that is not a web address', () => {
    const h = harness();
    expect(() => updateProject(h.ctx, h.project.id, { calendarUrl: 'my calendar' })).toThrow('That calendar link needs to start with https://');
  });
});

describe('pauseProject, resumeProject and setCurrentProject', () => {
  it('pausing project 2 leaves project 1 hellos scheduled', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const a = h.person({ channel: 'email' });
    const b = h.person({ channel: 'email', projectId: second.id });
    h.ctx.outbox.queueAuto(a.id, 'hello', 'Hi', 'Hello', h.clock.now(), false);
    h.ctx.outbox.queueAuto(b.id, 'hello', 'Hi', 'Hello', h.clock.now(), false);
    const paused = pauseProject(h.ctx, second.id, '2026-11-09T08:00:00.000Z');
    expect(paused).toMatchObject({ state: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' });
    expect(h.ctx.repo.listOutbox({ personId: a.id })[0]?.state).toBe('scheduled');
    expect(h.ctx.repo.getProject(h.project.id)?.state).toBe('running');
    expect(resumeProject(h.ctx, second.id)).toMatchObject({ state: 'running', pausedUntil: null });
  });

  it('pauses with no end date', () => {
    const h = harness();
    expect(pauseProject(h.ctx, h.project.id, null)).toMatchObject({ state: 'paused', pausedUntil: null });
  });

  it('refuses a past date and a wrapped project', async () => {
    const h = harness();
    expect(() => pauseProject(h.ctx, h.project.id, '2026-11-01T00:00:00.000Z')).toThrow('Pick a date in the future.');
    wrapProject(h.ctx, h.project.id);
    expect(() => pauseProject(h.ctx, h.project.id, null)).toThrow('Reconciliation is wrapped up.');
    expect(() => resumeProject(h.ctx, h.project.id)).toThrow('Reconciliation is wrapped up.');
  });

  it('remembers the project being viewed, and not a wrapped one', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    setCurrentProject(h.ctx, second.id);
    expect(h.ctx.repo.getSettings().currentProjectId).toBe(second.id);
    expect(h.scopes).toContain('settings');
    wrapProject(h.ctx, h.project.id);
    expect(() => setCurrentProject(h.ctx, h.project.id)).toThrow('Reconciliation is wrapped up.');
  });
});

describe('wrapProject', () => {
  it('cancels that project\'s automatic items, counts them, and leaves other projects and replies alone', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const [a, b, c] = [h.person({ channel: 'email' }), h.person({ channel: 'email' }), h.person({ channel: 'email' })];
    const talking = h.person({ channel: 'email', stage: 'talking', status: 'waiting' });
    const other = h.person({ channel: 'email', projectId: second.id });
    const now = h.clock.now();
    h.ctx.outbox.queueAuto(a.id, 'hello', 'Hi', 'Hello', now, true);
    h.ctx.outbox.queueAuto(b.id, 'hello', 'Hi', 'Hello', now, false);
    h.ctx.outbox.queueAuto(c.id, 'follow_up', 'Hi again', 'Re', now, false);
    const reply = h.ctx.outbox.queueUserSend(talking.id, 'reply', 'Thanks');
    const elsewhere = h.ctx.outbox.queueAuto(other.id, 'hello', 'Hi', 'Hello', now, false);

    const res = wrapProject(h.ctx, h.project.id);
    expect(res).toEqual({
      cancelledFollowUps: 1, cancelledHellos: 2,
      summary: 'Nobody else in Reconciliation hears from you. 1 follow-up and 2 first hellos are cancelled.',
    });
    expect(h.ctx.repo.getProject(h.project.id)?.state).toBe('wrapped');
    expect(h.ctx.repo.getOutbox(reply.id)?.state).toBe('scheduled');
    expect(h.ctx.repo.getOutbox(elsewhere.id)?.state).toBe('scheduled');
    expect(h.ctx.repo.getPerson(talking.id)?.status).toBe('waiting');
    expect(h.scopes).toEqual(expect.arrayContaining(['outbox', 'projects']));
  });

  it('moves the project being viewed to one that is still going', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    wrapProject(h.ctx, h.project.id);
    expect(h.ctx.repo.getSettings().currentProjectId).toBe(second.id);
  });
});

describe('moveToProject', () => {
  it('moves a stranger and cancels the hello waiting for an OK', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const kemi = h.person({ name: 'Kemi Eze', channel: 'email' });
    const item = h.ctx.outbox.queueAuto(kemi.id, 'hello', 'Hi', 'Hello', h.clock.now(), true);
    const moved = moveToProject(h.ctx, kemi.id, second.id);
    expect(moved.projectId).toBe(second.id);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('cancelled');
    expect(h.scopes).toEqual(expect.arrayContaining(['people', 'outbox']));
  });

  it('moves a resting person and keeps the date they wake', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const p = h.person({ status: 'resting', stage: 'following', touches: 3, restUntil: '2027-01-30T00:00:00.000Z', nextTouchAt: null });
    expect(moveToProject(h.ctx, p.id, second.id)).toMatchObject({ projectId: second.id, restUntil: '2027-01-30T00:00:00.000Z', status: 'resting' });
  });

  it('says why a person who is talking, waiting, in progress or stopped cannot move', async () => {
    const h = harness();
    await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const second = h.ctx.repo.listProjects()[1]!;
    const talking = h.person({ name: 'Kemi Eze', stage: 'talking', status: 'active' });
    const waiting = h.person({ name: 'Tunde Ade', stage: 'following', status: 'waiting' });
    const busy = h.person({ name: 'Bola Ojo', stage: 'hello', touches: 1 });
    const stopped = h.person({ name: 'Sade Bello', status: 'stopped' });
    expect(() => moveToProject(h.ctx, talking.id, second.id)).toThrow('Kemi is talking with you about Reconciliation. Finish that conversation first.');
    expect(() => moveToProject(h.ctx, waiting.id, second.id)).toThrow('Tunde is talking with you about Reconciliation. Finish that conversation first.');
    expect(() => moveToProject(h.ctx, busy.id, second.id)).toThrow("Bola has already heard from you about Reconciliation. Callum can move them once they're resting.");
    expect(() => moveToProject(h.ctx, stopped.id, second.id)).toThrow('Sade asked not to be contacted.');
    expect(h.ctx.repo.getPerson(talking.id)?.projectId).toBe(h.project.id);
  });

  it('refuses a project that is wrapped up or does not exist', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const p = h.person();
    expect(() => moveToProject(h.ctx, p.id, 999)).toThrow("Callum can't find that project.");
    wrapProject(h.ctx, second.id);
    expect(() => moveToProject(h.ctx, p.id, second.id)).toThrow('Payroll is wrapped up.');
  });
});
