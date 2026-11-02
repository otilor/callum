import { describe, expect, it } from 'vitest';
import { exportCsv, exportJson, forgetChannels, pauseUntil, resumeAll, startAgain, wrapSummaryLine, wrapUp, wrapUpEverything } from './leave.js';
import { start } from './onboarding.js';
import { createProject, wrapProject } from './projects.js';
import { harness, type Harness } from './testing.test-helpers.js';

const msg = (h: Harness, personId: number, over: Partial<Parameters<Harness['ctx']['repo']['insertMessage']>[0]> = {}) =>
  h.ctx.repo.insertMessage({ personId, channel: 'email', direction: 'out', kind: 'hello', subject: 'Hi', body: 'Hi there', at: '2026-10-30T09:00:00.000Z', externalId: null, ...over });

describe('pauseUntil and resumeAll', () => {
  it('takes a break until a date, and ends it with Resume', () => {
    const h = harness();
    expect(pauseUntil(h.ctx, '2026-11-09T08:00:00.000Z')).toMatchObject({ pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' });
    expect(h.scopes).toContain('settings');
    expect(resumeAll(h.ctx)).toMatchObject({ pauseState: 'running', pausedUntil: null });
  });

  it('takes a break with no end date, and refuses a date in the past', () => {
    const h = harness();
    expect(pauseUntil(h.ctx, null)).toMatchObject({ pauseState: 'paused', pausedUntil: null });
    expect(() => pauseUntil(h.ctx, '2026-11-01T00:00:00.000Z')).toThrow('Pick a date in the future.');
    expect(() => pauseUntil(h.ctx, 'next week')).toThrow('Pick a date Callum can read.');
  });

  it('does not unwrap a wrapped-up Callum by pausing or resuming', () => {
    const h = harness();
    wrapUp(h.ctx, { deleteData: false });
    expect(() => resumeAll(h.ctx)).toThrow('Callum is wrapped up. Start again first.');
    expect(() => pauseUntil(h.ctx, null)).toThrow('Callum is wrapped up. Start again first.');
  });
});

describe('wrapUp', () => {
  async function busy() {
    const h = harness();
    const people = h.strangers(4, { channel: 'email' });
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const other = h.person({ projectId: second.id, channel: 'email' });
    const now = h.clock.now();
    h.ctx.outbox.queueAuto(people[0]!.id, 'hello', 'Hi', 'Hello', now, true);
    h.ctx.outbox.queueAuto(people[1]!.id, 'hello', 'Hi', 'Hello', now, false);
    h.ctx.outbox.queueAuto(people[2]!.id, 'follow_up', 'Hi again', 'Re', now, false);
    h.ctx.outbox.queueAuto(other.id, 'follow_up', 'Hi again', 'Re', now, false);
    const sent = h.ctx.outbox.queueAuto(people[3]!.id, 'hello', 'Hi', 'Hello', now, false);
    h.ctx.repo.updateOutbox(sent.id, { state: 'sent' });
    return h;
  }

  it('cancels everything that has not gone out, counts it, and says so', async () => {
    const h = await busy();
    const res = wrapUp(h.ctx, { deleteData: false });
    expect(res).toEqual({
      cancelledFollowUps: 2, cancelledHellos: 2,
      summary: 'Nobody else hears from you. 2 follow-ups and 2 first hellos are cancelled.',
    });
    expect(h.ctx.repo.listOutbox({ state: ['awaiting_ok', 'scheduled'] })).toEqual([]);
    expect(h.ctx.repo.listOutbox({ state: ['sent'] })).toHaveLength(1);
    expect(h.ctx.repo.getSettings().pauseState).toBe('wrapped');
    expect(h.ctx.repo.listPeople()).toHaveLength(5);
    expect(h.scopes).toEqual(expect.arrayContaining(['outbox', 'settings']));
  });

  it('says a single message in the singular', () => {
    const h = harness();
    const p = h.person({ channel: 'email' });
    h.ctx.outbox.queueAuto(p.id, 'hello', 'Hi', 'Hello', h.clock.now(), false);
    expect(wrapUp(h.ctx, { deleteData: false }).summary).toBe('Nobody else hears from you. 0 follow-ups and 1 first hello are cancelled.');
  });

  it('can wipe everything and still stay wrapped up', async () => {
    const h = await busy();
    const res = wrapUp(h.ctx, { deleteData: true });
    expect(res.cancelledHellos).toBe(2);
    expect(h.ctx.repo.listPeople()).toEqual([]);
    expect(h.ctx.repo.listProjects()).toEqual([]);
    expect(h.ctx.repo.listOutbox()).toEqual([]);
    expect(h.ctx.repo.getSettings().pauseState).toBe('wrapped');
    expect(h.ctx.repo.getChannel('email').status).toBe('disconnected');
  });
});

describe('deleting data and the stop list', () => {
  it('keeps people who asked to stop on a private list, so a later import cannot bring them back', async () => {
    const h = harness();
    const kemi = h.person({ name: 'Kemi Eze', email: 'kemi@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' });
    h.ctx.repo.updatePerson(kemi.id, { status: 'stopped' });
    h.person({ name: 'Femi Ade', email: 'femi@ledgerly.io' });
    wrapUp(h.ctx, { deleteData: true });
    expect(h.ctx.repo.listPeople({ status: [] })).toEqual([]);
    expect(h.ctx.repo.isSuppressed({ email: 'KEMI@okopay.com' })).toBe(true);
    expect(h.ctx.repo.isSuppressed({ linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' })).toBe(true);
    expect(h.ctx.repo.isSuppressed({ email: 'femi@ledgerly.io' })).toBe(false);
  });
});

describe('forgetChannels', () => {
  it('signs every connected channel out and clears its secret', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    h.ctx.repo.setChannelSecret('email', { password: 'hunter2' });
    await forgetChannels(h.ctx);
    expect(h.ctx.repo.getChannel('email').status).toBe('disconnected');
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('disconnected');
    expect(h.ctx.repo.getChannelSecret('email')).toBeNull();
  });
});

describe('exportJson', () => {
  it('lists people with their messages, for one project or all', async () => {
    const h = harness();
    const kemi = h.person({ name: 'Kemi Eze' });
    msg(h, kemi.id);
    msg(h, kemi.id, { direction: 'in', kind: 'inbound', body: 'Tell me more', at: '2026-11-01T09:00:00.000Z' });
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    h.person({ name: 'Tunde Ade', projectId: second.id });
    const gone = h.person({ name: 'Not Fit', status: 'removed' });
    expect(gone.status).toBe('removed');

    const all = exportJson(h.ctx);
    expect(all.exportedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(all.people.map((p) => p.name)).toEqual(['Kemi Eze', 'Tunde Ade']);
    expect(all.people[0]?.messages.map((m) => m.body)).toEqual(['Hi there', 'Tell me more']);
    expect(exportJson(h.ctx, second.id).people.map((p) => p.name)).toEqual(['Tunde Ade']);
  });
});

describe('exportCsv', () => {
  it('writes the columns and quotes what needs it', () => {
    const h = harness();
    const p = h.person({ name: 'Kemi Eze', company: 'Oko, Pay "Ltd"', role: 'Head of Finance', channel: 'email', stage: 'following' });
    msg(h, p.id, { body: 'Line one\nLine two, with a comma', at: '2026-10-30T09:00:00.000Z' });
    const csv = exportCsv(h.ctx);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('name,email,company,role,linkedin,x,channel,stage,status,last_message,last_message_at,project');
    expect(csv).toContain('"Oko, Pay ""Ltd"""');
    expect(csv).toContain('"Line one\nLine two, with a comma",2026-10-30T09:00:00.000Z,Reconciliation');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('leaves empty cells empty, and takes the last message either way', () => {
    const h = harness();
    const p = h.person({ name: 'Kemi Eze', email: null, linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    msg(h, p.id);
    msg(h, p.id, { direction: 'in', kind: 'inbound', body: 'Thanks', at: '2026-11-01T09:00:00.000Z' });
    expect(exportCsv(h.ctx).split('\r\n')[1]).toBe('Kemi Eze,,Co 1,,https://www.linkedin.com/in/kemi,,,stranger,active,Thanks,2026-11-01T09:00:00.000Z,Reconciliation');
  });

  it('cannot be turned into a formula by what a stranger wrote', () => {
    const h = harness();
    const p = h.person({ name: 'Kemi Eze' });
    msg(h, p.id, { direction: 'in', kind: 'inbound', body: '=HYPERLINK("http://evil.example","click")' });
    expect(exportCsv(h.ctx)).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
  });

  it('exports one project, or all with the project name', async () => {
    const h = harness();
    h.person({ name: 'Kemi Eze' });
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    h.person({ name: 'Tunde Ade', projectId: second.id });
    expect(exportCsv(h.ctx).trim().split('\r\n')).toHaveLength(3);
    const only = exportCsv(h.ctx, second.id).trim().split('\r\n');
    expect(only).toHaveLength(2);
    expect(only[1]).toMatch(/^Tunde Ade,.*,Payroll$/);
  });
});

describe('wrapSummaryLine', () => {
  it('counts who heard from Callum, who replied and who booked', () => {
    const h = harness();
    const a = h.person();
    const b = h.person({ badge: 'booked' });
    const c = h.person();
    h.person();
    msg(h, a.id);
    msg(h, b.id);
    msg(h, c.id, { kind: 'invite', channel: 'linkedin' });
    msg(h, b.id, { direction: 'in', kind: 'inbound', body: 'Yes', at: '2026-10-31T09:00:00.000Z' });
    expect(wrapSummaryLine(h.ctx)).toBe('Callum said hello to 3 people for you. 1 replied, and 1 call got booked.');
  });

  it('reads well with nothing at all', () => {
    expect(wrapSummaryLine(harness().ctx)).toBe('Callum said hello to 0 people for you. 0 replied, and 0 calls got booked.');
  });
});

describe('startAgain', () => {
  it('goes back to the first run and keeps channels and people', async () => {
    const h = harness();
    h.strangers(3);
    await start(h.ctx, h.project.id);
    wrapUp(h.ctx, { deleteData: false });
    startAgain(h.ctx);
    expect(h.ctx.repo.getSettings()).toMatchObject({ onboarded: false, pauseState: 'running', pausedUntil: null });
    expect(h.ctx.repo.getProject(h.project.id)).toMatchObject({ startedAt: null, approvalsLeft: 10, state: 'running' });
    expect(h.ctx.repo.listPeople()).toHaveLength(3);
    expect(h.ctx.repo.getChannel('email').status).toBe('connected');
    // and Start works again
    await expect(start(h.ctx, h.project.id)).resolves.toMatchObject({ firstSendAt: '2026-11-03T08:00:00.000Z' });
  });
});

describe('a wrap-up sticks', () => {
  it('wraps every project that was going, so starting another project cannot bring it back', async () => {
    const h = harness();
    h.strangers(2, { channel: 'email' });
    await start(h.ctx, h.project.id);
    const payroll = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    h.person({ projectId: payroll.id });
    wrapUp(h.ctx, { deleteData: false });
    expect(h.ctx.repo.listProjects().map((p) => p.state)).toEqual(['wrapped', 'wrapped']);
    await expect(start(h.ctx, payroll.id)).rejects.toThrow('Callum is wrapped up. Start again first.');
    expect(h.ctx.repo.getSettings().pauseState).toBe('wrapped');
    expect(h.ctx.repo.listOutbox({ state: ['awaiting_ok', 'scheduled'] })).toEqual([]);
  });

  it('Start again brings back the projects the wrap-up wrapped, and not one the user wrapped on its own', async () => {
    const h = harness();
    h.person();
    const payroll = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    const old = await createProject(h.ctx, { offer: 'You help teams with invoices', name: 'Invoices' });
    wrapProject(h.ctx, old.id);
    wrapUp(h.ctx, { deleteData: false });
    expect(h.ctx.repo.getSettings().wrappedByWrapUp).toEqual([h.project.id, payroll.id]);
    startAgain(h.ctx);
    expect(h.ctx.repo.listProjects().map((p) => [p.name, p.state])).toEqual([['Reconciliation', 'running'], ['Payroll', 'running'], ['Invoices', 'wrapped']]);
    expect(h.ctx.repo.getSettings().wrappedByWrapUp).toEqual([]);
    await expect(start(h.ctx, payroll.id)).rejects.toThrow('Add some people first');
    await expect(start(h.ctx, h.project.id)).resolves.toBeDefined();
  });

  it('wrapUpEverything signs channels out first when the data is to be deleted', async () => {
    const h = harness();
    h.ctx.repo.setChannelSecret('email', { password: 'hunter2' });
    const kept = await wrapUpEverything(h.ctx, { deleteData: false });
    expect(kept.summary).toBe('Nobody else hears from you. 0 follow-ups and 0 first hellos are cancelled.');
    expect(h.ctx.repo.getChannel('email').status).toBe('connected');
    startAgain(h.ctx);
    await wrapUpEverything(h.ctx, { deleteData: true });
    expect(h.ctx.repo.getChannelSecret('email')).toBeNull();
    expect(h.ctx.repo.listPeople()).toEqual([]);
    expect(h.ctx.repo.getSettings().pauseState).toBe('wrapped');
  });
});
