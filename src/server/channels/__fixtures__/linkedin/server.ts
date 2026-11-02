// A small local stand-in for the parts of linkedin.com that Callum's adapter drives. It serves pages whose
// markup follows LinkedIn's (aria-labels, class names, dialogs) and records what the pages post back, so a
// test can check what the adapter really did in a real browser. It is test support, never used by the app.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const DIR = new URL('./', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, DIR), 'utf8');

export const VALID_COOKIE = 'valid-li-at';
export const FIXTURE_USER = 'Gabriel Femi';

type Variant = 'connect' | 'more' | 'message' | 'pending' | 'follow';
interface Profile { name: string; headline: string; variant: Variant; limit?: 'on-connect' | 'on-send' }

export const PROFILES: Record<string, Profile> = {
  kemi: { name: 'Kemi Okoye', headline: 'Head of Payments at Okopay', variant: 'connect' },
  tunde: { name: 'Tunde Bello', headline: 'Founder at Lagos Labs', variant: 'more' },
  ada: { name: 'Ada Obi', headline: 'Product lead at Fernhill', variant: 'message' },
  pia: { name: 'Pia Pending', headline: 'Designer', variant: 'pending' },
  celeb: { name: 'Cleo Famous', headline: 'Author and speaker', variant: 'follow' },
  capped: { name: 'Cap Ed', headline: 'Engineer at Ceiling Co', variant: 'connect', limit: 'on-connect' },
  limited: { name: 'Lim Ited', headline: 'Engineer at Ceiling Co', variant: 'connect', limit: 'on-send' },
};

interface Thread { id: string; slug: string; name: string; time: string; snippet: string; messages: string[] }
const THREADS: Thread[] = [
  { id: '2-ada', slug: 'ada', name: 'Ada Obi', time: '10:32 AM', snippet: 'Yes, Thursday at 9:00 works for me.', messages: ['Hi Ada, thanks for connecting.', 'Yes, Thursday at 9:00 works for me.'] },
  { id: '2-kemi', slug: 'kemi', name: 'Kemi Okoye', time: '10:05 AM', snippet: 'You: Thanks for connecting, Kemi.', messages: ['Thanks for connecting, Kemi.'] },
  { id: '2-ben', slug: 'ben-ward', name: 'Ben Ward', time: 'Sun', snippet: 'Sounds good, send me the details.', messages: ['Hi Ben, quick hello.', 'Sounds good, send me the details.'] },
  { id: '2-tunde', slug: 'tunde', name: 'Tunde Bello', time: 'Oct 28', snippet: 'Not right now, thanks.', messages: ['Hi Tunde, quick hello.', 'Not right now, thanks.'] },
];

const SEARCH: Array<Array<{ slug: string; name: string; headline: string }>> = [
  [
    { slug: 'kemi', name: 'Kemi Okoye', headline: 'Head of Payments at Okopay' },
    { slug: 'ACoAAB123hidden', name: 'LinkedIn Member', headline: 'Payments leader' },
    { slug: 'tunde', name: 'Tunde Bello', headline: 'Payments builder and writer' },
  ],
  [{ slug: 'ada', name: 'Ada Obi', headline: 'Product lead @ Fernhill' }],
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const fill = (template: string, values: Record<string, string>) => template.replace(/%%(\w+)%%/g, (_m, key: string) => values[key] ?? '');

export interface LinkedinFixture {
  baseUrl: string;
  /** Invitations the pages posted, in order. */
  invites: Array<{ slug: string; note: string }>;
  /** Direct messages the pages posted, in order. */
  messages: Array<{ slug: string; text: string }>;
  /** Every request path, for checking which pages the adapter visited. */
  hits: string[];
  /** Redirect the connections and messaging pages to a security check. */
  challengeLists: boolean;
  close(): Promise<void>;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function signedIn(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? '').split(/;\s*/).includes(`li_at=${VALID_COOKIE}`);
}

function profilePage(slug: string, p: Profile): string {
  const first = p.name.split(' ')[0] ?? p.name;
  const actions = fill(read(`actions-${p.variant}.html`), { name: esc(p.name), first: esc(first) });
  return fill(read('profile.html'), { slug: esc(slug), name: esc(p.name), headline: esc(p.headline), actions, limit: p.limit ?? '' });
}

function searchPage(pageNo: number): string {
  const rows = SEARCH[pageNo - 1] ?? [];
  if (rows.length === 0) return fill(read('search.html'), { results: '<div class="search-reusable-search-no-results">No results found</div>' });
  const items = rows
    .map(
      (r) => `    <li class="reusable-search__result-container">
      <div class="entity-result">
        <a href="/in/${esc(r.slug)}/?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3A1"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
        <div class="entity-result__content">
          <a href="/in/${esc(r.slug)}/?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3A1"><span dir="ltr"><span aria-hidden="true">${esc(r.name)}</span><span class="visually-hidden">${esc(r.name)}</span></span></a>
          <span class="entity-result__badge-text"><span aria-hidden="true">&bull; 2nd</span></span>
          <div class="entity-result__primary-subtitle t-14 t-black t-normal">${esc(r.headline)}</div>
          <div class="entity-result__secondary-subtitle t-14 t-normal">Lagos, Nigeria</div>
          <p>Mutual connection: <a href="/in/ada/"><span aria-hidden="true">Ada Obi</span></a></p>
        </div>
      </div>
    </li>`,
    )
    .join('\n');
  return fill(read('search.html'), { results: `    <ul role="list">\n${items}\n    </ul>` });
}

export async function startLinkedinFixture(): Promise<LinkedinFixture> {
  const fixture: LinkedinFixture = {
    baseUrl: '',
    invites: [],
    messages: [],
    hits: [],
    challengeLists: false,
    close: async () => undefined,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const path = url.pathname;
    fixture.hits.push(`${req.method} ${path}`);

    if (path === '/site.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return void res.end(read('site.js'));
    }
    if (path === '/login') return html(res, 200, read('login.html'));
    if (path === '/login-submit' && req.method === 'POST') {
      await bodyOf(req);
      return redirect(res, '/feed/', { 'set-cookie': `li_at=${VALID_COOKIE}; Path=/; HttpOnly; Max-Age=31536000` });
    }
    if (path === '/authwall') return html(res, 200, '<!doctype html><title>Sign in</title><h1>Join LinkedIn</h1>');
    if (path.startsWith('/checkpoint/challenge/')) return html(res, 200, read('checkpoint.html'));

    if (!signedIn(req)) return redirect(res, `/authwall?trk=${encodeURIComponent(path)}`);

    if (path === '/feed/') return html(res, 200, fill(read('feed.html'), { me: esc(FIXTURE_USER) }));

    if (path === '/__invite' || path === '/__message') {
      const payload = JSON.parse(await bodyOf(req)) as { slug: string; note?: string; text?: string };
      if (path === '/__invite') {
        if (PROFILES[payload.slug]?.limit === 'on-send') return html(res, 429, 'weekly invitation limit');
        fixture.invites.push({ slug: payload.slug, note: payload.note ?? '' });
      } else {
        fixture.messages.push({ slug: payload.slug, text: payload.text ?? '' });
      }
      return html(res, 200, 'ok');
    }

    const profile = /^\/in\/([^/]+)\/?$/.exec(path);
    if (profile) {
      const slug = profile[1] ?? '';
      if (slug === 'blocked') return redirect(res, '/checkpoint/challenge/AQxyz');
      const data = PROFILES[slug];
      return data ? html(res, 200, profilePage(slug, data)) : html(res, 404, '<!doctype html><title>Page not found</title><h1>This page doesn&rsquo;t exist</h1>');
    }

    if (path === '/mynetwork/invite-connect/connections/' || path === '/messaging/') {
      if (fixture.challengeLists) return redirect(res, '/checkpoint/challenge/AQlists');
      if (path === '/messaging/') {
        const threads = THREADS.map(
          (t) => `      <li class="msg-conversation-listitem">
        <a class="msg-conversation-listitem__link" href="/messaging/thread/${t.id}/">
          <h3 class="msg-conversation-listitem__participant-names msg-conversation-card__participant-names"><span class="truncate">${esc(t.name)}</span></h3>
          <time class="msg-conversation-listitem__time-stamp">${esc(t.time)}</time>
          <p class="msg-conversation-card__message-snippet">${esc(t.snippet)}</p>
        </a>
      </li>`,
        ).join('\n');
        return html(res, 200, fill(read('messaging.html'), { threads }));
      }
      const people = [
        { slug: 'ada', name: 'Ada Obi', when: 'Connected 2 days ago' },
        { slug: 'ben-ward', name: 'Ben Ward', when: 'Connected 3 weeks ago' },
      ];
      const cards = people
        .map(
          (p) => `      <li class="mn-connection-card"><a class="mn-connection-card__link" href="/in/${p.slug}/"><span class="mn-connection-card__name">${esc(p.name)}</span></a><time class="time-badge">${p.when}</time></li>`,
        )
        .join('\n');
      return html(res, 200, fill(read('connections.html'), { count: String(people.length), cards }));
    }

    const thread = /^\/messaging\/thread\/([^/]+)\/?$/.exec(path);
    if (thread) {
      const t = THREADS.find((x) => x.id === thread[1]);
      if (!t) return html(res, 404, 'not found');
      const messages = t.messages.map((m) => `      <li class="msg-s-message-list__event"><div class="msg-s-event-listitem__body">${esc(m)}</div></li>`).join('\n');
      return html(res, 200, fill(read('thread.html'), { slug: esc(t.slug), name: esc(t.name), messages }));
    }

    if (path === '/search/results/people/') return html(res, 200, searchPage(Number(url.searchParams.get('page') ?? '1') || 1));

    return html(res, 404, '<!doctype html><title>Page not found</title><h1>This page doesn&rsquo;t exist</h1>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fixture;
}
