import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { domainOf, fetchSiteText } from './site.js';

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
let hits: Record<string, number>;
let streamedBytes: number;
let closedEarly: boolean;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    hits[url] = (hits[url] ?? 0) + 1;
    const html = (body: string, type = 'text/html; charset=utf-8') => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    switch (url) {
      case '/': return html(PAGE);
      case '/redirect': res.writeHead(301, { location: '/' }); return void res.end();
      case '/redirect-twice': res.writeHead(302, { location: '/redirect' }); return void res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return void res.end();
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
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head><title>Huge page</title></head><body>');
        const chunk = `<p>${'lorem ipsum dolor sit amet '.repeat(400)}</p>\n`;
        let sent = 0;
        res.on('close', () => { closedEarly = sent < 60 * 1024 * 1024; });
        const pump = () => {
          while (sent < 60 * 1024 * 1024) {
            const ok = res.write(chunk);
            sent += chunk.length;
            streamedBytes = sent;
            if (!ok) return void res.once('drain', pump);
          }
          res.end('</body></html>');
        };
        return pump();
      }
      case '/slow': return void setTimeout(() => { if (!res.destroyed) html(PAGE); }, 9000).unref();
      case '/drip': {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head><title>Drip</title></head><body>');
        const t = setInterval(() => { if (res.destroyed) clearInterval(t); else res.write('<p>drop</p>'); }, 400);
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
beforeEach(() => { hits = {}; streamedBytes = 0; closedEarly = false; });

/** The real global fetch, with the one host name the code asks for pointed at a path on the local server. */
const requested: string[] = [];
const site = (path = '') => fetchSiteText('site.test', (input, init) => {
  requested.push(String(input));
  return fetch(String(input).replace('https://site.test', base + path), init);
});

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

  it('asks for https://<domain>', async () => {
    requested.length = 0;
    await site();
    expect(requested).toEqual(['https://site.test']);
  });

  it('follows redirects, including more than one', async () => {
    expect(await site('/redirect')).toContain('Close the books');
    expect(await site('/redirect-twice')).toContain('Close the books');
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
    const started = Date.now();
    const text = await site('/huge');
    expect(Date.now() - started).toBeLessThan(4000);
    const [title, body] = text.split('\n');
    expect(title).toBe('Huge page');
    expect(body).toHaveLength(2000);
    await vi_waitFor(() => closedEarly);
    expect(streamedBytes).toBeLessThan(30 * 1024 * 1024);
  });

  it.concurrent('gives up after 5 seconds when the server is too slow to answer', async () => {
    const started = Date.now();
    expect(await site('/slow')).toBe('');
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(4900);
    expect(took).toBeLessThan(7000);
  }, 15000);

  it.concurrent('gives up after 5 seconds when the page trickles in forever', async () => {
    const started = Date.now();
    expect(await site('/drip')).toBe('');
    expect(Date.now() - started).toBeLessThan(7000);
  }, 15000);

  it('gives back nothing when nobody is listening', async () => {
    expect(await fetchSiteText('site.test', (input, init) => fetch(String(input).replace('https://site.test', 'http://127.0.0.1:1'), init))).toBe('');
  });
});

describe('fetchSiteText with a fake fetch', () => {
  const html = (body: string, headers: Record<string, string> = { 'content-type': 'text/html' }) => new Response(body, { status: 200, headers });

  it('extracts title and description from an HTML fixture', async () => {
    const fake: typeof fetch = async () => html('<html><head><title>Oko Pay</title><meta name="description" content="Payments for Africa"></head><body><p>Hello</p></body></html>');
    expect(await fetchSiteText('okopay.com', fake)).toBe('Oko Pay\nPayments for Africa\nHello');
  });

  it('asks for the page with a 5 second signal', async () => {
    let seen: { url: string; signal: AbortSignal | null | undefined } | null = null;
    const fake: typeof fetch = async (input, init) => { seen = { url: String(input), signal: init?.signal }; return html('<title>x</title>'); };
    await fetchSiteText('okopay.com', fake);
    expect(seen).toMatchObject({ url: 'https://okopay.com' });
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
  });

  it('finds the description whichever way the meta tag is written, with og:description as a fallback', async () => {
    const variants = [
      `<meta content="Single quoted" name='description'>`,
      `<META NAME="Description" CONTENT="Upper case">`,
      `<meta property="og:description" content="From Open Graph">`,
    ];
    const got = await Promise.all(variants.map((v) => fetchSiteText('a.example', async () => html(`<head><title>T</title>${v}</head><body>B</body>`))));
    expect(got.map((g) => g.split('\n')[1])).toEqual(['Single quoted', 'Upper case', 'From Open Graph']);
  });

  it('omits parts the page does not have', async () => {
    expect(await fetchSiteText('a.example', async () => html('<body>Just text</body>'))).toBe('Just text');
    expect(await fetchSiteText('a.example', async () => html('<title>Only title</title>'))).toBe('Only title');
    expect(await fetchSiteText('a.example', async () => html(''))).toBe('');
  });

  it('copes with an unclosed script and broken markup', async () => {
    expect(await fetchSiteText('a.example', async () => html('<title>T</title><body>Before<script>var a = "</div>"; and never closed'))).toBe('T\nBefore');
    expect(await fetchSiteText('a.example', async () => html('<title>T</title><p>One<p>Two <b>bold</i> <<>> done'))).toBe('T\nOne Two bold <<>> done');
  });

  it('returns an empty string on any failure, and never throws', async () => {
    expect(await fetchSiteText('a.example', async () => { throw new TypeError('fetch failed'); })).toBe('');
    expect(await fetchSiteText('a.example', async () => new Response('no', { status: 503, headers: { 'content-type': 'text/html' } }))).toBe('');
    expect(await fetchSiteText('a.example', async () => html('<title>x</title>', { 'content-type': 'application/pdf' }))).toBe('');
  });

  it('refuses anything that is not a plain domain name', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => { calls++; return html('<title>should not be asked</title>'); };
    for (const bad of ['', 'localhost', '127.0.0.1', 'okopay.com/path', 'okopay.com@evil.example', 'http://okopay.com', 'ok pay.com', '10.0.0.1', '-bad.example', 'okopay.com:8080', 'okopay.com?x=1', 'okopay.com#x', 'okopay.com\\evil.example']) {
      expect(await fetchSiteText(bad, fake), bad).toBe('');
    }
    expect(calls).toBe(0);
    expect(await fetchSiteText(' OkoPay.COM ', fake)).toBe('should not be asked');
    expect(calls).toBe(1);
  });

  it('uses the global fetch when none is given', async () => {
    const original = globalThis.fetch;
    let asked = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => { asked = String(input); return html('<title>Global</title>'); }) as typeof fetch;
    try {
      expect(await fetchSiteText('okopay.com')).toBe('Global');
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

async function vi_waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}
