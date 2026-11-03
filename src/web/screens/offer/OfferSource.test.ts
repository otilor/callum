import { describe, expect, it } from 'vitest';
import { siteName, withSite } from './OfferSource.js';

describe('the offer from a website', () => {
  it('keeps the website beside the line once, so Callum knows the sender\'s own site', () => {
    expect(withSite('You help founders keep customers.', 'tethers.com')).toBe('You help founders keep customers. (tethers.com)');
    expect(withSite('  You help founders keep customers (Tethers.com)', 'tethers.com')).toBe('You help founders keep customers (Tethers.com)');
    expect(withSite('Payroll for small teams', null)).toBe('Payroll for small teams');
    expect(withSite('   ', 'tethers.com')).toBe('');
  });

  it('names the project after the site', () => {
    expect(siteName('tethers.com')).toBe('Tethers');
    expect(siteName('www.okopay.co.uk')).toBe('Okopay');
  });
});
