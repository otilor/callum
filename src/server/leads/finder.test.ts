import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ModelError, type Model, type ResearchOptions } from '../ai/model.js';
import { DemoFinder } from '../demo/finder.js';
import { FindError, ModelFinder, pageShows } from './finder.js';

interface Raw {
  name: string; role?: string | null; company?: string | null; location?: string | null; linkedinUrl?: string | null; xHandle?: string | null;
  email?: string | null; emailSourceUrl?: string | null; sourceUrl?: string; why?: string;
}

const raw = (r: Raw) => ({
  role: null, company: null, location: null, linkedinUrl: null, xHandle: null, email: null, emailSourceUrl: null,
  sourceUrl: 'https://techcabal.com/2026/10/appointments', why: 'Leads finance at a payments company in Lagos.', ...r,
});

interface Asked { user: string; opts: ResearchOptions | undefined }

/** A model whose web research answers from a script, one answer (or failure) per run, and records each prompt. */
function fakeModel(...runs: (Raw[] | Error)[]): { model: Model; asked: Asked[] } {
  const asked: Asked[] = [];
  const model: Model = {
    engine: 'claude_code',
    lastError: null,
    ask: async () => null,
    research: async <S extends z.ZodType>(_schema: S, _system: string, user: string, opts?: ResearchOptions) => {
      asked.push({ user, opts });
      const r = runs[asked.length - 1] ?? [];
      if (r instanceof Error) throw r;
      return { people: r.map(raw) } as z.infer<S>;
    },
  };
  return { model, asked };
}

const pages = (map: Record<string, string>): { fetch: typeof fetch; read: string[] } => {
  const read: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    read.push(url);
    const body = map[url];
    return body === undefined ? new Response('not here', { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { fetch: f, read };
};

const today = () => new Date('2026-11-03T09:00:00.000Z');

describe('ModelFinder', () => {
  it('keeps people with a way to reach them, in the shape Callum stores', async () => {
    const { model } = fakeModel([
      { name: 'Kemi Eze', role: 'Head of Finance', company: 'Oko Pay', linkedinUrl: 'https://ng.linkedin.com/in/Kemi-Eze/?trk=x', why: 'Leads finance at Oko Pay.' },
      { name: 'Tunde Bello', role: 'CFO', company: 'Ledgerly', xHandle: '@tundeb', sourceUrl: 'https://www.ledgerly.com/team' },
      { name: 'Nobody Reachable', role: 'CFO', company: 'Sent' },
    ], []);
    const people = await new ModelFinder(model, pages({}).fetch, today).find({ description: 'Heads of finance in Lagos', count: 3 });
    expect(people).toEqual([
      { name: 'Kemi Eze', role: 'Head of Finance', company: 'Oko Pay', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze', source: 'web', note: 'Leads finance at Oko Pay. Found on techcabal.com.' },
      { name: 'Tunde Bello', role: 'CFO', company: 'Ledgerly', xHandle: 'tundeb', source: 'web', note: 'Leads finance at a payments company in Lagos. Found on ledgerly.com.' },
    ]);
  });

  it('keeps an email only when the page it came from really shows it', async () => {
    const site = pages({
      'https://okopay.com/team': '<p>Write to kemi&#64;okopay.com</p>',
      'https://ledgerly.com/about': '<p>Our team</p>',
    });
    const { model } = fakeModel([
      { name: 'Kemi Eze', email: 'Kemi@OkoPay.com', emailSourceUrl: 'https://okopay.com/team', sourceUrl: 'https://okopay.com/team' },
      { name: 'Tunde Bello', email: 'tunde@ledgerly.com', emailSourceUrl: 'https://ledgerly.com/about', linkedinUrl: 'https://www.linkedin.com/in/tunde' },
      { name: 'Guessed Only', email: 'guessed@sent.co', emailSourceUrl: 'https://sent.co/nothing' },
    ], []);
    const people = await new ModelFinder(model, site.fetch, today).find({ description: 'finance leads', count: 3 });
    expect(people.map((p) => [p.name, p.email ?? null, p.linkedinUrl ?? null])).toEqual([
      ['Kemi Eze', 'kemi@okopay.com', null],
      ['Tunde Bello', null, 'https://www.linkedin.com/in/tunde'],
    ]);
  });

  it('never reads a page on this computer or its network, and needs a public source', async () => {
    const site = pages({});
    const { model } = fakeModel([
      { name: 'Local Page', email: 'a@b.com', emailSourceUrl: 'http://192.168.1.1/admin', sourceUrl: 'http://localhost:4600/api/state' },
      { name: 'Internal Page', linkedinUrl: 'https://www.linkedin.com/in/internal', sourceUrl: 'http://router.lan/' },
      { name: 'Metadata', email: 'x@y.com', emailSourceUrl: 'http://169.254.169.254/latest', sourceUrl: 'https://example.org/team', linkedinUrl: 'https://www.linkedin.com/in/meta' },
      { name: 'File', linkedinUrl: 'https://www.linkedin.com/in/file', sourceUrl: 'file:///etc/passwd' },
    ], []);
    const people = await new ModelFinder(model, site.fetch, today).find({ description: 'anyone', count: 4 });
    expect(people.map((p) => p.name)).toEqual(['Metadata']);
    // The address on the private network was swapped for the public source page, which does not show it.
    expect(site.read).toEqual(['https://example.org/team']);
    expect(people[0]?.email).toBeUndefined();
  });

  it('refuses links in the wrong shape and names that are not names', async () => {
    const { model } = fakeModel([
      { name: 'Ada Obi', linkedinUrl: 'https://www.linkedin.com/company/oko-pay', xHandle: 'not a handle!' },
      { name: '   ', linkedinUrl: 'https://www.linkedin.com/in/blank' },
      { name: '12345', linkedinUrl: 'https://www.linkedin.com/in/digits' },
      { name: 'N/A', linkedinUrl: 'https://www.linkedin.com/in/na' },
      { name: 'Ngozi Okafor', role: 'n/a', company: '', linkedinUrl: 'https://evil.com/in/ngozi' , xHandle: 'ngozi_o' },
    ], []);
    const people = await new ModelFinder(model, pages({}).fetch, today).find({ description: 'anyone', count: 5 });
    expect(people).toEqual([{ name: 'Ngozi Okafor', xHandle: 'ngozi_o', source: 'web', note: 'Leads finance at a payments company in Lagos. Found on techcabal.com.' }]);
  });

  it('runs two searches at once from different ends, and does not bring anyone back twice', async () => {
    const { model, asked } = fakeModel(
      [{ name: 'Kemi Eze', company: 'Oko Pay', linkedinUrl: 'https://www.linkedin.com/in/kemi' }, { name: 'Femi Ade', company: 'Pay Co', linkedinUrl: 'https://www.linkedin.com/in/femi' }],
      [{ name: 'Kemi Eze', company: 'Oko Pay', linkedinUrl: 'https://uk.linkedin.com/in/kemi/' }, { name: 'Tunde Bello', company: 'Ledgerly', xHandle: 'tunde' }],
    );
    const people = await new ModelFinder(model, pages({}).fetch, today).find({ description: 'Founders in Accra', count: 3, known: ['Ada Obi (Ledgerly)'] });
    expect(people.map((p) => p.name)).toEqual(['Kemi Eze', 'Femi Ade', 'Tunde Bello']);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.user).toContain('Start from pages about people');
    expect(asked[1]?.user).toContain('Start from profiles');
    for (const a of asked) {
      expect(a.user).toContain('Who the sender wants to meet: Founders in Accra');
      expect(a.user).toContain('How many to find: 3');
      expect(a.user).toContain('Today: 2026-11-03');
      expect(a.user).toContain('Ada Obi (Ledgerly)');
      expect(a.opts?.maxSearches).toBe(11);
    }
  });

  it('looks once more elsewhere when the first two found too few, leaving out who they found', async () => {
    const { model, asked } = fakeModel(
      [{ name: 'Kemi Eze', company: 'Oko Pay', linkedinUrl: 'https://www.linkedin.com/in/kemi' }],
      [],
      [{ name: 'Femi Ade', company: 'Pay Co', linkedinUrl: 'https://www.linkedin.com/in/femi' }, { name: 'Tunde Bello', linkedinUrl: 'https://www.linkedin.com/in/tunde' }, { name: 'Extra One', linkedinUrl: 'https://www.linkedin.com/in/extra' }],
    );
    const people = await new ModelFinder(model, pages({}).fetch, today).find({ description: 'CFOs', count: 3 });
    expect(people.map((p) => p.name)).toEqual(['Kemi Eze', 'Femi Ade', 'Tunde Bello']);
    expect(asked).toHaveLength(3);
    expect(asked[2]?.user).toContain('How many to find: 2');
    expect(asked[2]?.user).toContain('Kemi Eze (Oko Pay)');
    expect(asked[2]?.user).toContain('Look in places they did not');
  });

  it('does not look again when nobody was found at all, or when the extra search fails', async () => {
    const none = fakeModel([], []);
    expect(await new ModelFinder(none.model, pages({}).fetch, today).find({ description: 'CFOs on Mars', count: 5 })).toEqual([]);
    expect(none.asked).toHaveLength(2);

    const shaky = fakeModel([{ name: 'Kemi Eze', linkedinUrl: 'https://www.linkedin.com/in/kemi' }], [], new ModelError('limit', 'Your Claude plan’s usage limit is reached.'));
    expect((await new ModelFinder(shaky.model, pages({}).fetch, today).find({ description: 'CFOs', count: 5 })).map((p) => p.name)).toEqual(['Kemi Eze']);
  });

  it("keeps one search's people when the other fails, and says why when both fail", async () => {
    const half = fakeModel(new ModelError('failed', 'Claude took too long.'), [{ name: 'Kemi Eze', linkedinUrl: 'https://www.linkedin.com/in/kemi' }]);
    expect((await new ModelFinder(half.model, pages({}).fetch, today).find({ description: 'CFOs', count: 1 })).map((p) => p.name)).toEqual(['Kemi Eze']);

    const signedOut = new ModelError('not_signed_in', "Claude Code isn't signed in on this computer.");
    const both = fakeModel(signedOut, signedOut);
    const err = await new ModelFinder(both.model, pages({}).fetch, today).find({ description: 'CFOs', count: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FindError);
    expect((err as FindError).message).toBe("Claude Code isn't signed in on this computer.");
  });

  it('needs a description, and keeps the count between 1 and 50', async () => {
    const { model, asked } = fakeModel([], []);
    const finder = new ModelFinder(model, pages({}).fetch, today);
    await expect(finder.find({ description: '  ', count: 5 })).rejects.toBeInstanceOf(FindError);
    expect(asked).toHaveLength(0);
    await finder.find({ description: 'CFOs', count: 500 });
    expect(asked[0]?.user).toContain('How many to find: 26');
    expect(asked[0]?.opts?.maxSearches).toBe(25);
  });
});

describe('pageShows', () => {
  it('finds an address written plainly, as an entity, or escaped in a link', () => {
    expect(pageShows('Email KEMI@okopay.com today', 'kemi@okopay.com')).toBe(true);
    expect(pageShows('kemi&#64;okopay.com', 'kemi@okopay.com')).toBe(true);
    expect(pageShows('kemi&#x40;okopay.com', 'kemi@okopay.com')).toBe(true);
    expect(pageShows('kemi&commat;okopay.com', 'kemi@okopay.com')).toBe(true);
    expect(pageShows('<a href="mailto:kemi%40okopay.com">', 'kemi@okopay.com')).toBe(true);
    expect(pageShows('kemi at okopay dot com', 'kemi@okopay.com')).toBe(false);
    expect(pageShows('femi@okopay.com', 'kemi@okopay.com')).toBe(false);
  });
});

describe('DemoFinder', () => {
  it('makes up as many people as asked, each reachable, on addresses that reach nobody', async () => {
    const finder = new DemoFinder();
    const people = await finder.find({ description: 'Heads of finance in Lagos', count: 12 });
    expect(people).toHaveLength(12);
    for (const p of people) {
      expect(p.source).toBe('web');
      expect(p.email || p.linkedinUrl || p.xHandle).toBeTruthy();
      if (p.email) expect(p.email).toMatch(/\.example$/);
      expect(p.note).toContain('made-up');
    }
    expect(people[0]?.role).toBe('Heads of finance');
    // A second search brings different people.
    const more = await finder.find({ description: 'Founders', count: 3 });
    expect(more.map((p) => p.name)).not.toContain(people[0]?.name);
  });
});
