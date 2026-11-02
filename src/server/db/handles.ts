export function normalizeEmail(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().toLowerCase();
  return v === '' ? null : v;
}

export function normalizeLinkedinUrl(s: string | null | undefined): string | null {
  let rest = (s ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (!rest.startsWith('/')) {
    // The input has a host: it must be linkedin.com or a subdomain of it.
    const host = (/^[^/?#]*/.exec(rest)?.[0] ?? '').replace(/:\d+$/, '').toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
    rest = rest.slice(/^[^/?#]*/.exec(rest)?.[0].length ?? 0);
  }
  const m = /^\/in\/([^/?#\s]+)/i.exec(rest);
  if (!m || !m[1]) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw slug when it is not valid percent-encoding
  }
  slug = slug.toLowerCase();
  return slug === '' ? null : `https://www.linkedin.com/in/${slug}`;
}

export function normalizeXHandle(s: string | null | undefined): string | null {
  let v = (s ?? '').trim();
  v = v.replace(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i, '');
  v = (v.split(/[/?#]/)[0] ?? '').replace(/^@+/, '').toLowerCase();
  return v === '' ? null : v;
}
