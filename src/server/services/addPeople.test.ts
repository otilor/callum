import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectError } from '../channels/types.js';
import { commit, connectApollo, describe as describePeople, discardProject, preview, sampleHello, undoBatch, BATCH_MS } from './addPeople.js';
import { fakeApollo, matchRow, MONDAY, setup, type Setup } from './addPeople.test-helpers.js';
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

  it('undo has nothing to take back before the people were added', async () => {
    const p = await preview(s.ctx, { paste: 'Kemi Eze, kemi@okopay.com' });
    expect(() => undoBatch(s.ctx, p.batchId)).toThrow('Nobody was added from that list.');
  });
});

// ---- Apollo -----------------------------------------------------------------------------------------------

describe('describe', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('says what is missing when Apollo is not connected', async () => {
    const error = await describePeople(s.ctx, { query: 'heads of finance', filters: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe('Describing people needs a people search connected. Bring a list instead, or connect Apollo in Your Callum.');
    expect((error as UserError).detail).toEqual({ code: 'no_apollo' });
  });

  it('brings back free preview rows and spends nothing', async () => {
    const apollo = fakeApollo({ total: 3 });
    s.ctx.apollo = apollo.source;
    const d = await describePeople(s.ctx, { query: 'Heads of finance at fintechs in Accra', filters: [] });
    expect(d.people).toHaveLength(3);
    expect(d.people[0]).toMatchObject({ key: 'apollo-0', apolloId: 'apollo-0', hasEmail: true, name: 'Kemi Ez***', firstName: 'Kemi', role: 'Head of Finance', company: 'Oko Pay', source: 'apollo' });
    expect(d.narrow).toBeNull();
    expect(d.line).toBe('Callum found 3');
    expect(d.batchId).toEqual(expect.any(String));
    expect(apollo.calls.enrich).toEqual([]);
    expect(apollo.calls.search[0]?.searchParams.get('q_keywords')).toBe('Heads of finance at fintechs');
    expect(apollo.calls.search[0]?.searchParams.getAll('person_locations[]')).toEqual(['Accra']);
  });

  it('offers to narrow a search that matches more than a thousand people', async () => {
    s.ctx.apollo = fakeApollo({ total: 2300 }).source;
    const d = await describePeople(s.ctx, { query: 'Heads of finance at fintechs in Accra', filters: [] });
    expect(d.total).toBe(2300);
    expect(d.narrow).toEqual(['20 to 200 people']);
    expect(d.line).toBe("That's about 2,300 people. Narrow it down?");
  });

  it('never offers a city chip, because a city the words end with is already a filter, and leaves out chips already used', async () => {
    s.ctx.apollo = fakeApollo({ total: 2300 }).source;
    expect((await describePeople(s.ctx, { query: 'Heads of finance', filters: [] })).narrow).toEqual(['20 to 200 people']);
    const again = await describePeople(s.ctx, { query: 'Heads of finance in Accra', filters: ['20 to 200 people'] });
    expect(again.narrow).toBeNull();
  });

  it('sends the chips to Apollo as real filters, with the city out of the keywords', async () => {
    const apollo = fakeApollo({ total: 2300 });
    s.ctx.apollo = apollo.source;
    await describePeople(s.ctx, { query: 'Heads of finance in Accra', filters: ['20 to 200 people', 'Accra only'] });
    const url = apollo.calls.search[0]!;
    expect(decodeURIComponent(url.search)).toContain('organization_num_employees_ranges[]=21,200');
    expect(url.searchParams.getAll('person_locations[]')).toEqual(['Accra']);
    expect(url.searchParams.get('q_keywords')).toBe('Heads of finance');
  });

  it('pulls a city the words end with into a location filter, with no chip pressed', async () => {
    const apollo = fakeApollo({ total: 3 });
    s.ctx.apollo = apollo.source;
    await describePeople(s.ctx, { query: 'Founders in Cape Town', filters: [] });
    expect(apollo.calls.search[0]?.searchParams.getAll('person_locations[]')).toEqual(['Cape Town']);
    expect(apollo.calls.search[0]?.searchParams.get('q_keywords')).toBe('Founders');
    expect(apollo.calls.search[0]?.searchParams.has('organization_num_employees_ranges[]')).toBe(false);
  });

  it('refuses a chip Callum did not offer', async () => {
    const apollo = fakeApollo({ total: 2300 });
    s.ctx.apollo = apollo.source;
    const error = await describePeople(s.ctx, { query: 'Heads of finance', filters: ['Seed to Series A'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect(apollo.calls.search).toEqual([]);
  });

  it('says so in the user\'s words when nobody matched', async () => {
    s.ctx.apollo = fakeApollo({ rows: 0 }).source;
    const d = await describePeople(s.ctx, { query: 'ops', filters: [] });
    expect(d).toEqual({ batchId: null, total: 0, people: [], narrow: null, line: "Nobody matched 'ops'. Try a wider role or a nearby city." });
  });

  it('passes on what Apollo said when it refuses', async () => {
    s.ctx.apollo = fakeApollo({ failSearch: 401 }).source;
    await expect(describePeople(s.ctx, { query: 'cfo', filters: [] })).rejects.toThrow("Apollo didn't accept the API key. Check it in Your Callum.");
    await expect(describePeople(s.ctx, { query: '  ', filters: [] })).rejects.toThrow('Describe who you want to meet first.');
  });
});

describe('adding people found by description', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('shows 3 rows with no credits spent, drops one, then enriches exactly the 2 kept and names the credits', async () => {
    const apollo = fakeApollo({ total: 3 });
    s.ctx.apollo = apollo.source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    expect(d.people).toHaveLength(3);
    expect(apollo.calls.enrich).toEqual([]);

    const done = await commit(s.ctx, d.batchId!, { drop: ['apollo-1'] });
    expect(apollo.calls.enrich).toEqual([['apollo-0', 'apollo-2']]);
    expect(done.added.map((a) => [a.name, a.email, a.source])).toEqual([['Kemi Eze', 'kemi@co0.com', 'apollo'], ['Tunde Bello', 'tunde@co2.com', 'apollo']]);
    expect(done.creditsUsed).toBe(2);
    expect(done.line).toBe('2 people join the river. First hellos from tomorrow at 9:00. That used 2 Apollo credits.');
    expect(done.warning).toBeUndefined();
  });

  it('shows people with no email or LinkedIn after the look-up as skipped', async () => {
    const apollo = fakeApollo({ total: 3, enrich: (ids) => ids.map((id) => (id === 'apollo-1' ? matchRow(id, { email: null, email_status: 'unavailable', linkedin_url: null }) : matchRow(id))) });
    s.ctx.apollo = apollo.source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    const done = await commit(s.ctx, d.batchId!);
    expect(done.added.map((a) => a.name)).toEqual(['Kemi Eze', 'Tunde Bello']);
    expect(done.groups).toEqual([{ reason: 'no_channel', line: '1 has no email or LinkedIn', names: ['Femi Ade'] }]);
    expect(done.creditsUsed).toBe(3);
    expect(done.line).toContain('That used 3 Apollo credits.');
  });

  it('says one credit in the singular', async () => {
    s.ctx.apollo = fakeApollo({ total: 3 }).source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    const done = await commit(s.ctx, d.batchId!, { drop: ['apollo-1', 'apollo-2'] });
    expect(done.line).toBe('1 person joins the river. First hellos from tomorrow at 9:00. That used 1 Apollo credit.');
  });

  it('spends nothing when everyone was dropped', async () => {
    const apollo = fakeApollo({ total: 3 });
    s.ctx.apollo = apollo.source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    await expect(commit(s.ctx, d.batchId!, { drop: ['apollo-0', 'apollo-1', 'apollo-2'] })).rejects.toThrow('Everyone was left out. Bring someone back.');
    expect(apollo.calls.enrich).toEqual([]);
  });

  it('keeps the people already looked up when Apollo fails part way, and says why', async () => {
    const apollo = fakeApollo({ total: 12, rows: 12, failEnrichAt: 2, failStatus: 429 });
    s.ctx.apollo = apollo.source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    const done = await commit(s.ctx, d.batchId!);
    expect(apollo.calls.enrich.map((ids) => ids.length)).toEqual([10, 2]);
    expect(done.added).toHaveLength(10);
    expect(done.creditsUsed).toBe(10);
    expect(done.warning).toBe("Apollo's lookup limit is reached. Try again in an hour.");
    expect(done.line).toBe('10 people join the river. First hellos from tomorrow at 9:00. That used 10 Apollo credits.');
    expect(done.remaining).toBe(2);
  });

  it('adds the rest later, looking up only the two that were left', async () => {
    const apollo = fakeApollo({ total: 12, rows: 12, failEnrichAt: 2, failStatus: 429 });
    s.ctx.apollo = apollo.source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    await commit(s.ctx, d.batchId!);
    const rest = await commit(s.ctx, d.batchId!);
    expect(apollo.calls.enrich.map((ids) => ids.length)).toEqual([10, 2, 2]);
    expect(apollo.calls.enrich[2]).toEqual(['apollo-10', 'apollo-11']);
    expect(rest.added).toHaveLength(2);
    expect(rest.remaining).toBeUndefined();
    expect(s.ctx.repo.listPeople()).toHaveLength(12);
    expect(undoBatch(s.ctx, d.batchId!)).toEqual({ removed: 12 });
  });

  it('checks the Sent folder for people Apollo found, too', async () => {
    s.sentTo.push('kemi@co0.com');
    s.ctx.apollo = fakeApollo({ total: 3 }).source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    const done = await commit(s.ctx, d.batchId!);
    expect(done.added.map((a) => a.name)).toEqual(['Femi Ade', 'Tunde Bello']);
    expect(done.groups.map((g) => g.line)).toEqual(["1 you've emailed before"]);
  });

  it('lets an error that is not Apollo\'s through, instead of hiding it', async () => {
    const source = fakeApollo({ total: 3 }).source;
    s.ctx.apollo = source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    source.enrich = async () => { throw new TypeError('database is gone'); };
    await expect(commit(s.ctx, d.batchId!)).rejects.toThrow(TypeError);
  });

  it('adds nobody and says why when Apollo fails at the first step', async () => {
    s.ctx.apollo = fakeApollo({ total: 3, failEnrichAt: 1, failStatus: 401 }).source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    await expect(commit(s.ctx, d.batchId!)).rejects.toThrow("Apollo didn't accept the API key. Check it in Your Callum.");
    expect(s.ctx.repo.listPeople()).toEqual([]);
    // The batch is still there to try again.
    s.ctx.apollo = fakeApollo({ total: 3 }).source;
    expect((await commit(s.ctx, d.batchId!)).added).toHaveLength(3);
  });

  it('can be undone, credits and all', async () => {
    s.ctx.apollo = fakeApollo({ total: 3 }).source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [] });
    await commit(s.ctx, d.batchId!);
    expect(undoBatch(s.ctx, d.batchId!)).toEqual({ removed: 3 });
  });
});

describe('connectApollo', () => {
  it('stores the key after a test search works, and uses it from then on', async () => {
    const s = setup();
    const apollo = fakeApollo({ total: 1, rows: 1 });
    const result = await connectApollo(s.ctx, '  key-123 ', (key) => {
      expect(key).toBe('key-123');
      return apollo.source;
    });
    expect(result).toEqual({ connected: true });
    expect(apollo.calls.search).toHaveLength(1);
    expect(apollo.calls.search[0]?.searchParams.get('per_page')).toBe('1');
    expect(s.ctx.repo.getChannelSecret('apollo')).toEqual({ key: 'key-123' });
    expect(s.ctx.apollo).toBe(apollo.source);
  });

  it('stores nothing when the key is not accepted, and never repeats the key', async () => {
    const s = setup();
    const bad = fakeApollo({ failSearch: 401 });
    await expect(connectApollo(s.ctx, 'secret-key', () => bad.source)).rejects.toThrow("Apollo didn't accept the API key. Check it in Your Callum.");
    expect(s.ctx.repo.getChannelSecret('apollo')).toBeNull();
    expect(s.ctx.apollo).toBeNull();
    await expect(connectApollo(s.ctx, '   ')).rejects.toThrow('Paste your Apollo API key first.');
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

  it('writes to a person found by description with a first name and a company only', async () => {
    s.ctx.apollo = fakeApollo({ total: 3 }).source;
    const d = await describePeople(s.ctx, { query: 'heads of finance', filters: [], projectId: null });
    const hello = await sampleHello(s.ctx, { offer: OFFER, tone: 'warm', batchId: d.batchId!, key: 'apollo-1' });
    expect(hello.to).toEqual({ name: 'Femi', company: 'Ledgerly' });
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
