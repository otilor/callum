import { domainToASCII } from 'node:url';

const TIMEOUT_MS = 5000;
/** Enough of a page to find its words; a huge page is not read to the end. */
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 2000;

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

function metaDescription(html: string): string | null {
  const found: Record<string, string> = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of tag[0].matchAll(/([a-z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const key = (attrs.name ?? attrs.property ?? '').toLowerCase();
    if ((key === 'description' || key === 'og:description') && attrs.content !== undefined && !(key in found)) found[key] = attrs.content;
  }
  const value = squash(found.description ?? found['og:description'] ?? '');
  return value || null;
}

const DROPPED = 'script|style|noscript|template|svg|head|title|nav|footer|iframe|select|textarea|object|canvas';
const INLINE = 'a|abbr|b|i|em|strong|span|u|small|sup|sub|font|mark|code|s|cite|q';

function visibleText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(new RegExp(`<(${DROPPED})\\b[^>]*>[\\s\\S]*?(?:</\\1\\s*>|$)`, 'gi'), ' ')
    .replace(new RegExp(`</?(?:${INLINE})\\b[^>]*>`, 'gi'), '')
    .replace(/<\/?[a-z!][^>]*>/gi, ' ');
  return squash(stripped).slice(0, MAX_TEXT);
}

function extract(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  return [title ? squash(title) : '', metaDescription(html) ?? '', visibleText(html)].filter(Boolean).join('\n');
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

/**
 * What a company's home page says about itself: its title, description and first words. Used to write an offer line.
 * Returns '' on any failure (no answer in 5 seconds, a page that is not HTML, an error status).
 */
export async function fetchSiteText(domain: string, fetchImpl?: typeof fetch): Promise<string> {
  const trimmed = domain.trim().toLowerCase();
  // Only a bare host name: no scheme, port, path, credentials or address.
  const host = /[\s/\\@:?#]/.test(trimmed) ? '' : domainToASCII(trimmed);
  if (!DOMAIN.test(host)) return '';
  const get = fetchImpl ?? ((input, init) => fetch(input, init));
  try {
    const res = await get(`https://${host}`, {
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (compatible; Callum/1.0)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || (contentType !== '' && !/html|xml/i.test(contentType))) {
      await res.body?.cancel().catch(() => undefined);
      return '';
    }
    const html = decode(await readCapped(res), contentType);
    if (contentType === '' && !/<[a-z!]/i.test(html)) return '';
    return extract(html);
  } catch {
    return '';
  }
}
