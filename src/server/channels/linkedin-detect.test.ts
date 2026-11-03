import { describe, expect, it } from 'vitest';
import {
  SELECTORS, clampNote, degreeOf, lastSender, hasSendFailureText, sameParticipant, headerNameCandidates, isUnavailableProfileText, normalizeText, snippetMatches, hasWeeklyLimitText, humanDelayMs, isBlockedStatus, isCheckpointUrl, isOwnSnippet, isSignInUrl,
  cleanName, memberIdFromHref, parseListTimestamp, profileUrlFromHref, replyProfile, splitHeadline,
} from './linkedin-detect.js';

describe('isCheckpointUrl', () => {
  it('flags checkpoint, challenge, authwall and sign-in pages', () => {
    for (const url of [
      'https://www.linkedin.com/checkpoint/challenge/abc?x=1',
      'https://www.linkedin.com/checkpoint/lg/login-submit',
      'https://www.linkedin.com/authwall?trk=bf',
      'https://www.linkedin.com/uas/login?session_redirect=%2Ffeed',
      'https://www.linkedin.com/login',
      'https://www.linkedin.com/login?fromSignIn=true',
      'https://www.linkedin.com/in/kemi/challenge/',
    ]) expect(isCheckpointUrl(url), url).toBe(true);
  });
  it('leaves ordinary pages alone, even when a name looks similar', () => {
    for (const url of [
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/in/kemi-okoye/',
      'https://www.linkedin.com/in/login-larry/',
      'https://www.linkedin.com/in/challenger-bank/',
      'https://www.linkedin.com/in/challenge-ada/',
      'https://www.linkedin.com/in/checkpoint-charlie/',
      'https://www.linkedin.com/messaging/thread/2-abc/',
      'https://www.linkedin.com/search/results/people/?keywords=login',
    ]) expect(isCheckpointUrl(url), url).toBe(false);
  });
  it('treats a non-URL as not a checkpoint', () => {
    expect(isCheckpointUrl('about:blank')).toBe(false);
    expect(isCheckpointUrl('')).toBe(false);
  });
});

describe('isSignInUrl', () => {
  it('separates an ended session from a security check', () => {
    expect(isSignInUrl('https://www.linkedin.com/login?x=1')).toBe(true);
    expect(isSignInUrl('https://www.linkedin.com/authwall?trk=x')).toBe(true);
    expect(isSignInUrl('https://www.linkedin.com/checkpoint/challenge/abc')).toBe(false);
    expect(isSignInUrl('https://www.linkedin.com/feed/')).toBe(false);
  });
});

describe('hasWeeklyLimitText', () => {
  it('matches the limit wording in any case and with curly apostrophes', () => {
    expect(hasWeeklyLimitText("You've reached the weekly invitation limit")).toBe(true);
    expect(hasWeeklyLimitText('You’ve reached the WEEKLY INVITATION LIMIT. Try again next week.')).toBe(true);
    expect(hasWeeklyLimitText('You have reached the weekly limit for invitations')).toBe(true);
    expect(hasWeeklyLimitText('Weekly   invitation\nlimit')).toBe(true);
  });
  it('does not match ordinary text', () => {
    expect(hasWeeklyLimitText('Invite Kemi to connect')).toBe(false);
    expect(hasWeeklyLimitText('We hit our weekly goal')).toBe(false);
    expect(hasWeeklyLimitText('')).toBe(false);
  });
});

describe('clampNote', () => {
  it('keeps a short note as written', () => {
    expect(clampNote('  Hi Kemi, I enjoyed your talk.  ')).toBe('Hi Kemi, I enjoyed your talk.');
  });
  it('cuts a 400 character note to 200 or fewer, the LinkedIn limit on free accounts at a word boundary without a trailing space', () => {
    const text = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ').slice(0, 400);
    expect(text.length).toBeGreaterThan(200);
    const out = clampNote(text);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/\s$/);
    expect(text.startsWith(out)).toBe(true);
    expect(text[out.length]).toBe(' ');
  });
  it('prefers the last full sentence when it keeps most of the note', () => {
    const first = `${'a'.repeat(150)}.`;
    const text = `${first} ${'b'.repeat(150)} and more words after that`;
    expect(clampNote(text)).toBe(first);
  });
  it('falls back to a word boundary when the only sentence end is early', () => {
    const text = `Hi. ${Array.from({ length: 60 }, () => 'banana').join(' ')}`;
    const out = clampNote(text);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('banana')).toBe(true);
  });
  it('hard-cuts text with no spaces and drops a dangling comma', () => {
    expect(clampNote('x'.repeat(400))).toHaveLength(200);
    expect(clampNote(`${'word '.repeat(39)}end, ${'more '.repeat(20)}`).endsWith(',')).toBe(false);
  });
});

describe('degreeOf', () => {
  it('reads how far away LinkedIn says a person is', () => {
    expect(degreeOf('Arlan Rakhmetzhanov · 3rd\nFounder & CEO at Nozomio')).toBe(3);
    expect(degreeOf('Kemi Okoye\n· 2nd\nHead of Payments')).toBe(2);
    expect(degreeOf('Ada Obi · 1st')).toBe(1);
    expect(degreeOf('Ada Obi 3rd+')).toBe(3);
    expect(degreeOf('Founder at 1stRound Labs')).toBeNull();
    expect(degreeOf('Cleo Famous\nAuthor and speaker')).toBeNull();
  });
});

describe('profileUrlFromHref', () => {
  it('normalizes relative and absolute profile links and rejects others', () => {
    expect(profileUrlFromHref('/in/Kemi-Okoye/?miniProfileUrn=x')).toBe('https://www.linkedin.com/in/kemi-okoye');
    expect(profileUrlFromHref('https://www.linkedin.com/in/ada/')).toBe('https://www.linkedin.com/in/ada');
    expect(profileUrlFromHref('http://127.0.0.1:4000/in/ada/')).toBe('https://www.linkedin.com/in/ada');
    expect(profileUrlFromHref('/company/okopay/')).toBeNull();
    expect(profileUrlFromHref('/messaging/')).toBeNull();
  });
});

describe('splitHeadline', () => {
  it('splits a role from a company at the last " at "', () => {
    expect(splitHeadline('Head of Payments at Okopay')).toEqual({ role: 'Head of Payments', company: 'Okopay' });
    expect(splitHeadline('Chair at the Board at Okopay')).toEqual({ role: 'Chair at the Board', company: 'Okopay' });
    expect(splitHeadline('Founder @ Okopay')).toEqual({ role: 'Founder', company: 'Okopay' });
  });
  it('keeps the whole headline as the role when there is no company', () => {
    expect(splitHeadline('Payments builder and writer')).toEqual({ role: 'Payments builder and writer', company: null });
    expect(splitHeadline('  ')).toEqual({ role: null, company: null });
  });
});

describe('cleanName', () => {
  it('drops degree badges and status text and rejects hidden members', () => {
    expect(cleanName('Kemi Okoye')).toBe('Kemi Okoye');
    expect(cleanName('  Kemi   Okoye • 2nd ')).toBe('Kemi Okoye');
    expect(cleanName('Kemi Okoye\n• 3rd+')).toBe('Kemi Okoye');
    expect(cleanName('Status is online Kemi Okoye')).toBe('Kemi Okoye');
    expect(cleanName('Kemi OkoyeKemi Okoye')).toBe('Kemi Okoye');
    expect(cleanName('LinkedIn MemberLinkedIn Member')).toBeNull();
    expect(cleanName('LinkedIn Member')).toBeNull();
    expect(cleanName('• 2nd')).toBeNull();
    expect(cleanName('')).toBeNull();
  });
});

describe('thread helpers', () => {
  it('knows when the last message is the user\'s own', () => {
    expect(isOwnSnippet('You: Thanks for connecting')).toBe(true);
    expect(isOwnSnippet('  you: ok')).toBe(true);
    expect(isOwnSnippet('Kemi: Sounds good')).toBe(false);
    expect(isOwnSnippet('Thanks, Thursday works')).toBe(false);
  });

  it('turns list timestamps into dates relative to now (local time)', () => {
    const now = new Date(2026, 10, 2, 15, 0, 0); // Monday 2 Nov 2026, local
    expect(parseListTimestamp('10:32 AM', now)).toEqual(new Date(2026, 10, 2, 10, 32));
    expect(parseListTimestamp('12:05 AM', now)).toEqual(new Date(2026, 10, 2, 0, 5));
    expect(parseListTimestamp('12:05 PM', now)).toEqual(new Date(2026, 10, 2, 12, 5));
    expect(parseListTimestamp('Sun', now)).toEqual(new Date(2026, 10, 1, 23, 59, 59)); // the Sunday before this Monday
    expect(parseListTimestamp('Tue', now)).toEqual(new Date(2026, 9, 27, 23, 59, 59)); // 6 days back
    expect(parseListTimestamp('Mon', now)).toEqual(new Date(2026, 9, 26, 23, 59, 59)); // a week back, never today
    expect(parseListTimestamp('Oct 28', now)).toEqual(new Date(2026, 9, 28, 23, 59, 59));
    expect(parseListTimestamp('Dec 30', now)).toEqual(new Date(2025, 11, 30, 23, 59, 59)); // never in the future
    expect(parseListTimestamp('Oct 28, 2025', now)).toEqual(new Date(2025, 9, 28, 23, 59, 59));
    expect(parseListTimestamp('Yesterday', now)).toEqual(new Date(2026, 10, 1, 23, 59, 59));
    expect(parseListTimestamp('', now)).toBeNull();
    expect(parseListTimestamp('whenever', now)).toBeNull();
  });
});

describe('page text helpers', () => {
  it('recognises a profile LinkedIn no longer shows', () => {
    expect(isUnavailableProfileText('This page doesn’t exist')).toBe(true);
    expect(isUnavailableProfileText('This profile is not available')).toBe(true);
    expect(isUnavailableProfileText('Head of Payments at Okopay')).toBe(false);
  });
  it('matches a shortened preview against the opened thread, so a stale panel is never read', () => {
    expect(normalizeText('  a \n b  ')).toBe('a b');
    expect(snippetMatches('Yes, Thursday at 9:00 works for me.', 'Yes, Thursday at 9:00 works for me.')).toBe(true);
    expect(snippetMatches('Yes, Thursday at 9:00 wor…', 'Yes, Thursday at 9:00 works for me.')).toBe(true);
    expect(snippetMatches('Yes, Thursday at 9:00 wor...', 'Yes, Thursday at 9:00 works for me.')).toBe(true);
    expect(snippetMatches('Sounds good', 'Not right now, thanks.')).toBe(false);
    expect(snippetMatches('', 'anything')).toBe(true);
    expect(snippetMatches('   ', 'anything')).toBe(true);
    expect(snippetMatches('Ada: Yes, Thursday…', 'Yes, Thursday at 9:00 works for me.')).toBe(true);
    expect(snippetMatches('Ada Obi: Yes, Thursday at 9:00 works for me.', 'Yes, Thursday at 9:00 works for me.')).toBe(true);
    expect(snippetMatches('You: Thanks for connecting', 'Thanks for connecting, Ada.')).toBe(true);
    expect(snippetMatches('Yes,\u200b Thursday at 9:00', 'Yes, Thursday at 9:00 works for me.')).toBe(true);
    expect(snippetMatches('Yes, Thursday at 9:00 works for me and I would like to add more', 'Yes, Thursday')).toBe(true);
    expect(snippetMatches('Ada: Not right now', 'Yes, Thursday at 9:00 works for me.')).toBe(false);
    expect(snippetMatches('Yes, Thursday', '')).toBe(false);
  });
});

describe('sameParticipant', () => {
  it('compares the list name with the open thread, tolerating extras and unreadable names', () => {
    expect(sameParticipant('Ada Obi', 'Ada Obi')).toBe(true);
    expect(sameParticipant('Ada Obi', 'ada obi, MBA')).toBe(true);
    expect(sameParticipant('Ada Obi • 1st', 'Ada Obi')).toBe(true);
    expect(sameParticipant('Ada Obi', 'Ben Ward')).toBe(false);
    expect(sameParticipant('', 'Ben Ward')).toBe(true);
    expect(sameParticipant('Ada Obi', '')).toBe(true);
  });
});

describe('lastSender', () => {
  const who = { participantName: 'Ada Obi', selfName: 'Gabriel Femi', selfUrl: 'https://www.linkedin.com/in/gabriel' };
  const none = { itemClass: null, groupName: null, groupHref: null };
  it('reads incoming items by the "other" class', () => {
    expect(lastSender({ ...none, itemClass: 'msg-s-event-listitem msg-s-event-listitem--other' }, who)).toBe('other');
  });
  it('uses the group header: the user\'s name or profile link means self, the participant\'s name means other', () => {
    expect(lastSender({ ...none, groupName: 'Gabriel Femi' }, who)).toBe('self');
    expect(lastSender({ ...none, groupHref: '/in/gabriel/' }, who)).toBe('self');
    expect(lastSender({ ...none, groupName: 'Ada Obi' }, who)).toBe('other');
    expect(lastSender({ ...none, groupName: 'Ada Obi', groupHref: '/in/ada/' }, who)).toBe('other');
  });
  it('treats a recognised item without the "other" class as the user\'s own', () => {
    expect(lastSender({ ...none, itemClass: 'msg-s-event-listitem' }, who)).toBe('self');
  });
  it('says unknown when the page does not tell, so nothing is reported', () => {
    expect(lastSender(none, who)).toBe('unknown');
    expect(lastSender({ ...none, groupName: 'Someone Else' }, who)).toBe('unknown');
    expect(lastSender({ ...none, itemClass: 'something-new' }, who)).toBe('unknown');
    expect(lastSender({ ...none, groupName: 'Ada Obi' }, { ...who, participantName: '' })).toBe('unknown');
  });
});

describe('hasSendFailureText', () => {
  it('spots LinkedIn failure marks next to a message', () => {
    expect(hasSendFailureText('Message failed to send. Try again.')).toBe(true);
    expect(hasSendFailureText("We couldn’t send your message")).toBe(true);
    expect(hasSendFailureText('Hello there, thanks for connecting')).toBe(false);
    // A bare "retry" is ordinary wording; it is never read from a message anyway.
    expect(hasSendFailureText('Hello there, thanks for the retry on the demo')).toBe(false);
  });
});

describe('headerNameCandidates', () => {
  it('offers the full name first, then the name without credentials', () => {
    expect(headerNameCandidates('Ada Obi')).toEqual(['Ada Obi']);
    expect(headerNameCandidates(' Ada  Obi, MBA ')).toEqual(['Ada Obi, MBA', 'Ada Obi']);
    expect(headerNameCandidates('')).toEqual([]);
  });
});

describe('pacing and blocks', () => {
  it('waits between 4 and 11 seconds', () => {
    expect(humanDelayMs(() => 0)).toBe(4000);
    expect(humanDelayMs(() => 0.5)).toBe(7500);
    expect(humanDelayMs(() => 0.999999)).toBeLessThanOrEqual(11_000);
  });
  it('reads LinkedIn status 999 as a block', () => {
    expect(isBlockedStatus(999)).toBe(true);
    expect(isBlockedStatus(200)).toBe(false);
  });
});

describe('SELECTORS', () => {
  it('holds only non-empty lists of non-empty alternatives', () => {
    for (const [name, value] of Object.entries(SELECTORS)) {
      expect(Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0), name).toBe(true);
    }
  });
  it('has no comma unions: alternatives are separate entries', () => {
    for (const [name, list] of Object.entries(SELECTORS)) for (const sel of list) expect(sel.includes(', '), `${name}: ${sel}`).toBe(false);
  });
});

describe('member-id profile addresses', () => {
  it('reads the member id with its letter case, from any form of the link', () => {
    expect(memberIdFromHref('/in/ACoAABcdEf123/')).toBe('ACoAABcdEf123');
    expect(memberIdFromHref('https://www.linkedin.com/in/ACoAABcdEf123')).toBe('ACoAABcdEf123');
    expect(memberIdFromHref('/in/ACoAABcdEf123/?miniProfileUrn=urn%3Ali')).toBe('ACoAABcdEf123');
  });
  it('is null for a vanity address, anything else, or nothing', () => {
    for (const href of ['/in/kemi-eze/', 'https://www.linkedin.com/in/acorn-co', '/in/Acosta/', '/company/ACoAA', '', 'not a url at all %%']) {
      expect(memberIdFromHref(href), href).toBeNull();
    }
  });

  it('keeps a vanity address as it is and never looks anything up', async () => {
    let looked = 0;
    const who = await replyProfile('/in/kemi-eze/', async () => { looked++; return null; });
    expect(who).toEqual({ url: 'https://www.linkedin.com/in/kemi-eze' });
    expect(looked).toBe(0);
  });

  it('resolves a member-id address to the vanity address and keeps the member-id form beside it', async () => {
    const asked: string[] = [];
    const who = await replyProfile('/in/ACoAABcdEf123/', async (id) => { asked.push(id); return 'https://www.linkedin.com/in/kemi-eze/'; });
    expect(asked).toEqual(['ACoAABcdEf123']);
    expect(who).toEqual({ url: 'https://www.linkedin.com/in/kemi-eze', alt: 'https://www.linkedin.com/in/acoaabcdef123' });
  });

  it('falls back to the member-id address when it cannot be resolved, so a person stored under it still matches', async () => {
    const expected = { url: 'https://www.linkedin.com/in/acoaabcdef123' };
    expect(await replyProfile('/in/ACoAABcdEf123/', async () => null)).toEqual(expected);
    expect(await replyProfile('/in/ACoAABcdEf123/', async () => { throw new Error('offline'); })).toEqual(expected);
    // Landing on the same member-id address (no redirect) is not a resolution.
    expect(await replyProfile('/in/ACoAABcdEf123/', async () => 'https://www.linkedin.com/in/ACoAABcdEf123/')).toEqual(expected);
  });

  it('is null when there is no link', async () => {
    expect(await replyProfile('', async () => 'https://www.linkedin.com/in/x')).toBeNull();
  });
});
