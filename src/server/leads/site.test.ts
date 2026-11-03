import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainOf, fetchSiteText, isPublicAddress, type HostLookup, type SiteOptions } from './site.js';

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Oko Pay &amp; Co | Reconciliation, done</title>
<meta name="viewport" content="width=device-width">
<meta name="description" content="Oko Pay takes reconciliation off your ops team&#39;s plate.">
<style>body { font-family: Onest } .hidden { display:none }</style>
<script>window.dataLayer = []; function track() { return "TRACKING-NOISE"; }</script>
</head><body>
<nav><a href="/">Home</a> <a href="/pricing">NAVIGATION-LINKS</a></nav>
<!-- HIDDEN-COMMENT -->
<h1>Close the books in days, not weeks</h1>
<p>We match every payment to every invoice&nbsp;automatically.</p>
<script type="application/ld+json">{"@type":"Organization","name":"JSON-LD-NOISE"}</script>
<noscript>NOSCRIPT-NOISE</noscript>
<svg><text>SVG-NOISE</text></svg>
<p>Trusted by 400 finance teams across Africa &mdash; and growing.</p>
<footer>FOOTER-LINKS &copy; 2026</footer>
</body></html>`;

let server: Server;
let base: string;
/** What the /huge route did, per request id, so tests running together cannot see each other's numbers. */
const huge = new Map<string, { sent: number; hungUp: boolean }>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://site.test');
    const html = (body: string, type = 'text/html; charset=utf-8') => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    switch (url.pathname) {
      case '/': return html(PAGE);
      case '/redirect': res.writeHead(301, { location: '/' }); return void res.end();
      case '/redirect-twice': res.writeHead(302, { location: '/redirect' }); return void res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return void res.end();
      case '/hop': {
        const n = Number(url.searchParams.get('n'));
        if (n <= 0) return html(PAGE);
        res.writeHead(307, { location: `/hop?n=${n - 1}` });
        return void res.end();
      }
      case '/pdf': return html('%PDF-1.7 not a page', 'application/pdf');
      case '/json': return html('{"title":"nope"}', 'application/json');
      case '/image': return html('GIF89a', 'image/gif');
      case '/missing': res.writeHead(404, { 'content-type': 'text/html' }); return void res.end('<title>Not found</title>');
      case '/error': res.writeHead(500, { 'content-type': 'text/html' }); return void res.end('<title>Oops</title>');
      case '/no-type': res.writeHead(200); return void res.end('<html><head><title>No type</title></head><body>Hello there</body></html>');
      case '/latin1': {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
        return void res.end(Buffer.from('<title>Caf\xe9 M\xfcller</title><p>Cr\xe8me br\xfbl\xe9e</p>', 'latin1'));
      }
      case '/long': return html(`<title>Long</title><body><p>${'word '.repeat(5000)}</p></body>`);
      case '/huge': {
        // 60 MB of visible text, written until the client hangs up.
        const stats = { sent: 0, hungUp: false };
        huge.set(url.searchParams.get('id') ?? '', stats);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head><title>Huge page</title></head><body>');
        const chunk = `<p>${'lorem ipsum dolor sit amet '.repeat(400)}</p>\n`;
        res.on('close', () => { stats.hungUp = stats.sent < 60 * 1024 * 1024; });
        const pump = () => {
          while (stats.sent < 60 * 1024 * 1024) {
            const ok = res.write(chunk);
            stats.sent += chunk.length;
            if (!ok) return void res.once('drain', pump);
          }
          res.end('</body></html>');
        };
        return pump();
      }
      case '/slow': return void setTimeout(() => { if (!res.destroyed) html(PAGE); }, 3000).unref();
      case '/drip': {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head><title>Drip</title></head><body>');
        const t = setInterval(() => { if (res.destroyed) clearInterval(t); else res.write('<p>drop</p>'); }, 20);
        res.on('close', () => clearInterval(t));
        return;
      }
      default: res.writeHead(404); return void res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const PUBLIC = '93.184.216.34';
/** A name server that says every host is on the public internet. */
const publicLookup: HostLookup = async () => [PUBLIC];

/**
 * The real global fetch, with the one host name the code asks for pointed at the local server. The first request
 * (https://site.test) goes to `path`; a redirect to https://site.test/x goes to /x. Each call keeps its own log.
 */
function visit(path = '', opts: SiteOptions = {}) {
  const requested: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const text = fetchSiteText('site.test', (input, init) => {
    const url = String(input);
    requested.push({ url, redirect: init?.redirect });
    return fetch(url === 'https://site.test' ? base + path : url.replace('https://site.test', base), init);
  }, { lookup: publicLookup, ...opts });
  return { text, requested };
}
const site = (path = '', opts: SiteOptions = {}) => visit(path, opts).text;

describe('fetchSiteText against a local web server (real fetch)', () => {
  it('returns the title, the description and the visible text, without scripts, styles, menus or comments', async () => {
    const text = await site();
    const [title, description, body] = text.split('\n');
    expect(title).toBe('Oko Pay & Co | Reconciliation, done');
    expect(description).toBe("Oko Pay takes reconciliation off your ops team's plate.");
    expect(body).toBe('Close the books in days, not weeks We match every payment to every invoice automatically. Trusted by 400 finance teams across Africa — and growing.');
    for (const noise of ['TRACKING-NOISE', 'JSON-LD-NOISE', 'NOSCRIPT-NOISE', 'SVG-NOISE', 'HIDDEN-COMMENT', 'NAVIGATION-LINKS', 'FOOTER-LINKS', 'font-family', '<']) {
      expect(text).not.toContain(noise);
    }
  });

  it('asks for https://<domain> and handles redirects itself', async () => {
    const { text, requested } = visit();
    await text;
    expect(requested).toEqual([{ url: 'https://site.test', redirect: 'manual' }]);
  });

  it('follows redirects, including more than one, one request at a time', async () => {
    expect(await site('/redirect')).toContain('Close the books');
    const twice = visit('/redirect-twice');
    expect(await twice.text).toContain('Close the books');
    expect(twice.requested.map((r) => r.url)).toEqual(['https://site.test', 'https://site.test/redirect', 'https://site.test/']);
  });

  it('follows at most 5 redirects', async () => {
    expect(await site('/hop?n=5')).toContain('Close the books');
    expect(await site('/hop?n=6')).toBe('');
  });

  it('gives back nothing for a redirect loop, a pdf, json, an image, a 404 and a 500', async () => {
    for (const path of ['/loop', '/pdf', '/json', '/image', '/missing', '/error', '/nothing-here']) {
      expect(await site(path), path).toBe('');
    }
  });

  it('reads a page with no content type when it looks like html', async () => {
    expect(await site('/no-type')).toBe('No type\nHello there');
  });

  it('reads the page\'s own character set', async () => {
    expect(await site('/latin1')).toBe('Café Müller\nCrème brûlée');
  });

  it('keeps only the first 2,000 characters of visible text', async () => {
    const [title, body] = (await site('/long')).split('\n');
    expect(title).toBe('Long');
    expect(body).toHaveLength(2000);
    expect(body?.startsWith('word word')).toBe(true);
  });

  it('stops reading a huge page early and still answers', async () => {
    const id = 'huge-1';
    const started = Date.now();
    const text = await site(`/huge?id=${id}`);
    expect(Date.now() - started).toBeLessThan(4000);
    const [title, body] = text.split('\n');
    expect(title).toBe('Huge page');
    expect(body).toHaveLength(2000);
    await waitFor(() => huge.get(id)?.hungUp === true);
    expect(huge.get(id)?.sent).toBeLessThan(30 * 1024 * 1024);
  });

  it('gives up when the server is too slow to answer, after the time it was given', async () => {
    const started = Date.now();
    expect(await site('/slow', { timeoutMs: 150 })).toBe('');
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1500);
  });

  it('gives up when the page trickles in forever', async () => {
    const started = Date.now();
    expect(await site('/drip', { timeoutMs: 200 })).toBe('');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('gives back nothing when nobody is listening', async () => {
    expect(await fetchSiteText('site.test', (input, init) => fetch(String(input).replace('https://site.test', 'http://127.0.0.1:1'), init), { lookup: publicLookup })).toBe('');
  });
});

describe('fetchSiteText: where it is willing to go', () => {
  const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  it('looks the host up first, and asks nothing of a host that is not public', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1']) {
      let asked = 0;
      const out = await fetchSiteText('okopay.com', async () => { asked++; return html('<title>secret</title>'); }, { lookup: async () => [address] });
      expect(out, address).toBe('');
      expect(asked, address).toBe(0);
    }
  });

  it('refuses a host if any one of its addresses is not public, or if it has none, or the lookup fails', async () => {
    let asked = 0;
    const fake: typeof fetch = async () => { asked++; return html('<title>x</title>'); };
    expect(await fetchSiteText('okopay.com', fake, { lookup: async () => [PUBLIC, '10.0.0.5'] })).toBe('');
    expect(await fetchSiteText('okopay.com', fake, { lookup: async () => [] })).toBe('');
    expect(await fetchSiteText('okopay.com', fake, { lookup: async () => { throw new Error('ENOTFOUND'); } })).toBe('');
    expect(asked).toBe(0);
    expect(await fetchSiteText('okopay.com', fake, { lookup: async () => [PUBLIC, '2606:4700::6810:84e5'] })).toBe('x');
  });

  it('gives up when the lookup itself hangs', async () => {
    const started = Date.now();
    expect(await fetchSiteText('okopay.com', async () => html('<title>x</title>'), { timeoutMs: 100, lookup: () => new Promise(() => undefined) })).toBe('');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('checks the host of every redirect, by name and by address', async () => {
    const hosts: string[] = [];
    const lookup: HostLookup = async (h) => { hosts.push(h); return h === 'internal.example' ? ['10.0.0.8'] : [PUBLIC]; };
    const pages: Record<string, () => Response> = {
      'https://okopay.com': () => redirect('https://www.okopay.com/en/'),
      'https://www.okopay.com/en/': () => redirect('/home'),
      'https://www.okopay.com/home': () => html('<title>Home</title><p>Welcome</p>'),
    };
    const fake: typeof fetch = async (input) => pages[String(input)]!();
    expect(await fetchSiteText('okopay.com', fake, { lookup })).toBe('Home\nWelcome');
    expect(hosts).toEqual(['okopay.com', 'www.okopay.com', 'www.okopay.com']);

    for (const location of ['https://internal.example/admin', 'http://127.0.0.1/', 'http://[::1]/', 'https://10.0.0.1/x', 'https://okopay.com:8443/', 'https://user:pw@okopay.com/', 'ftp://okopay.com/', 'javascript:alert(1)', 'https://localhost/']) {
      let asked = 0;
      const out = await fetchSiteText('okopay.com', async (input) => {
        asked++;
        return String(input) === 'https://okopay.com' ? redirect(location) : html('<title>should not be read</title>');
      }, { lookup });
      expect(out, location).toBe('');
      expect(asked, location).toBe(1);
    }
  });

  it('gives back nothing for a redirect with no Location', async () => {
    expect(await fetchSiteText('okopay.com', async () => new Response(null, { status: 302 }), { lookup: publicLookup })).toBe('');
  });
});

describe('isPublicAddress', () => {
  it.each([
    '93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '192.0.1.1', '198.17.0.1', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2a00:1450:4009:81c::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001:4860:4860::8888',
  ])('%s is public', (a) => expect(isPublicAddress(a)).toBe(true));

  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.8.8.8', '100.64.0.1', '100.127.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd00:abcd::1', 'fe80::1', 'fe80::a%eth0', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '64:ff9b::a00:1', '64:ff9b:1::808:808', '64:ff9b:1::1', '::ffff:0:8.8.8.8', '::ffff:0:10.0.0.1', '2002:7f00:1::', '::10.0.0.1', 'not an address', '', '1.2.3', '1.2.3.4.5', '999.1.1.1', '[::1]',
  ])('%s is not', (a) => expect(isPublicAddress(a)).toBe(false));
});

describe('fetchSiteText: broken and hostile pages', () => {
  const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  const read = (body: string) => fetchSiteText('a.example', async () => html(body), { lookup: publicLookup });

  it.each([
    ['unclosed tags', '<a '.repeat(350_000)],
    ['unclosed scripts', '<script '.repeat(130_000)],
    ['unclosed heads and titles', '<head <title '.repeat(80_000)],
    ['unclosed meta tags', '<meta name=description '.repeat(45_000)],
    ['open comments', '<!-- '.repeat(200_000)],
    ['stray less-thans', '<'.repeat(1_000_000)],
    ['tags that close only at the very end', `${'<p class="x" '.repeat(70_000)}>`],
    ['nested drops', '<nav><footer><svg>'.repeat(60_000)],
    ['attributes that go on and on', `<meta ${'a=b '.repeat(300_000)}`],
  ])('a 1 MB page of %s is read in well under half a second', async (_name, chunk) => {
    const page = `<title>T</title>${chunk}`.padEnd(1_000_000, chunk.slice(0, 1) || ' ').slice(0, 1_000_000);
    const started = performance.now();
    const out = await read(page);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.length).toBeLessThan(2100);
  });

  it('a meta tag that is one long run of attribute-name characters is read in linear time', async () => {
    const page = '<title>T</title>' + `<meta ${'a:-_'.repeat(1020)}>`.repeat(64) + '<p>Words</p>';
    const started = performance.now();
    expect(await read(page)).toBe('T\nWords');
    expect(performance.now() - started).toBeLessThan(200);
    // The attributes of an ordinary tag are still read.
    expect(await read('<meta name="description" content="Fine"><p>Words</p>')).toBe('Fine\nWords');
  });

  it('still finds the title and words in a page that is mostly broken', async () => {
    expect(await read(`<title>Real title</title>${'<b '.repeat(10)}<p>Real words</p>`)).toBe('Real title\nReal words');
  });

  it('reads at most 256 KB of a page', async () => {
    const filler = 'x'.repeat(300_000);
    expect(await read(`<title>Early</title><p>${filler}</p><meta name="description" content="late">`)).toBe(`Early\n${'x'.repeat(2000)}`);
  });
});

describe('fetchSiteText with a fake fetch', () => {
  const viaFake = (domain: string, fake: typeof fetch) => fetchSiteText(domain, fake, { lookup: publicLookup });
  const html = (body: string, headers: Record<string, string> = { 'content-type': 'text/html' }) => new Response(body, { status: 200, headers });

  it('extracts title and description from an HTML fixture', async () => {
    const fake: typeof fetch = async () => html('<html><head><title>Oko Pay</title><meta name="description" content="Payments for Africa"></head><body><p>Hello</p></body></html>');
    expect(await viaFake('okopay.com', fake)).toBe('Oko Pay\nPayments for Africa\nHello');
  });

  it('asks for the page with a 5 second signal', async () => {
    let seen: { url: string; signal: AbortSignal | null | undefined } | null = null;
    const fake: typeof fetch = async (input, init) => { seen = { url: String(input), signal: init?.signal }; return html('<title>x</title>'); };
    await viaFake('okopay.com', fake);
    expect(seen).toMatchObject({ url: 'https://okopay.com' });
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
  });

  it.concurrent('gives up after 5 seconds by default', async () => {
    const hangs: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    const started = Date.now();
    expect(await viaFake('okopay.com', hangs)).toBe('');
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(4900);
    expect(took).toBeLessThan(6500);
  }, 15000);

  it('finds the description whichever way the meta tag is written, with og:description as a fallback', async () => {
    const variants = [
      `<meta content="Single quoted" name='description'>`,
      `<META NAME="Description" CONTENT="Upper case">`,
      `<meta property="og:description" content="From Open Graph">`,
    ];
    const got = await Promise.all(variants.map((v) => viaFake('a.example', async () => html(`<head><title>T</title>${v}</head><body>B</body>`))));
    expect(got.map((g) => g.split('\n')[1])).toEqual(['Single quoted', 'Upper case', 'From Open Graph']);
  });

  it('omits parts the page does not have', async () => {
    expect(await viaFake('a.example', async () => html('<body>Just text</body>'))).toBe('Just text');
    expect(await viaFake('a.example', async () => html('<title>Only title</title>'))).toBe('Only title');
    expect(await viaFake('a.example', async () => html(''))).toBe('');
  });

  it('copes with an unclosed script and broken markup', async () => {
    expect(await viaFake('a.example', async () => html('<title>T</title><body>Before<script>var a = "</div>"; and never closed'))).toBe('T\nBefore');
    expect(await viaFake('a.example', async () => html('<title>T</title><p>One<p>Two <b>bold</i> <<>> done'))).toBe('T\nOne Two bold <<>> done');
  });

  it('returns an empty string on any failure, and never throws', async () => {
    expect(await viaFake('a.example', async () => { throw new TypeError('fetch failed'); })).toBe('');
    expect(await viaFake('a.example', async () => new Response('no', { status: 503, headers: { 'content-type': 'text/html' } }))).toBe('');
    expect(await viaFake('a.example', async () => html('<title>x</title>', { 'content-type': 'application/pdf' }))).toBe('');
  });

  it('refuses anything that is not a plain domain name', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => { calls++; return html('<title>should not be asked</title>'); };
    for (const bad of ['', 'localhost', '127.0.0.1', 'okopay.com/path', 'okopay.com@evil.example', 'http://okopay.com', 'ok pay.com', '10.0.0.1', '-bad.example', 'okopay.com:8080', 'okopay.com?x=1', 'okopay.com#x', 'okopay.com\\evil.example']) {
      expect(await viaFake(bad, fake), bad).toBe('');
    }
    expect(calls).toBe(0);
    expect(await viaFake(' OkoPay.COM ', fake)).toBe('should not be asked');
    expect(calls).toBe(1);
  });

  it('uses the global fetch when none is given', async () => {
    const original = globalThis.fetch;
    let asked = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => { asked = String(input); return html('<title>Global</title>'); }) as typeof fetch;
    try {
      expect(await fetchSiteText('okopay.com', undefined, { lookup: publicLookup })).toBe('Global');
      expect(asked).toBe('https://okopay.com');
    } finally { globalThis.fetch = original; }
  });
});

describe('domainOf', () => {
  it('returns the company domain of a work email', () => {
    expect(domainOf('kemi@okopay.com')).toBe('okopay.com');
    expect(domainOf('  Kemi@OkoPay.COM ')).toBe('okopay.com');
    expect(domainOf('kemi@mail.okopay.co.uk')).toBe('mail.okopay.co.uk');
  });

  it('returns null for free mail, and for anything that is not an email', () => {
    for (const e of ['a@gmail.com', 'a@outlook.com', 'a@hotmail.com', 'a@yahoo.com', 'a@icloud.com', 'a@proton.me', 'A@GMAIL.COM', 'a@googlemail.com', 'a@live.com']) {
      expect(domainOf(e), e).toBeNull();
    }
    for (const e of ['', 'nobody', 'a@', '@okopay.com', 'a@localhost', 'a b@okopay.com']) expect(domainOf(e), e).toBeNull();
  });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}
