export function normalizeEmail(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().toLowerCase();
  return v === '' ? null : v;
}

export function normalizeLinkedinUrl(s: string | null | undefined): string | null {
  const m = /\/in\/([^/?#\s]+)/i.exec((s ?? '').trim());
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
  v = v.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^@+/, '');
  v = v.toLowerCase();
  return v === '' ? null : v;
}
