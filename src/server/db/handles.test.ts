import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizeLinkedinUrl, normalizeXHandle } from './handles.js';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail(' Kemi@OkoPay.com ')).toBe('kemi@okopay.com');
  });
  it('returns null for empty input', () => {
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe('normalizeLinkedinUrl', () => {
  it('reduces every variant to one canonical form', () => {
    const want = 'https://www.linkedin.com/in/kemi-eze';
    expect(normalizeLinkedinUrl('linkedin.com/in/Kemi-Eze/?trk=x')).toBe(want);
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/kemi-eze/')).toBe(want);
    expect(normalizeLinkedinUrl('http://linkedin.com/in/kemi-eze')).toBe(want);
  });
  it('returns null when there is no profile slug', () => {
    expect(normalizeLinkedinUrl('https://linkedin.com/company/oko')).toBeNull();
    expect(normalizeLinkedinUrl('')).toBeNull();
    expect(normalizeLinkedinUrl(null)).toBeNull();
  });
});

describe('normalizeXHandle', () => {
  it('strips @ and profile URL prefixes', () => {
    expect(normalizeXHandle('@KemiEze')).toBe('kemieze');
    expect(normalizeXHandle('https://x.com/kemieze')).toBe('kemieze');
    expect(normalizeXHandle('twitter.com/KemiEze/')).toBe('kemieze');
  });
  it('returns null for empty input', () => {
    expect(normalizeXHandle(' ')).toBeNull();
    expect(normalizeXHandle(undefined)).toBeNull();
  });
});
