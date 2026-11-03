import { describe, expect, it } from 'vitest';
import { findPlaceholders, guardLine, leaveOutLabel, removePlaceholderSentence, splitPlaceholders } from './highlight.js';

describe('splitPlaceholders', () => {
  it('marks exactly what the server guard refuses', async () => {
    const { findPlaceholders: guard } = await import('../../server/engine/guard.js');
    const text = "Hi {first_name}, [YOUR PRICE] and {{company}} and [Ada’s CALL] but not {Plain Words} or [lower].";
    expect(splitPlaceholders(text).filter((p) => p.placeholder).map((p) => p.text)).toEqual(['{first_name}', '[YOUR PRICE]', '{{company}}']);
    expect(findPlaceholders(text)).toEqual(guard(text));
  });

  it('splits text around a placeholder and flags it', () => {
    expect(splitPlaceholders('Our price is [YOUR PRICE] a month.')).toEqual([
      { text: 'Our price is ', placeholder: false },
      { text: '[YOUR PRICE]', placeholder: true },
      { text: ' a month.', placeholder: false },
    ]);
  });

  it('keeps plain text as one part and empty text as none', () => {
    expect(splitPlaceholders('Nothing to fill in.')).toEqual([{ text: 'Nothing to fill in.', placeholder: false }]);
    expect(splitPlaceholders('')).toEqual([]);
  });

  it('finds several placeholders, including curly ones', () => {
    const parts = splitPlaceholders('Hi {{first_name}}, call me at [PHONE NUMBER] or {x}.');
    expect(parts.filter((p) => p.placeholder).map((p) => p.text)).toEqual(['{{first_name}}', '[PHONE NUMBER]', '{x}']);
    expect(parts.map((p) => p.text).join('')).toBe('Hi {{first_name}}, call me at [PHONE NUMBER] or {x}.');
  });

  it('does not treat ordinary brackets as placeholders', () => {
    expect(findPlaceholders('See the deck [attached] and (the notes).')).toEqual([]);
  });
});

describe('findPlaceholders', () => {
  it('lists each placeholder once, in order', () => {
    expect(findPlaceholders('[YOUR PRICE] then [LINK] then [YOUR PRICE]')).toEqual(['[YOUR PRICE]', '[LINK]']);
  });
});

describe('removePlaceholderSentence', () => {
  it('drops the sentence that holds the placeholder', () => {
    expect(removePlaceholderSentence('Happy to help. Our price is [YOUR PRICE] a month. Talk soon.', '[YOUR PRICE]')).toBe('Happy to help. Talk soon.');
  });

  it('works on the first and the last sentence', () => {
    expect(removePlaceholderSentence('It is [YOUR PRICE] a month. Talk soon.', '[YOUR PRICE]')).toBe('Talk soon.');
    expect(removePlaceholderSentence('Happy to help. It is [YOUR PRICE] a month.', '[YOUR PRICE]')).toBe('Happy to help.');
  });

  it('keeps paragraph breaks', () => {
    expect(removePlaceholderSentence('Hi Femi,\n\nIt is [YOUR PRICE] a month.\n\nTalk soon.', '[YOUR PRICE]')).toBe('Hi Femi,\n\nTalk soon.');
  });

  it('removes every sentence that holds it and leaves other text alone', () => {
    expect(removePlaceholderSentence('A. B [X] c. D [X]. E.', '[X]')).toBe('A. E.');
    expect(removePlaceholderSentence('Nothing here.', '[YOUR PRICE]')).toBe('Nothing here.');
  });
});

describe('guard copy', () => {
  it('names the placeholder in the guard line', () => {
    expect(guardLine('[YOUR PRICE]')).toBe('Add your price first. Callum never sends a message with [YOUR PRICE] in it.');
    expect(guardLine('[CALENDAR LINK]')).toBe('Add your calendar link first. Callum never sends a message with [CALENDAR LINK] in it.');
    expect(guardLine('{{first_name}}')).toBe('Fill in {{first_name}} first. Callum never sends a message with {{first_name}} in it.');
  });

  it('labels the quick fix', () => {
    expect(leaveOutLabel('[YOUR PRICE]')).toBe('Leave the price out');
    expect(leaveOutLabel('{x}')).toBe('Leave it out');
  });
});
