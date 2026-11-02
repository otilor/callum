import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const TIMEOUT_MS = 5000;
/** Enough of a page to find its words; a huge page is not read to the end. */
const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 2000;
const MAX_REDIRECTS = 5;
/** A tag longer than this is not a tag. */
const TAG_MAX = 4096;

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'pm.me', 'aol.com',
]);
const FREE_MAIL_REGIONAL = /^(?:hotmail|outlook|live|yahoo)\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/** The company site behind a work email, or null for free mail and anything that is not an email. */
export function domainOf(email: string): string | null {
  const m = /^[^\s@]+@([^\s@]+)$/.exec(email.trim());
  const domain = m?.[1]?.toLowerCase();
  if (!domain || !DOMAIN.test(domain)) return null;
  return FREE_MAIL.has(domain) || FREE_MAIL_REGIONAL.test(domain) ? null : domain;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', euro: '€', pound: '£',
  eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', ccedil: 'ç',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,8}));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex ?? '', 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const squash = (s: string): string => decodeEntities(s).replace(/\s+/g, ' ').trim();

/** Finds the next ">" at or after a position without ever scanning the same stretch twice. */
class TagEnds {
  private at = -1;
  constructor(private readonly s: string) {}
  next(from: number): number {
    if (this.at < from) {
      const i = this.s.indexOf('>', from);
      this.at = i === -1 ? Number.POSITIVE_INFINITY : i;
    }
    return this.at;
  }
}

/** ASCII-only lower case, so positions in the result are positions in the original. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

function metaDescription(html: string, lower: string, ends: TagEnds): string | null {
  const found: Record<string, string> = {};
  let pos = 0;
  for (let seen = 0; seen < 300; seen++) {
    const at = lower.indexOf('<meta', pos);
    if (at === -1) break;
    pos = at + 5;
    if (!/[\s/>]/.test(lower.charAt(pos))) continue;
    const end = ends.next(at);
    if (end === Number.POSITIVE_INFINITY) break;
    if (end - at > TAG_MAX) continue;
    const attrs: Record<string, string> = {};
    for (const a of html.slice(at, end + 1).matchAll(/(?<![a-z_:-])([a-z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const key = (attrs.name ?? attrs.property ?? '').toLowerCase();
    if ((key === 'description' || key === 'og:description') && attrs.content !== undefined && !(key in found)) found[key] = attrs.content;
  }
  const value = squash(found.description ?? found['og:description'] ?? '');
  return value || null;
}

function titleOf(html: string, lower: string, ends: TagEnds): string | null {
  let at = lower.indexOf('<title');
  while (at !== -1 && /[a-z0-9]/.test(lower.charAt(at + 6))) at = lower.indexOf('<title', at + 6);
  if (at === -1) return null;
  const end = ends.next(at);
  if (end === Number.POSITIVE_INFINITY || end - at > TAG_MAX) return null;
  const close = lower.indexOf('</title', end);
  if (close === -1) return null;
  return squash(html.slice(end + 1, close).slice(0, 1000)) || null;
}

/** Elements whose content is not words on the page (or is page furniture). */
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'title', 'nav', 'footer', 'iframe', 'select', 'textarea', 'object', 'canvas']);
/** Elements that sit inside a word or sentence, so their tags leave no gap. */
const INLINE = new Set(['a', 'abbr', 'b', 'i', 'em', 'strong', 'span', 'u', 'small', 'sup', 'sub', 'font', 'mark', 'code', 's', 'cite', 'q']);
/** If one of these is never closed, only its own tag is skipped; the rest of the page is still words. */
const LENIENT = new Set(['head', 'title']);

/** The visible words of a page, in a single pass over the text (no backtracking, however broken the markup). */
function visibleText(html: string, lower: string, ends: TagEnds): string {
  const out: string[] = [];
  const unclosed = new Set<string>();
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      const e = lower.indexOf('-->', lt + 4);
      out.push(' ');
      i = e === -1 ? n : e + 3;
      continue;
    }
    const m = /^<(\/?)([a-z][a-z0-9]*|!)/.exec(lower.slice(lt, lt + 40));
    const end = m ? ends.next(lt) : Number.POSITIVE_INFINITY;
    if (!m || end === Number.POSITIVE_INFINITY || end - lt > TAG_MAX) { out.push('<'); i = lt + 1; continue; }
    const name = m[2]!;
    i = end + 1;
    if (m[1] === '' && DROPPED.has(name) && html.charAt(end - 1) !== '/') {
      const close = unclosed.has(name) ? -1 : lower.indexOf(`</${name}`, end + 1);
      if (close === -1) {
        unclosed.add(name);
        if (!LENIENT.has(name)) i = n;
      } else {
        const closeEnd = ends.next(close);
        i = closeEnd === Number.POSITIVE_INFINITY ? n : closeEnd + 1;
      }
      out.push(' ');
      continue;
    }
    out.push(INLINE.has(name) ? '' : ' ');
  }
  return squash(out.join('')).slice(0, MAX_TEXT);
}

function extract(raw: string): string {
  const html = raw.slice(0, MAX_BYTES);
  const lower = asciiLower(html);
  // One scanner per pass: each only ever moves forward.
  return [
    titleOf(html, lower, new TagEnds(html)) ?? '',
    metaDescription(html, lower, new TagEnds(html)) ?? '',
    visibleText(html, lower, new TagEnds(html)),
  ].filter(Boolean).join('\n');
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  if (size >= MAX_BYTES) await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, MAX_BYTES);
}

function decode(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const label = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ---- who we are willing to talk to --------------------------------------------------------------

function ipv4Octets(address: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const octets = m ? m.slice(1).map(Number) : null;
  return octets && octets.every((o) => o <= 255) ? octets : null;
}

function isPublicV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol and documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  return true;
}

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let a = address.toLowerCase().split('%')[0] ?? '';
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted) {
    const o = ipv4Octets(dotted[1]!);
    if (!o) return null;
    a = a.slice(0, -dotted[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const left = toGroups(halves[0] ?? '');
  const right = toGroups(halves[1] ?? '');
  const fill = 8 - left.length - right.length;
  if (halves.length === 1 ? left.length !== 8 : fill < 1) return null;
  const groups = halves.length === 1 ? left : [...left, ...Array<number>(fill).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True only for an address on the public internet: not loopback, private, link-local, CGNAT, unique-local or reserved. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicV4(ipv4Octets(address)!);
  if (kind !== 6) return false;
  const g = ipv6Groups(address);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => isPublicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // "::", "::1", IPv4-mapped (::ffff:a.b.c.d) and the old IPv4-compatible form.
    return g[5] === 0xffff ? embedded(g[6]!, g[7]!) : false;
  }
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return false; // IPv4-translated (SIIT) ::ffff:0:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // NAT64: the well-known /96 carries a public IPv4 address; the local-use 64:ff9b:1::/48 does not.
    return g.slice(2, 6).every((x) => x === 0) ? embedded(g[6]!, g[7]!) : false;
  }
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // site-local, deprecated
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return true;
}

/** Every address a host name points to. Injectable so tests need no network. */
export type HostLookup = (host: string) => Promise<string[]>;
const systemLookup: HostLookup = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface SiteOptions {
  /** How long the whole read may take, redirects and body included. Default 5 seconds. */
  timeoutMs?: number;
  lookup?: HostLookup;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A host name that is safe to ask for: a plain public-looking domain, not an address, port or credentials. */
function plainHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  const host = /[\s/\\@:?#]/.test(trimmed) ? '' : domainToASCII(trimmed);
  return DOMAIN.test(host) ? host : null;
}

/**
 * What a company's home page says about itself: its title, description and first words. Used to write an offer line.
 * Returns '' on any failure (no answer in 5 seconds, a page that is not HTML, an error status). Redirects are
 * followed by hand, at most 5, and every host on the way must be a plain domain whose addresses are all public.
 * Known limit: the name is resolved here and again by `fetch`, so a DNS-rebinding host could still slip through. That is
 * accepted because the only domain read is the user's own (their email's domain).
 */
export async function fetchSiteText(domain: string, fetchImpl?: typeof fetch, opts: SiteOptions = {}): Promise<string> {
  const first = plainHost(domain);
  if (!first) return '';
  const get = fetchImpl ?? ((input, init) => fetch(input, init));
  const lookup = opts.lookup ?? systemLookup;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  timedOut.catch(() => undefined);
  try {
    let host = first;
    let url = `https://${first}`;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await Promise.race([lookup(host), timedOut]);
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) return '';
      const res = await get(url, {
        redirect: 'manual',
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (compatible; Callum/1.0)' },
        signal,
      });
      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location) return '';
        const next = new URL(location, url);
        const nextHost = plainHost(next.hostname);
        if ((next.protocol !== 'https:' && next.protocol !== 'http:') || next.port !== '' || next.username !== '' || next.password !== '' || !nextHost) return '';
        host = nextHost;
        url = next.href;
        continue;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || (contentType !== '' && !/html|xml/i.test(contentType))) {
        await res.body?.cancel().catch(() => undefined);
        return '';
      }
      const html = decode(await readCapped(res), contentType);
      if (contentType === '' && !/<[a-z!]/i.test(html)) return '';
      return extract(html);
    }
    return '';
  } catch {
    return '';
  }
}
