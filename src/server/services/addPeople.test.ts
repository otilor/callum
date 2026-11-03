import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectError } from '../channels/types.js';
import { commit, describe as describePeople, discardProject, preview, sampleHello, undoBatch, BATCH_MS, DESCRIBE_COUNT, NO_CLAUDE } from './addPeople.js';
import { fakeFinder, foundPerson, MONDAY, setup, type Setup } from './addPeople.test-helpers.js';
import { UserError } from './errors.js';

const CSV = [
  'Name,Email,Company',
  'Kemi Eze,kemi@okopay.com,Oko Pay',
  'Femi Ade,femi@ledgerly.io,Ledgerly',
  'Tunde Bello,tunde@sent.com,Sent Co',
  'Dup One,dup@here.com,Here',
  'Ruth Adeleke,ruth@stop.com,Stop Co',
  'Bola,,',
].join('\n');

function seedExisting(s: Setup) {
  s.ctx.repo.insertPerson({ projectId: s.projectId, name: 'Dup One', email: 'dup@here.com', source: 'csv' });
  const ruth = s.ctx.repo.insertPerson({ projectId: s.projectId, name: 'Ruth Adeleke', email: 'ruth@stop.com', source: 'csv' });
  s.ctx.repo.updatePerson(ruth.id, { status: 'stopped' });
  s.sentTo.push('tunde@sent.com');
}

describe('preview', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('reads a CSV and names who joins and who is skipped, with the exact lines, and writes nothing', async () => {
    seedExisting(s);
    const before = s.ctx.repo.listPeople().length;
    const p = await preview(s.ctx, { csv: CSV });
    expect(p.added.map((a) => a.name)).toEqual(['Kemi Eze', 'Femi Ade']);
    expect(p.added.map((a) => a.key)).toEqual(['0', '1']);
    expect(p.added.every((a) => a.projectId === s.projectId)).toBe(true);
    expect(p.groups.map((g) => g.line)).toEqual([
      "1 you've emailed before",
      '1 already in Callum',
      '1 asked not to be contacted',
      '1 has no email or LinkedIn',
    ]);
    expect(p.groups.map((g) => g.reason)).toEqual(['known', 'duplicate', 'stopped', 'no_channel']);
    expect(p.groups.map((g) => g.names)).toEqual([['Tunde Bello'], ['Dup One'], ['Ruth Adeleke'], ['Bola']]);
    expect(s.ctx.repo.listPeople()).toHaveLength(before);
    expect(s.scopes).toEqual([]);
  });

  it('names someone who asked to stop even after the user deleted their data, and adds nobody who did', async () => {
    s.ctx.repo.suppress({ email: 'kemi@okopay.com' });
    const p = await preview(s.ctx, { csv: CSV });
    expect(p.added.map((a) => a.name)).not.toContain('Kemi Eze');
    expect(p.groups.find((g) => g.reason === 'stopped')).toMatchObject({ line: '1 asked not to be contacted', names: ['Kemi Eze'] });
  });

  it('says have when more than one person has no way to be reached', async () => {
    const p = await preview(s.ctx, { paste: 'Bola\nSade' });
    expect(p.added).toEqual([]);
    expect(p.groups.map((g) => g.line)).toEqual(['2 have no email or LinkedIn']);
  });

  it('groups people already in another project by that project', async () => {
    const other = s.ctx.repo.insertProject({ name: 'Invoicing' });
    s.ctx.repo.insertPerson({ projectId: other.id, name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'csv' });
    s.ctx.repo.insertPerson({ projectId: other.id, name: 'Femi Ade', email: 'femi@ledgerly.io', source: 'csv' });
    const p = await preview(s.ctx, { csv: CSV });
    expect(p.groups[0]).toMatchObject({ reason: 'other_project', line: '2 are already in Invoicing', projectName: 'Invoicing', names: ['Kemi Eze', 'Femi Ade'] });
    expect(p.added.map((a) => a.name)).toEqual(['Tunde Bello', 'Dup One', 'Ruth Adeleke']);
  });

  it('previews for a project that does not exist yet, where everyone Callum has is in another project', async () => {
    seedExisting(s);
    const p = await preview(s.ctx, { csv: CSV }, { projectId: null });
    expect(p.groups.map((g) => g.line)).toEqual(["1 you've emailed before", '1 is already in Payroll', '1 asked not to be contacted', '1 has no email or LinkedIn']);
    expect(p.added.map((a) => a.name)).toEqual(['Kemi Eze', 'Femi Ade']);
  });

  it('reads a CSV sent as the bytes of the file, the way Excel saves it', async () => {
    const bytes = Buffer.from('Name,Email\nZo\xeb M\xfcller,zoe@example.com\n', 'latin1');
    const p = await preview(s.ctx, { csvBase64: bytes.toString('base64') });
    expect(p.added.map((a) => a.name)).toEqual(['Zoë Müller']);
  });

  it('reads a LinkedIn people search through the LinkedIn adapter', async () => {
    s = setup({ connected: ['email', 'linkedin'] });
    s.linkedin.people = [{ name: 'Ngozi Ibe', source: 'linkedin_search', linkedinUrl: 'https://www.linkedin.com/in/ngozi-ibe' }];
    const url = 'https://www.linkedin.com/search/results/people/?keywords=fintech';
    const p = await preview(s.ctx, { linkedinSearchUrl: url });
    expect(s.linkedin.searched).toEqual([url]);
    expect(p.added.map((a) => a.name)).toEqual(['Ngozi Ibe']);
  });

  it('refuses a link that is not a people search, and says what LinkedIn said when it cannot read one', async () => {
    await expect(preview(s.ctx, { linkedinSearchUrl: 'https://www.linkedin.com/feed/' })).rejects.toThrow(
      new UserError("That isn't a LinkedIn people search. It should start with linkedin.com/search/results/people."),
    );
    s.ctx.repo.updateChannel('linkedin', { status: 'connected', identity: 'ada', connectedAt: MONDAY });
    s.linkedin.fail = new ConnectError('LinkedIn wants you to sign in again.', 'auth');
    await expect(preview(s.ctx, { linkedinSearchUrl: 'https://www.linkedin.com/search/results/people/?keywords=a' })).rejects.toThrow('LinkedIn wants you to sign in again.');
  });

  it('asks for a list when there is none, and says so when a list holds nobody', async () => {
    await expect(preview(s.ctx, {})).rejects.toThrow('Bring a list first');
    await expect(preview(s.ctx, { csv: 'Name,Email\n' })).rejects.toThrow(UserError);
  });

  it('carries on when the mailbox cannot be read', async () => {
    s.ctx.adapters.get('email')!.knownAddresses = async () => { throw new Error('imap down'); };
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    expect(p.added.map((a) => a.name)).toEqual(['Kemi Eze']);
  });
});

describe('commit and undo', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('leaves out someone who asked to stop between the preview and the Add', async () => {
    const p = await preview(s.ctx, { csv: CSV });
    expect(p.added.map((a) => a.name)).toContain('Kemi Eze');
    s.ctx.repo.suppress({ email: 'kemi@okopay.com' });
    const done = await commit(s.ctx, p.batchId);
    expect(done.added.map((a) => a.name)).not.toContain('Kemi Eze');
    expect(s.ctx.repo.listPeople().some((x) => x.email === 'kemi@okopay.com')).toBe(false);
  });

  it('adds the two good rows, and the line says tomorrow at 9:00', async () => {
    seedExisting(s);
    const p = await preview(s.ctx, { csv: CSV });
    s.scopes.length = 0;
    const done = await commit(s.ctx, p.batchId);
    expect(done.added.map((a) => [a.name, a.projectId, a.stage])).toEqual([['Kemi Eze', s.projectId, 'stranger'], ['Femi Ade', s.projectId, 'stranger']]);
    expect(done.line).toBe('2 people join the river. First hellos from tomorrow at 9:00.');
    expect(done.groups.map((g) => g.line)).toEqual(p.groups.map((g) => g.line));
    expect(s.scopes).toContain('people');
    expect(s.ctx.repo.listPeople({ projectId: s.projectId })).toHaveLength(4);
  });

  it('says person when one joins, and Monday when the next weekday is Monday', async () => {
    s.clock.set('2026-11-06T10:00:00.000Z');
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    expect((await commit(s.ctx, p.batchId)).line).toBe('1 person joins the river. First hellos from Monday at 9:00.');
  });

  it('leaves out the people the user said were not a fit', async () => {
    const p = await preview(s.ctx, { csv: CSV });
    const done = await commit(s.ctx, p.batchId, { drop: ['0'] });
    expect(done.added.map((a) => a.name)).toEqual(['Femi Ade', 'Tunde Bello', 'Dup One', 'Ruth Adeleke']);
  });

  it('checks again at the moment of adding: someone who joined in between is skipped', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com\nFemi Ade, femi@ledgerly.io' });
    s.ctx.repo.insertPerson({ projectId: s.projectId, name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'csv' });
    const done = await commit(s.ctx, p.batchId);
    expect(done.added.map((a) => a.name)).toEqual(['Femi Ade']);
    expect(done.groups.map((g) => g.line)).toEqual(['1 already in Callum']);
  });

  it('adds to the project asked for, and not twice', async () => {
    const other = s.ctx.repo.insertProject({ name: 'Invoicing' });
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' }, { projectId: null });
    await expect(commit(s.ctx, p.batchId)).rejects.toThrow('Choose the project they join first.');
    const done = await commit(s.ctx, p.batchId, { projectId: other.id });
    expect(done.added[0]?.projectId).toBe(other.id);
    await expect(commit(s.ctx, p.batchId, { projectId: s.projectId })).rejects.toThrow('Those people are already in.');
  });

  it('answers a second Add for the same project with the first answer, and adds nobody twice', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    const first = await commit(s.ctx, p.batchId);
    s.scopes.length = 0;
    const again = await commit(s.ctx, p.batchId);
    expect(again).toEqual(first);
    expect(s.ctx.repo.listPeople()).toHaveLength(1);
    expect(s.scopes).toEqual([]);
  });

  it('keeps a batch for ten minutes from when it was last used', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    s.clock.advance(BATCH_MS - 1000);
    await sampleHello(s.ctx, { offer: 'You help teams run payroll.', tone: 'warm', batchId: p.batchId, key: '0' });
    s.clock.advance(BATCH_MS - 1000);
    const done = await commit(s.ctx, p.batchId);
    expect(done.added).toHaveLength(1);
    s.clock.advance(BATCH_MS - 1000);
    expect(undoBatch(s.ctx, p.batchId)).toEqual({ removed: 1 });
  });

  it('keeps at most twenty previews, the oldest making room', async () => {
    const first = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    for (let i = 0; i < 20; i++) await preview(s.ctx, { paste: `Person ${i}, p${i}@example.com` });
    await expect(commit(s.ctx, first.batchId)).rejects.toThrow('That list is no longer here. Bring it again.');
  });

  it('turns away a list of more than 5000 people', async () => {
    const paste = Array.from({ length: 5001 }, (_, i) => `Person ${i}, p${i}@example.com`).join('\n');
    await expect(preview(s.ctx, { paste })).rejects.toThrow("That's a lot of people. Add up to 5000 at a time.");
  });

  it('refuses a project that has wrapped up', async () => {
    s.ctx.repo.updateProject(s.projectId, { state: 'wrapped' });
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    await expect(commit(s.ctx, p.batchId)).rejects.toThrow('Payroll is wrapped up.');
  });

  it('adds nobody when the project is wrapped up while the mailbox is read', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    s.ctx.adapters.get('email')!.knownAddresses = async () => {
      s.ctx.repo.updateProject(s.projectId, { state: 'wrapped' });
      return [];
    };
    await expect(commit(s.ctx, p.batchId)).rejects.toThrow('Payroll is wrapped up.');
    expect(s.ctx.repo.listPeople()).toHaveLength(0);
  });

  it('forgets a preview after ten minutes', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    s.clock.advance(BATCH_MS + 1);
    await expect(commit(s.ctx, p.batchId)).rejects.toThrow('That list is no longer here. Bring it again.');
    await expect(commit(s.ctx, 'nope')).rejects.toThrow(UserError);
  });

  it('gives new people in a started project their channel and first slot', async () => {
    s.ctx.repo.updateProject(s.projectId, { startedAt: '2026-11-01T10:00:00.000Z', approvalsLeft: 0 });
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com\nAbena Mensah, linkedin.com/in/abena' });
    const done = await commit(s.ctx, p.batchId);
    expect(done.added[0]).toMatchObject({ name: 'Kemi Eze', channel: 'email', nextTouchAt: '2026-11-03T08:00:00.000Z' });
    expect(done.added[1]).toMatchObject({ name: 'Abena Mensah', channel: null, nextTouchAt: null });
  });

  it('leaves new people alone in a project that has not started, and does not promise hellos', async () => {
    const idle = setup({ started: false });
    const p = await preview(idle.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    const done = await commit(idle.ctx, p.batchId);
    expect(done.added[0]).toMatchObject({ channel: null, nextTouchAt: null });
    expect(done.line).toBe("1 person joins the river. They'll get hellos once Payroll starts.");
  });

  it('says hellos wait for the user to resume a paused project', async () => {
    s.ctx.repo.updateProject(s.projectId, { state: 'paused' });
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com\nFemi Ade, femi@x.com' });
    expect((await commit(s.ctx, p.batchId)).line).toBe("2 people join the river. They'll get hellos once you resume Payroll.");
  });

  it('undo removes the people of the batch that nobody has written to', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com\nFemi Ade, femi@ledgerly.io' });
    const done = await commit(s.ctx, p.batchId);
    s.ctx.repo.insertMessage({ personId: done.added[0]!.id, channel: 'email', direction: 'out', kind: 'hello', subject: 'Hi', body: 'Hi', at: MONDAY, externalId: null });
    s.scopes.length = 0;
    expect(undoBatch(s.ctx, p.batchId)).toEqual({ removed: 1 });
    expect(s.ctx.repo.listPeople().map((x) => x.name)).toEqual(['Kemi Eze']);
    expect(s.scopes).toContain('people');
    expect(() => undoBatch(s.ctx, p.batchId)).toThrow(UserError);
  });

  it('undo frees the person to be added again', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    await commit(s.ctx, p.batchId);
    undoBatch(s.ctx, p.batchId);
    const again = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    expect(again.added.map((a) => a.name)).toEqual(['Kemi Eze']);
    expect(again.groups).toEqual([]);
  });

  it('undo keeps the batch, so the same people can be added again without looking again', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com\nFemi Ade, femi@ledgerly.io' });
    await commit(s.ctx, p.batchId);
    undoBatch(s.ctx, p.batchId);
    expect(s.ctx.repo.listPeople()).toHaveLength(0);
    const again = await commit(s.ctx, p.batchId);
    expect(again.added.map((a) => a.name)).toEqual(['Kemi Eze', 'Femi Ade']);
    // Really added again, not the first answer replayed.
    expect(s.ctx.repo.listPeople().map((p) => p.name).sort()).toEqual(['Femi Ade', 'Kemi Eze']);
    expect(again.added.map((a) => a.id)).toEqual(s.ctx.repo.listPeople().map((p) => p.id).sort((a, b) => a - b));
  });

  it('undo has nothing to take back before the people were added', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    expect(() => undoBatch(s.ctx, p.batchId)).toThrow('Nobody was added from that list.');
  });
});

// ---- describing people (Claude's search) -----------------------------------------------------------------

describe('describe', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('says what is missing when there is no Claude', async () => {
    s.ctx.finder = null;
    const error = await describePeople(s.ctx, { query: 'heads of finance', filters: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe(NO_CLAUDE);
    expect((error as UserError).detail).toEqual({ code: 'no_claude' });
  });

  it('brings back the people Claude found, with full names, and adds nobody yet', async () => {
    const found = fakeFinder();
    s.ctx.finder = found.finder;
    const d = await describePeople(s.ctx, { query: 'Heads of finance at fintechs in Accra', filters: [] });
    expect(d.people).toHaveLength(3);
    expect(d.people[0]).toMatchObject({ key: '0', name: 'Kemi Eze', firstName: 'Kemi', role: 'Head of Finance', company: 'Oko Pay', source: 'web', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze-0' });
    expect(d.narrow).toBeNull();
    expect(d.line).toBe('Callum found 3');
    expect(d.batchId).toEqual(expect.any(String));
    expect(found.asked[0]).toMatchObject({ description: 'Heads of finance at fintechs in Accra', count: DESCRIBE_COUNT });
    expect(s.ctx.repo.listPeople()).toEqual([]);
  });

  it('adds the chips to the words, and tells Claude who is already in Callum', async () => {
    s.ctx.repo.insertPerson({ projectId: s.projectId, name: 'Bola Ade', company: 'Ledgerly', email: 'bola@ledgerly.com', source: 'csv' });
    const found = fakeFinder();
    s.ctx.finder = found.finder;
    await describePeople(s.ctx, { query: 'Heads of finance', filters: ['20 to 200 people', 'Accra only'] });
    expect(found.asked[0]?.description).toBe('Heads of finance, at companies of 20 to 200 people, in Accra only');
    expect(found.asked[0]?.known).toEqual(['Bola Ade (Ledgerly)']);
  });

  it('leaves out people already in Callum, and says so when that is everyone', async () => {
    s.ctx.repo.insertPerson({ projectId: s.projectId, name: 'Kemi Eze', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze-0', source: 'csv' });
    s.ctx.finder = fakeFinder().finder;
    const d = await describePeople(s.ctx, { query: 'cfo', filters: [] });
    expect(d.people.map((p) => p.name)).toEqual(['Femi Ade', 'Tunde Bello']);
    s.ctx.finder = fakeFinder({ people: [foundPerson(0)] }).finder;
    const none = await describePeople(s.ctx, { query: 'cfo', filters: [] });
    expect(none).toEqual({ batchId: null, total: 0, people: [], narrow: null, line: "Everyone Callum found for 'cfo' is already in Callum. Try a wider role or a nearby city." });
  });

  it('says so in the user\'s words when nobody turned up', async () => {
    s.ctx.finder = fakeFinder({ people: [] }).finder;
    const d = await describePeople(s.ctx, { query: 'ops', filters: [] });
    expect(d).toEqual({ batchId: null, total: 0, people: [], narrow: null, line: "Callum found nobody for 'ops' it could reach. Try a wider role or a nearby city." });
  });

  it('passes on what went wrong with Claude, in words', async () => {
    s.ctx.finder = fakeFinder({ fail: "Claude Code isn't signed in on this computer." }).finder;
    await expect(describePeople(s.ctx, { query: 'cfo', filters: [] })).rejects.toThrow("Claude Code isn't signed in on this computer.");
    await expect(describePeople(s.ctx, { query: '  ', filters: [] })).rejects.toThrow('Describe who you want to meet first.');
  });
});

describe('adding people found by description', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('adds the people kept, and leaves out the one that was not a fit', async () => {
    s.ctx.finder = fakeFinder().finder;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    const done = await commit(s.ctx, d.batchId!, { drop: ['1'] });
    expect(done.added.map((a) => [a.name, a.linkedinUrl, a.source, a.note])).toEqual([
      ['Kemi Eze', 'https://www.linkedin.com/in/kemi-eze-0', 'web', 'Leads finance. Found on example.com.'],
      ['Tunde Bello', 'https://www.linkedin.com/in/tunde-bello-2', 'web', 'Leads finance. Found on example.com.'],
    ]);
    expect(done.line).toBe('2 people join the river. First hellos from tomorrow at 9:00.');
  });

  it('checks the Sent folder for people Claude found, too', async () => {
    s.sentTo.push('kemi@okopay.com');
    s.ctx.finder = fakeFinder({ people: [foundPerson(0, { email: 'kemi@okopay.com' }), foundPerson(1), foundPerson(2)] }).finder;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    expect(d.people.map((p) => p.name)).toEqual(['Femi Ade', 'Tunde Bello']);
  });

  it('leaves out someone emailed while the search ran, when the people are added', async () => {
    s.ctx.finder = fakeFinder({ people: [foundPerson(0, { email: 'kemi@okopay.com' }), foundPerson(1)] }).finder;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    expect(d.people.map((p) => p.name)).toEqual(['Kemi Eze', 'Femi Ade']);
    s.sentTo.push('kemi@okopay.com');
    const done = await commit(s.ctx, d.batchId as string);
    expect(done.added.map((p) => p.name)).toEqual(['Femi Ade']);
  });

  it('can be undone', async () => {
    s.ctx.finder = fakeFinder().finder;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    await commit(s.ctx, d.batchId!);
    expect(undoBatch(s.ctx, d.batchId!)).toEqual({ removed: 3 });
  });
});

describe('sampleHello', () => {
  const OFFER = 'You help growing teams run payroll without spreadsheets.';
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('writes to a stand-in before there is anyone', async () => {
    const hello = await sampleHello(s.ctx, { offer: OFFER, tone: 'warm' });
    expect(hello.to).toEqual({ name: 'Kemi Eze', company: 'Oko Pay' });
    expect(hello.body).toContain('Kemi');
    expect(hello.body).toContain('payroll');
  });

  it('writes to the person of the batch the user is looking at, in the tone chosen', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com, Oko Pay\nYaw Mensah, yaw@kumasifoods.com, Kumasi Foods' }, { projectId: null });
    const warm = await sampleHello(s.ctx, { offer: OFFER, tone: 'warm', batchId: p.batchId, key: '1' });
    expect(warm.to).toEqual({ name: 'Yaw Mensah', company: 'Kumasi Foods' });
    expect(warm.body).toContain('Yaw');
    const direct = await sampleHello(s.ctx, { offer: OFFER, tone: 'direct', batchId: p.batchId, key: '1' });
    expect(direct.body).not.toBe(warm.body);
    expect(s.ctx.repo.listProjects().map((x) => x.name)).toEqual(['Payroll']);
  });

  it('writes to a person found by description', async () => {
    s.ctx.finder = fakeFinder().finder;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [], projectId: null });
    const hello = await sampleHello(s.ctx, { offer: OFFER, tone: 'warm', batchId: d.batchId!, key: '1' });
    expect(hello.to).toEqual({ name: 'Femi Ade', company: 'Ledgerly' });
  });

  it('wants an offer and a tone', async () => {
    await expect(sampleHello(s.ctx, { offer: '  ', tone: 'warm' })).rejects.toThrow('Say what you offer first.');
    await expect(sampleHello(s.ctx, { offer: OFFER, tone: 'loud' as never })).rejects.toThrow('Pick warm, direct or playful.');
  });
});

describe('discardProject', () => {
  it('removes a project that never started and has nobody, and moves the current project on', () => {
    const s = setup({ started: false });
    const other = s.ctx.repo.insertProject({ name: 'Invoicing' });
    s.scopes.length = 0;
    expect(discardProject(s.ctx, s.projectId)).toEqual({ discarded: true });
    expect(s.ctx.repo.getProject(s.projectId)).toBeNull();
    expect(s.ctx.repo.getSettings().currentProjectId).toBe(other.id);
    expect(s.scopes).toEqual(expect.arrayContaining(['projects', 'settings']));
  });

  it('leaves a project alone once it has started or has people', () => {
    const started = setup();
    expect(discardProject(started.ctx, started.projectId)).toEqual({ discarded: false });
    const crowded = setup({ started: false });
    crowded.ctx.repo.insertPerson({ projectId: crowded.projectId, name: 'Kemi', email: 'k@x.com', source: 'csv' });
    expect(discardProject(crowded.ctx, crowded.projectId)).toEqual({ discarded: false });
    expect(crowded.ctx.repo.getProject(crowded.projectId)).not.toBeNull();
  });
});
