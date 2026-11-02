import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE, findPlaceholders, placeholderMessage, withOptOut } from './guard.js';

describe('findPlaceholders', () => {
  it('finds capitalised brackets and braces in order of appearance', () => {
    expect(findPlaceholders('Our price is [YOUR PRICE] a month, {first_name}')).toEqual(['[YOUR PRICE]', '{first_name}']);
  });
  it('finds double-brace placeholders', () => {
    expect(findPlaceholders('Hi {{ name }}, see {{link}}')).toEqual(['{{ name }}', '{{link}}']);
  });
  it('keeps order across pattern types and drops repeats', () => {
    expect(findPlaceholders('{first_name} [A B] {first_name} [A B] {{x}}')).toEqual(['{first_name}', '[A B]', '{{x}}']);
  });
  it('finds apostrophes and hyphens inside a bracket', () => {
    expect(findPlaceholders("Call [CUSTOMER'S NAME] or [CO-FOUNDER]")).toEqual(["[CUSTOMER'S NAME]", '[CO-FOUNDER]']);
  });
  it('ignores footnotes and markdown links', () => {
    expect(findPlaceholders('Hi Kemi [1]')).toEqual([]);
    expect(findPlaceholders('a [link](x)')).toEqual([]);
  });
  it('returns nothing for clean text', () => {
    expect(findPlaceholders('Hi Kemi, are you free Thursday at 9:00?')).toEqual([]);
  });
});

describe('withOptOut', () => {
  it('uses the exact opt-out line', () => {
    expect(OPT_OUT_LINE).toBe("If this isn't for you, just reply stop and I won't write again.");
  });
  it('appends after a blank line', () => {
    expect(withOptOut('Hello')).toBe(`Hello\n\n${OPT_OUT_LINE}`);
  });
  it('appends only once', () => {
    const once = withOptOut('Hello');
    expect(withOptOut(once)).toBe(once);
  });
});

describe('placeholderMessage', () => {
  it('explains a bracket placeholder', () => {
    expect(placeholderMessage('[YOUR PRICE]')).toBe('Add your price first. Callum never sends a message with [YOUR PRICE] in it.');
  });
  it('does not double "your"', () => {
    expect(placeholderMessage('[BOOKING LINK]')).toBe('Add your booking link first. Callum never sends a message with [BOOKING LINK] in it.');
  });
  it('asks to fill in a brace placeholder', () => {
    expect(placeholderMessage('{first_name}')).toBe('Fill in {first_name} first. Callum never sends a message with {first_name} in it.');
    expect(placeholderMessage('{{first_name}}')).toBe('Fill in {{first_name}} first. Callum never sends a message with {{first_name}} in it.');
  });
});
