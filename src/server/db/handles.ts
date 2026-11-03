export function normalizeEmail(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().toLowerCase();
  return v === '' ? null : v;
}

const SCHEME = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function splitHost(rest: string): { host: string; path: string } {
  const hostPart = /^[^/?#]*/.exec(rest)?.[0] ?? '';
  return { host: hostPart.replace(/:\d+$/, '').toLowerCase(), path: rest.slice(hostPart.length) };
}

export function normalizeLinkedinUrl(s: string | null | undefined): string | null {
  const input = (s ?? '').trim();
  let rest = input.replace(SCHEME, '');
  if (!rest.startsWith('/')) {
    // The input has a host: it must be linkedin.com or a subdomain of it.
    const { host, path } = splitHost(rest);
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
    rest = path;
  }
  const m = /^\/in\/([^/?#]+)/i.exec(rest);
  if (!m || !m[1]) return null;
  // Slugs stay as written (percent escapes are not decoded); anything unsafe, including whitespace, is rejected.
  const slug = m[1].toLowerCase();
  return /^[a-z0-9_%-]+$/.test(slug) ? `https://www.linkedin.com/in/${slug}` : null;
}

export function normalizeXHandle(s: string | null | undefined): string | null {
  const input = (s ?? '').trim();
  let rest = input.replace(SCHEME, '');
  const hasHost = rest.length !== input.length || !/^[@\w]*(?:[/?#]|$)/.test(rest);
  if (hasHost && !rest.startsWith('@')) {
    // A URL: only x.com / twitter.com and their subdomains (www., mobile.) are profile links.
    const { host, path } = splitHost(rest);
    if (!/^(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/.test(host)) return null;
    rest = path.replace(/^\//, '');
  }
  const handle = (rest.split(/[/?#]/)[0] ?? '').replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}
