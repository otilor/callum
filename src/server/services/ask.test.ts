import { describe, expect, it, vi } from 'vitest';
import type { PersonLead } from '../../shared/types.js';
import { FindError, type FindQuery, type PeopleFinder } from '../leads/finder.js';
import { act, ask } from './ask.js';
import { harness, type Harness } from './testing.test-helpers.js';

const NEEDS_CLAUDE = 'Finding people needs Claude. Sign in to Claude Code on this computer, or add a Claude key in Your Callum.';

/** A people finder that answers from a list and records what it was asked. */
function finder(people: { first: string; last: string; email?: string; linkedin?: string }[], opts: { fail?: string } = {}): PeopleFinder & { asked: FindQuery[] } {
  const asked: FindQuery[] = [];
  return {
    asked,
    async find(q) {
      asked.push(q);
      if (opts.fail) throw new FindError(opts.fail);
      return people.slice(0, q.count).map((p): PersonLead => ({
        name: `${p.first} ${p.last}`, role: 'Head of Finance', company: 'Fieldnote', source: 'web', note: 'Leads finance at Fieldnote.',
        ...(p.linkedin ? { linkedinUrl: p.linkedin } : {}), ...(p.email ? { email: p.email } : {}),
      }));
    },
  };
}

function withKemi(h: Harness) {
  return h.person({ name: 'Kemi Eze', role: 'Head of Finance', company: 'Oko Pay', channel: 'email' });
}

describe('ask', () => {
  it('says who is warming up', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const a = h.person({ stage: 'following', touches: 2, channel: 'email' });
    const b = h.person({ stage: 'hello', touches: 1, channel: 'linkedin', linkedinState: 'connected', linkedinUrl: 'https://www.linkedin.com/in/b' });
    h.person({ stage: 'hello', touches: 1 });
    h.person({ stage: 'following', touches: 2, status: 'stopped' });
    const res = await ask(h.ctx, h.project.id, "who's warming up");
    expect(res).toEqual({ text: '2 people are warming up.', personIds: [a.id, b.id], action: null });
    h.ctx.repo.updatePerson(b.id, { linkedinState: 'none' });
    expect((await ask(h.ctx, h.project.id, "who's warming up")).text).toBe('1 person is warming up.');
  });

  it('answers why with the open incident, else that nothing is paused', async () => {
    const h = harness();
    expect((await ask(h.ctx, h.project.id, 'why did it stop')).text).toBe('Nothing is paused. Callum is running.');
    h.ctx.repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_check', message: "LinkedIn asked to check it's you, so Callum paused LinkedIn." });
    expect((await ask(h.ctx, h.project.id, 'why did it stop')).text).toBe("LinkedIn asked to check it's you, so Callum paused LinkedIn.");
  });

  it('does not say nothing is paused when something is', async () => {
    const h = harness();
    h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' });
    expect((await ask(h.ctx, h.project.id, 'why is nothing going out')).text).toBe('Callum is on a break until November 9 at 9:00. Nothing goes out on its own until then.');
    h.ctx.repo.updateSettings({ pauseState: 'running', pausedUntil: null });
    h.ctx.repo.updateProject(h.project.id, { state: 'paused', pausedUntil: null });
    expect((await ask(h.ctx, h.project.id, 'why is nothing going out')).text).toBe('Reconciliation is paused. Nothing goes out on its own there until you resume.');
  });

  it('says Claude is needed when there is none', async () => {
    const h = harness();
    h.ctx.finder = null;
    withKemi(h);
    const res = await ask(h.ctx, h.project.id, 'find 20 more like Kemi');
    expect(res).toEqual({ text: NEEDS_CLAUDE, personIds: [], action: null });
  });

  it('offers to find more like a person, and says it takes a few minutes', async () => {
    const h = harness();
    const kemi = withKemi(h);
    h.ctx.finder = finder([]);
    const res = await ask(h.ctx, h.project.id, 'find 20 more like Kemi');
    expect(res).toEqual({
      text: 'Callum can look for 20 more like Kemi on the web. It takes a few minutes.',
      personIds: [kemi.id],
      action: { kind: 'find_more', label: 'Find 20 more like Kemi', args: { likePersonId: kemi.id, query: null, count: 20 } },
    });
  });

  it('offers to find people for a description', async () => {
    const h = harness();
    h.ctx.finder = finder([]);
    const res = await ask(h.ctx, h.project.id, 'find 15 CFOs in Lagos');
    expect(res.action).toEqual({ kind: 'find_more', label: 'Find 15 people', args: { likePersonId: null, query: 'CFOs in Lagos', count: 15 } });
    expect(res.text).toBe('Callum can look for 15 people on the web. It takes a few minutes.');
  });

  it('does not offer to find more like someone with no role', async () => {
    const h = harness();
    h.person({ name: 'Kemi Eze', role: null });
    h.ctx.finder = finder([]);
    const res = await ask(h.ctx, h.project.id, 'find 5 more like Kemi');
    expect(res.action).toBeNull();
    expect(res.text).toBe("Callum doesn't know what Kemi does, so it can't look for more like them. Tell it who to find instead.");
  });

  it('offers to pause and resume a channel', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    expect(await ask(h.ctx, h.project.id, 'pause LinkedIn')).toMatchObject({ action: { kind: 'pause_channel', label: 'Pause LinkedIn', args: { channel: 'linkedin' } } });
    expect((await ask(h.ctx, h.project.id, 'resume LinkedIn')).text).toBe('LinkedIn is already running.');
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    expect(await ask(h.ctx, h.project.id, 'resume LinkedIn')).toMatchObject({ action: { kind: 'resume_channel', label: 'Resume LinkedIn', args: { channel: 'linkedin' } } });
    expect((await ask(h.ctx, h.project.id, 'pause LinkedIn')).text).toBe('LinkedIn is already paused.');
    expect((await ask(h.ctx, h.project.id, 'pause X')).text).toBe("X isn't connected yet.");
  });

  it('offers a new tone', async () => {
    const h = harness();
    expect(await ask(h.ctx, h.project.id, 'make it a more direct tone')).toMatchObject({ action: { kind: 'set_tone', label: 'Use a direct tone', args: { tone: 'direct' } } });
    h.ctx.repo.updateProject(h.project.id, { tone: 'direct' });
    expect((await ask(h.ctx, h.project.id, 'make it a more direct tone')).action).toBeNull();
  });

  it('offers to move people to another channel, only those who can go', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const kemi = h.person({ name: 'Kemi Eze', channel: 'email', linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    const tunde = h.person({ name: 'Tunde Ade', channel: 'email', linkedinUrl: 'https://www.linkedin.com/in/tunde' });
    h.person({ name: 'Bola Ojo', channel: 'email' });
    const res = await ask(h.ctx, h.project.id, 'move Kemi and Tunde to LinkedIn');
    expect(res.action).toEqual({ kind: 'switch_channel', label: 'Move Kemi and Tunde to LinkedIn', args: { personIds: [kemi.id, tunde.id], channel: 'linkedin' } });
    const none = await ask(h.ctx, h.project.id, 'move Bola to LinkedIn');
    expect(none.action).toBeNull();
    expect(none.text).toBe("Callum can't move Bola to LinkedIn right now.");
  });

  it('says what it can do when it does not understand, and never uses an exclamation mark', async () => {
    const h = harness();
    const res = await ask(h.ctx, h.project.id, 'sing me a song');
    expect(res).toEqual({ text: "Callum can find people, pause a channel, change the tone, or tell you who's warming up.", personIds: [], action: null });
    expect((await ask(h.ctx, h.project.id, '')).text).toBe(res.text);
  });
});

describe('act', () => {
  it('pauses a channel, which then stays paused', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const res = await act(h.ctx, h.project.id, { kind: 'pause_channel', label: 'Pause LinkedIn', args: { channel: 'linkedin' } });
    expect(res.text).toBe('Paused LinkedIn. Nothing new goes out there until you resume.');
    expect(h.ctx.repo.getChannel('linkedin')).toMatchObject({ status: 'paused', pausedUntil: null });
    expect(h.scopes).toContain('channels');
    await expect(act(h.ctx, h.project.id, { kind: 'pause_channel', label: '', args: { channel: 'linkedin' } })).rejects.toThrow("LinkedIn isn't running, so there is nothing to pause.");
  });

  it('resumes a channel the user paused', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    const res = await act(h.ctx, h.project.id, { kind: 'resume_channel', label: 'Resume LinkedIn', args: { channel: 'linkedin' } });
    expect(res.text).toBe('Resumed LinkedIn.');
    expect(h.ctx.repo.getChannel('linkedin')).toMatchObject({ status: 'connected', halfPaceUntil: null });
  });

  it('will not resume a channel past a check, a daily limit or a signed-out mailbox, and says where to go', async () => {
    const h = harness({ connected: ['email', 'linkedin', 'x'] });
    const resume = (channel: 'email' | 'linkedin' | 'x') => act(h.ctx, h.project.id, { kind: 'resume_channel', label: '', args: { channel } });

    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    h.ctx.repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_check', message: 'check' });
    await expect(resume('linkedin')).rejects.toThrow("LinkedIn asked to check it's you. Finish the check on LinkedIn first, then press Resume LinkedIn on the notice on your home screen.");
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    expect(h.ctx.repo.listIncidents({ open: true })).toHaveLength(1);

    h.ctx.repo.updateChannel('x', { status: 'paused' });
    h.ctx.repo.insertIncident({ channel: 'x', kind: 'x_limit', message: 'limit' });
    await expect(resume('x')).rejects.toThrow('X is out of room for today, so Callum can\'t resume it yet. It starts again by itself tomorrow.');

    h.ctx.repo.updateChannel('email', { status: 'error' });
    h.ctx.repo.insertIncident({ channel: 'email', kind: 'mailbox_signed_out', message: 'out' });
    await expect(resume('email')).rejects.toThrow('Email signed Callum out. Reconnect Email first, from Your Callum or the notice on your home screen.');
    expect(h.ctx.repo.getChannel('email').status).toBe('error');
  });

  it('changes the tone of the project', async () => {
    const h = harness();
    await act(h.ctx, h.project.id, { kind: 'set_tone', label: 'Use a playful tone', args: { tone: 'playful' } });
    expect(h.ctx.repo.getProject(h.project.id)?.tone).toBe('playful');
    // A first hello waiting for an OK was written in the old tone: it is taken back to be written again.
    const p = h.ctx.repo.insertPerson({ projectId: h.project.id, name: 'Kemi Eze', source: 'csv', email: 'kemi@okopay.com', channel: 'email' });
    const waiting = h.ctx.outbox.queueAuto(p.id, 'hello', 'Hi Kemi, a warm note.', 'Hello', h.ctx.clock.now(), true);
    await act(h.ctx, h.project.id, { kind: 'set_tone', label: 'Use a direct tone', args: { tone: 'direct' } });
    expect(h.ctx.repo.getOutbox(waiting.id)?.state).toBe('cancelled');
    await expect(act(h.ctx, h.project.id, { kind: 'set_tone', label: '', args: { tone: 'rude' as never } })).rejects.toThrow('Pick warm, direct or playful.');
  });

  it('moves two people, a week after their last note, and drops what was queued for them', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const lastTouch = '2026-10-31T09:00:00.000Z';
    const kemi = h.person({ name: 'Kemi Eze', channel: 'email', stage: 'hello', touches: 1, lastTouchAt: lastTouch, linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    const tunde = h.person({ name: 'Tunde Ade', channel: 'email', stage: 'hello', touches: 1, lastTouchAt: lastTouch, linkedinUrl: 'https://www.linkedin.com/in/tunde' });
    const bola = h.person({ name: 'Bola Ojo', channel: 'email' });
    const queued = h.ctx.outbox.queueAuto(kemi.id, 'follow_up', 'Hi again', 'Re', h.clock.now(), false);
    const res = await act(h.ctx, h.project.id, { kind: 'switch_channel', label: '', args: { personIds: [kemi.id, tunde.id, bola.id], channel: 'linkedin' } });
    expect(res.personIds).toEqual([kemi.id, tunde.id]);
    expect(res.text).toBe('Moved Kemi and Tunde to LinkedIn. The first note there goes out from November 9 at 9:00. Bola stayed where they are.');
    for (const id of [kemi.id, tunde.id]) {
      const p = h.ctx.repo.getPerson(id)!;
      expect(p).toMatchObject({ channel: 'linkedin', touches: 0 });
      // seven days after 31 October is 7 November, a Saturday: the next sending slot is Monday 9 November at 9:00 in Lagos
      expect(p.nextTouchAt).toBe('2026-11-09T08:00:00.000Z');
    }
    expect(h.ctx.repo.getPerson(bola.id)?.channel).toBe('email');
    expect(h.ctx.repo.getOutbox(queued.id)?.state).toBe('cancelled');
  });

  it('refuses a move to a channel that is not connected, or to nobody who can go', async () => {
    const h = harness();
    const kemi = h.person({ linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    await expect(act(h.ctx, h.project.id, { kind: 'switch_channel', label: '', args: { personIds: [kemi.id], channel: 'linkedin' } })).rejects.toThrow("LinkedIn isn't connected yet.");
    h.ctx.repo.updateChannel('linkedin', { status: 'connected' });
    const bola = h.person();
    await expect(act(h.ctx, h.project.id, { kind: 'switch_channel', label: '', args: { personIds: [bola.id], channel: 'linkedin' } })).rejects.toThrow("Callum can't move Person2 to LinkedIn right now.");
  });

  it('does not move someone from another project', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const other = h.ctx.repo.insertProject({ name: 'Payroll' });
    const stranger = h.person({ projectId: other.id, linkedinUrl: 'https://www.linkedin.com/in/x' });
    await expect(act(h.ctx, h.project.id, { kind: 'switch_channel', label: '', args: { personIds: [stranger.id], channel: 'linkedin' } })).rejects.toThrow("Callum can't find those people.");
    expect(h.ctx.repo.getPerson(stranger.id)?.channel).toBeNull();
  });

  it('turns away an action it does not know', async () => {
    const h = harness();
    await expect(act(h.ctx, h.project.id, { kind: 'format_disk' } as never)).rejects.toThrow('Callum does not know how to do that.');
  });
});

describe('act find_more', () => {
  const find = (likePersonId: number | null, query: string | null, count = 3) => ({ kind: 'find_more' as const, label: '', args: { likePersonId, query, count } });

  it('needs Claude', async () => {
    const h = harness();
    h.ctx.finder = null;
    await expect(act(h.ctx, h.project.id, find(null, 'CFOs'))).rejects.toThrow(NEEDS_CLAUDE);
  });

  it('asks Claude for people like someone, imports the ones it can reach as strangers, and leaves that person out', async () => {
    const h = harness();
    const kemi = withKemi(h);
    const fake = finder([
      { first: 'Tunde', last: 'Adeyemi', email: 'tunde@fieldnote.com' },
      { first: 'Bola', last: 'Ojo', linkedin: 'https://www.linkedin.com/in/bola-ojo' },
    ]);
    h.ctx.finder = fake;
    const res = await act(h.ctx, h.project.id, find(kemi.id, null));
    expect(fake.asked[0]?.description).toBe('People in the same kind of role as Kemi Eze: Head of Finance, at companies like Oko Pay. Not Kemi Eze.');
    expect(fake.asked[0]?.known).toEqual(['Kemi Eze (Oko Pay)']);
    expect(res.text).toBe('Added 2 people. They start as strangers.');
    const added = h.ctx.repo.listPeople().filter((p) => p.id !== kemi.id);
    expect(added.map((p) => [p.name, p.status, p.stage, p.source, p.projectId])).toEqual([
      ['Tunde Adeyemi', 'active', 'stranger', 'web', h.project.id],
      ['Bola Ojo', 'active', 'stranger', 'web', h.project.id],
    ]);
    expect(res.personIds).toEqual(added.map((p) => p.id));
    expect(h.scopes).toContain('people');
  });

  it('searches by the words when nobody is the model', async () => {
    const h = harness();
    const fake = finder([{ first: 'Tunde', last: 'Adeyemi', email: 'tunde@fieldnote.com' }]);
    h.ctx.finder = fake;
    const res = await act(h.ctx, h.project.id, find(null, 'CFOs in Lagos', 1));
    expect(fake.asked[0]).toMatchObject({ description: 'CFOs in Lagos', count: 1 });
    expect(res.text).toBe('Added 1 person. They start as strangers.');
  });

  it('imports into the project being viewed and skips people who are already in Callum', async () => {
    const h = harness();
    const other = h.ctx.repo.insertProject({ name: 'Payroll' });
    h.person({ projectId: other.id, email: 'tunde@fieldnote.com' });
    h.person({ email: 'bola@fieldnote.com' });
    h.ctx.finder = finder([
      { first: 'Tunde', last: 'Adeyemi', email: 'tunde@fieldnote.com' },
      { first: 'Bola', last: 'Ojo', email: 'bola@fieldnote.com' },
      { first: 'Sade', last: 'Bello', email: 'sade@fieldnote.com' },
    ]);
    const res = await act(h.ctx, h.project.id, find(null, 'finance', 3));
    expect(res.text).toBe('Added 1 person. They start as strangers. 2 people were already in Callum or asked not to be contacted.');
  });

  it('says when Claude found nobody it could reach', async () => {
    const h = harness();
    h.ctx.finder = finder([]);
    const res = await act(h.ctx, h.project.id, find(null, 'unicorn wranglers'));
    expect(res.text).toBe('Callum found nobody it could reach for that. Try different words.');
  });

  it('passes on what went wrong with Claude, in words', async () => {
    const h = harness();
    h.ctx.finder = finder([], { fail: "Your Claude plan's usage limit is reached for now. Callum tries again later." });
    await expect(act(h.ctx, h.project.id, find(null, 'finance', 1))).rejects.toMatchObject({
      name: 'UserError', message: "Your Claude plan's usage limit is reached for now. Callum tries again later.",
    });
    expect(h.ctx.repo.listPeople()).toEqual([]);
  });

  it('refuses a model with no role and an empty request', async () => {
    const h = harness();
    h.ctx.finder = finder([]);
    const p = h.person({ name: 'Kemi Eze', role: null });
    await expect(act(h.ctx, h.project.id, find(p.id, null))).rejects.toThrow("Kemi has no role on file, so Callum can't find people like them. Try describing who to find.");
    await expect(act(h.ctx, h.project.id, find(null, '  '))).rejects.toThrow("Callum can find people, pause a channel, change the tone, or tell you who's warming up.");
  });

  it('only looks for people like someone who is in this project and still there', async () => {
    const h = harness();
    h.ctx.finder = finder([]);
    const other = h.ctx.repo.insertProject({ name: 'Payroll' });
    const elsewhere = h.person({ projectId: other.id, role: 'CFO' });
    const gone = h.person({ role: 'CFO', status: 'removed' });
    for (const p of [elsewhere, gone, { id: 9999 }]) {
      await expect(act(h.ctx, h.project.id, find(p.id, null))).rejects.toThrow("Callum can't find that person in this project.");
    }
  });

  it('does not add people to a project that is wrapped up', async () => {
    const h = harness();
    const fake = finder([{ first: 'Tunde', last: 'Adeyemi', email: 'tunde@fieldnote.com' }]);
    h.ctx.finder = fake;
    h.ctx.repo.updateProject(h.project.id, { state: 'wrapped' });
    await expect(act(h.ctx, h.project.id, find(null, 'finance', 1))).rejects.toThrow('Reconciliation is wrapped up.');
    expect(fake.asked).toEqual([]);
  });
});

describe('ask more', () => {
  it('names a paused or signed-out channel before saying nothing is paused', async () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    expect((await ask(h.ctx, h.project.id, 'why is nothing going out')).text).toBe('LinkedIn is paused. Resume it from Ask or Your Callum.');
    h.ctx.repo.updateChannel('linkedin', { status: 'connected' });
    h.ctx.repo.updateChannel('email', { status: 'error' });
    expect((await ask(h.ctx, h.project.id, 'why is nothing going out')).text).toBe('Email needs to be connected again from Your Callum.');
  });

  it('does not offer a search with nobody to be like and nothing to look for', async () => {
    const h = harness();
    h.ctx.finder = finder([]);
    vi.spyOn(h.ctx.writer, 'parseAsk').mockResolvedValue({ intent: 'find', likePersonId: null, query: null, count: 5 });
    const res = await ask(h.ctx, h.project.id, 'find some');
    expect(res.action).toBeNull();
    expect(res.text).toBe("Callum can find people, pause a channel, change the tone, or tell you who's warming up.");
  });
});
