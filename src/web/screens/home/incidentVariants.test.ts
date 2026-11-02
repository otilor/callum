import { describe, expect, it } from 'vitest';
import { appState, channel, incident, NOW, outboxItem, person } from '../../test/fixtures.js';
import { allVariants, faceReactions, incidentVariant, stopVariants, whenText, waitingOn } from './incidentVariants.js';

const state = appState();

describe('whenText', () => {
  it('says today, yesterday, the weekday and then the date', () => {
    expect(whenText('2026-11-03T08:14:00.000Z', 'Africa/Lagos', NOW)).toBe('Today at 9:14');
    expect(whenText('2026-11-02T14:20:00.000Z', 'Africa/Lagos', NOW)).toBe('Yesterday at 15:20');
    expect(whenText('2026-10-29T13:20:00.000Z', 'Africa/Lagos', NOW)).toBe('Thursday at 14:20');
    expect(whenText('2026-10-20T13:20:00.000Z', 'Africa/Lagos', NOW)).toBe('20 October at 14:20');
  });
});

describe('signed out', () => {
  const waiting = [person(1, 'Ada One', { nextTouchAt: '2026-11-04T08:00:00.000Z' }), person(2, 'Bo Two', { nextTouchAt: '2026-11-04T08:00:00.000Z' }), person(3, 'Cy Three', { channel: 'linkedin', nextTouchAt: '2026-11-04T08:00:00.000Z' })];
  const mail = incident(1, 'mailbox_signed_out', {
    message: 'Google signed Callum out of gabriel@yourcompany.com. 2 emails are waiting and nothing was lost.',
  });

  it('says what happened, what Callum did and the one next step, with reconnect as the action', () => {
    const v = incidentVariant(mail, appState({ people: waiting }), NOW);
    expect(v).toMatchObject({
      key: 'signed_out', title: 'Google signed Callum out', when: 'Today at 9:14', waitIds: [1, 2], waitLine: '2 people wait for email. Nothing is lost.',
      primary: { label: 'Reconnect Google', action: { kind: 'reconnect', channel: 'email' } }, secondary: null,
    });
    expect(v?.lines).toEqual([
      { kind: 'what', text: 'Google signed Callum out of gabriel@yourcompany.com. This usually follows a password change.' },
      { kind: 'did', text: 'Callum paused email. 2 emails are waiting and nothing was lost. LinkedIn and X keep going.' },
      { kind: 'next', text: 'Reconnect Google to send them.' },
    ]);
  });

  it('works for LinkedIn and X too', () => {
    const li = incident(2, 'mailbox_signed_out', { channel: 'linkedin', message: 'LinkedIn signed Callum out. Connect LinkedIn again from Your Callum.' });
    const v = incidentVariant(li, appState({ people: waiting, channels: [channel('email'), channel('linkedin', 'error'), channel('x')] }), NOW);
    expect(v?.title).toBe('LinkedIn signed Callum out');
    expect(v?.primary.label).toBe('Reconnect LinkedIn');
    expect(v?.waitIds).toEqual([3]);
  });
});

describe('bounces', () => {
  const people = [person(5, 'Fi One'), person(6, 'Fi Two'), person(7, 'Fi Three')];
  const bounce = incident(3, 'bounces', {
    message: '3 addresses at fieldnote.com bounced. Callum removed them and will try LinkedIn for those people.',
    detail: JSON.stringify({ domain: 'fieldnote.com', people: [{ id: 5, fallback: 'linkedin' }, { id: 6, fallback: 'linkedin' }, { id: 7, fallback: null }] }),
  });

  it('offers Okay, and Skip them instead for the people who moved to another channel', () => {
    const v = incidentVariant(bounce, appState({ people }), NOW);
    expect(v?.title).toBe('3 emails bounced');
    expect(v?.lines.map((l) => l.text)).toEqual([
      "3 addresses at fieldnote.com don't exist anymore.",
      'Callum removed them and will try LinkedIn for those people. Your address is safe.',
      "Nothing to do. Skip them if you'd rather not.",
    ]);
    expect(v?.primary).toEqual({ label: 'Okay', action: { kind: 'dismiss' } });
    expect(v?.secondary).toEqual({ label: 'Skip them instead', action: { kind: 'skip_bounced', personIds: [5, 6] } });
    expect(v?.waitLine).toBe('3 people at fieldnote.com');
  });

  it('has nothing to skip when nobody had another way to be reached', () => {
    const none = incident(4, 'bounces', {
      message: '1 address at x.com bounced. Callum removed it.', detail: JSON.stringify({ domain: 'x.com', people: [{ id: 5, fallback: null }] }),
    });
    const v = incidentVariant(none, state, NOW);
    expect(v?.secondary).toBeNull();
    expect(v?.title).toBe('1 email bounced');
    expect(v?.lines[0]?.text).toBe("1 address at x.com doesn't exist anymore.");
  });
});

describe('X limit', () => {
  it('says messages resume tomorrow and offers Okay and Raise the X plan', () => {
    const x = incident(5, 'x_limit', { channel: 'x', message: "X stopped accepting Callum's messages because your X plan's daily limit is reached. DMs resume tomorrow at 9:00." });
    const s = appState({
      channels: [channel('email'), channel('linkedin'), channel('x', 'paused', { pausedUntil: '2026-11-03T23:00:00.000Z' })],
      people: [person(1, 'Xa One', { channel: 'x', xHandle: 'xa', nextTouchAt: '2026-11-04T08:00:00.000Z' })],
    });
    const v = incidentVariant(x, s, NOW);
    expect(v?.title).toBe('X stopped taking messages');
    expect(v?.lines.map((l) => l.text)).toEqual([
      "X stopped accepting Callum's messages because your X plan's daily limit is reached.",
      'Callum paused X until tomorrow. Email and LinkedIn keep going.',
      'Nothing to do. Messages resume tomorrow at 9:00.',
    ]);
    expect(v?.waitLine).toBe('1 person waits for X. Nothing is lost.');
    expect(v?.secondary).toMatchObject({ label: 'Raise the X plan', action: { kind: 'link' } });
  });
});

describe('mailbox limit', () => {
  it('says email is held until tomorrow, names the time, and asks for nothing', () => {
    const limit = incident(5, 'mailbox_limit', {
      channel: 'email',
      message: 'Your mailbox reached its daily sending limit, so Callum paused email until tomorrow. Nothing is lost and replies keep arriving.',
    });
    const s = appState({
      channels: [channel('email', 'connected', { pausedUntil: '2026-11-03T23:00:00.000Z' }), channel('linkedin'), channel('x')],
      people: [person(1, 'Ea One', { nextTouchAt: '2026-11-04T08:00:00.000Z' }), person(2, 'Eb Two', { nextTouchAt: '2026-11-04T08:00:00.000Z' })],
      incidents: [limit],
    });
    const v = incidentVariant(limit, s, NOW);
    expect(v?.title).toBe('Your mailbox reached its daily limit');
    expect(v?.lines.map((l) => l.text)).toEqual([
      'Your mailbox reached its daily sending limit, so Callum paused email until tomorrow.',
      'Callum paused email until tomorrow. LinkedIn and X keep going.',
      'Nothing to do. Email resumes tomorrow at 9:00.',
    ]);
    expect(v?.waitLine).toBe('2 people wait for email. Nothing is lost.');
    expect(v?.primary).toMatchObject({ label: 'Okay', action: { kind: 'dismiss' } });
    expect(faceReactions(s).get(1)).toMatchObject({ mark: 'pause', label: 'waiting' });
  });
});

describe('failed reply', () => {
  const failed = incident(6, 'send_failed', {
    personId: 9, message: "Your reply to Tomás didn't go out: Gmail says the mailbox is full. It's saved here.", detail: JSON.stringify({ outboxId: 31 }),
  });
  const s = appState({
    people: [person(9, 'Tomás Ortega')],
    outbox: [outboxItem(31, 9, { state: 'failed', body: "Hi Tomás, Thursday at 14:00 works well.", error: 'mailbox full' })],
  });

  it('keeps the reply word for word, with Try again and Copy', () => {
    const v = incidentVariant(failed, s, NOW);
    expect(v).toMatchObject({ key: 'send_failed', title: "Your reply to Tomás didn't go out", quote: 'Hi Tomás, Thursday at 14:00 works well.' });
    expect(v?.lines.map((l) => l.text)).toEqual([
      'Gmail says the mailbox is full.',
      "Callum kept your reply here, word for word, and won't send Tomás anything else until you decide.",
      'Try again, or copy it and send it another way.',
    ]);
    expect(v?.primary).toEqual({ label: 'Try again', action: { kind: 'retry', outboxId: 31, first: 'Tomás' } });
    expect(v?.secondary).toEqual({ label: 'Copy', action: { kind: 'copy', text: 'Hi Tomás, Thursday at 14:00 works well.', first: 'Tomás' } });
    expect(v?.icon.personId).toBe(9);
  });

  it('is not drawn once the message is gone from the outbox', () => {
    expect(incidentVariant(failed, appState({ people: s.people }), NOW)).toBeNull();
  });
});

describe('weekly limit', () => {
  const limit = incident(7, 'linkedin_weekly_limit', {
    channel: 'linkedin', message: "LinkedIn's weekly invite limit is reached. New invites wait until Monday. Messages to your connections keep going.",
  });
  const invitees = [1, 2].map((i) => person(i, `Li ${i}`, { channel: 'linkedin', linkedinUrl: `https://linkedin.com/in/li${i}` }));

  it('offers to move the waiting people to email', () => {
    const v = incidentVariant(limit, appState({ people: invitees }), NOW);
    expect(v?.title).toBe("LinkedIn's weekly limit");
    expect(v?.lines.map((l) => l.text)).toEqual([
      "LinkedIn's weekly invite limit is reached.",
      'New invites wait until Monday. Messages to your connections keep going.',
      'Nothing to do, or move the 2 waiting people to email.',
    ]);
    expect(v?.primary).toEqual({
      label: 'Move these 2 to email',
      action: { kind: 'switch_channel', action: { kind: 'switch_channel', label: 'Move 2 to email', args: { personIds: [1, 2], channel: 'email' } }, projectId: 1 },
    });
    expect(v?.secondary).toEqual({ label: 'Wait until Monday', action: { kind: 'dismiss' } });
    expect(v?.waitLine).toBe('2 invites wait until Monday');
  });

  it('only offers the people of the project on screen', () => {
    const other = person(9, 'Li Nine', { projectId: 2, channel: 'linkedin', linkedinUrl: 'https://linkedin.com/in/li9' });
    const v = incidentVariant(limit, appState({ people: [...invitees, other] }), NOW);
    expect(v?.waitIds).toEqual([1, 2]);
    expect(v?.primary.label).toBe('Move these 2 to email');
    const onTwo = appState({ people: [...invitees, other] });
    onTwo.settings = { ...onTwo.settings, currentProjectId: 2 };
    const w = incidentVariant(limit, onTwo, NOW);
    expect(w?.waitIds).toEqual([9]);
    expect(w?.primary).toMatchObject({ label: 'Move this 1 to email', action: { projectId: 2 } });
  });

  it('only says Okay when there is nobody to move or email is not connected', () => {
    expect(incidentVariant(limit, state, NOW)?.primary.label).toBe('Okay');
    const noMail = appState({ people: invitees, channels: [channel('email', 'disconnected'), channel('linkedin'), channel('x')] });
    expect(incidentVariant(limit, noMail, NOW)).toMatchObject({ primary: { label: 'Okay' }, secondary: null });
  });
});

describe('someone said stop', () => {
  const ruth = person(11, 'Ruth Mensah', { status: 'stopped', replyKind: 'stop', repliedAt: '2026-11-03T06:31:00.000Z', lastInbound: 'Please take me off your list.' });

  it('is a quiet card with nothing to decide', () => {
    const [v] = stopVariants(appState({ people: [ruth] }), NOW);
    expect(v).toMatchObject({ key: 'stop', title: 'Ruth asked not to be contacted', quote: 'Please take me off your list.', when: 'Today at 7:31', primary: { label: 'Okay' }, secondary: null });
    expect(v?.lines.map((l) => l.text)).toEqual(["Callum stopped everything and won't reach out again. It stays in Ruth's history.", 'Nothing to do.']);
  });

  it('is shown for a day', () => {
    expect(stopVariants(appState({ people: [{ ...ruth, repliedAt: '2026-11-01T06:31:00.000Z' }] }), NOW)).toEqual([]);
  });
});

describe('allVariants', () => {
  it('draws open incidents and stop cards, and leaves the LinkedIn check to IncidentCard', () => {
    const s = appState({
      people: [person(11, 'Ruth Mensah', { status: 'stopped', replyKind: 'stop', repliedAt: '2026-11-03T06:31:00.000Z' })],
      incidents: [incident(1, 'linkedin_check', { channel: 'linkedin', message: 'x' }), incident(2, 'x_limit', { channel: 'x', message: 'X stopped.', state: 'resolved' }), incident(3, 'x_limit', { channel: 'x', message: 'X stopped.' })],
    });
    expect(allVariants(s, NOW).map((v) => v.id)).toEqual(['incident-3', 'stop-11-2026-11-03T06:31:00.000Z']);
  });
});

describe('faceReactions', () => {
  it('holds the people who wait for a stopped channel, and marks the ones whose reply failed', () => {
    const s = appState({
      people: [
        person(1, 'Ada One', { nextTouchAt: '2026-11-04T08:00:00.000Z' }),
        person(2, 'Bo Two', { channel: 'linkedin', nextTouchAt: '2026-11-04T08:00:00.000Z' }),
        person(9, 'Tomás Ortega', { stage: 'talking' }),
      ],
      incidents: [
        incident(1, 'mailbox_signed_out', { message: 'Google signed Callum out of a@b.com.' }),
        incident(2, 'send_failed', { personId: 9, message: 'x', detail: '{"outboxId":1}' }),
      ],
    });
    const r = faceReactions(s);
    expect(r.get(1)).toMatchObject({ mark: 'pause', still: true });
    expect(r.has(2)).toBe(false);
    expect(r.get(9)).toMatchObject({ mark: 'error', errorRing: true });
  });

  it('marks bounced people who moved channel, people who asked to stop, who is away and who was introduced', () => {
    const s = appState({
      people: [person(5, 'Fi One'), person(11, 'Ruth Mensah', { status: 'stopped', replyKind: 'stop', repliedAt: '2026-11-03T06:31:00.000Z' }), person(20, 'Kemi Eze'), person(21, 'Sam Bello')],
      incidents: [incident(3, 'bounces', { message: 'b', detail: JSON.stringify({ domain: 'x.com', people: [{ id: 5, fallback: 'linkedin' }, { id: 6, fallback: null }] }) })],
    });
    const quiet = {
      projectId: 1, empty: false, day2: null, used: null, paused: null,
      away: [{ personId: 20, projectId: 1, projectName: null, first: 'Kemi', name: 'Kemi Eze', company: null, role: null, until: '2026-11-20', followUpAt: null, text: '', at: '' }],
      referrals: [{ personId: 21, projectId: 1, projectName: null, first: 'Sam', name: 'Sam Bello', company: null, referrer: null, context: null, channel: 'email' as const, subject: null, draft: '' }],
    };
    const r = faceReactions(s, quiet, NOW);
    expect(r.get(5)).toMatchObject({ mark: 'in', label: 'moved to LinkedIn' });
    expect(r.has(6)).toBe(false);
    expect(r.get(11)).toMatchObject({ mark: 'stop', faded: true });
    expect(r.get(20)).toMatchObject({ mark: 'away', still: true });
    expect(r.get(21)).toMatchObject({ mark: 'intro' });
  });

  it('is empty when nothing is wrong', () => {
    expect(faceReactions(appState({ people: [person(1, 'Ada One')] })).size).toBe(0);
    expect(waitingOn([person(1, 'Ada One')], 'email')).toEqual([]);
  });
});

describe('the kinds the runner opens on its own', () => {
  it('an X or LinkedIn sign-out is a signed-out card that reconnects that channel', () => {
    const x = incidentVariant(incident(1, 'x_signed_out', { channel: 'x', message: 'X signed Callum out. 3 messages are waiting and nothing was lost.' }), appState(), NOW);
    expect(x).toMatchObject({ key: 'signed_out', title: 'X signed Callum out', primary: { label: 'Reconnect X', action: { kind: 'reconnect', channel: 'x' } } });
    const li = incidentVariant(incident(2, 'linkedin_signed_out', { channel: 'linkedin', message: 'LinkedIn signed Callum out. 1 message is waiting and nothing was lost.' }), appState(), NOW);
    expect(li).toMatchObject({ key: 'signed_out', title: 'LinkedIn signed Callum out', primary: { action: { kind: 'reconnect', channel: 'linkedin' } } });
  });

  it('holds those channels\' people still, like the other sign-outs', () => {
    const waiting = person(1, 'Ada One', { channel: 'x', nextTouchAt: '2026-11-04T08:00:00.000Z' });
    const reactions = faceReactions(appState({ people: [waiting], incidents: [incident(1, 'x_signed_out', { channel: 'x', message: 'X signed Callum out.' })] }), null, NOW);
    expect(reactions.get(1)).toMatchObject({ mark: 'pause', still: true });
  });

  it('a reply Callum could not read opens the person, or just says Okay when there is no one to open', () => {
    const kemi = person(1, 'Kemi Eze');
    const named = incidentVariant(incident(1, 'reply_unread', { message: "Callum couldn't read a reply from Kemi. It's on your dock.", personId: 1 }), appState({ people: [kemi] }), NOW);
    expect(named).toMatchObject({ key: 'reply_unread', title: "Callum couldn't read a reply from Kemi", primary: { label: "Open Kemi's conversation", action: { kind: 'open_person', personId: 1 } } });
    const unnamed = incidentVariant(incident(2, 'reply_unread', { message: "Callum couldn't read a reply on email. Check it by hand." }), appState(), NOW);
    expect(unnamed?.primary).toEqual({ label: 'Okay', action: { kind: 'dismiss' } });
  });

  it('a channel that is not answering offers to connect it again and clears itself', () => {
    const v = incidentVariant(incident(1, 'not_answering', { channel: 'linkedin', message: "LinkedIn isn't answering. Callum will keep trying." }), appState(), NOW);
    expect(v).toMatchObject({ key: 'not_answering', title: "LinkedIn isn't answering", primary: { label: 'Connect LinkedIn again', action: { kind: 'reconnect', channel: 'linkedin' } }, secondary: { label: 'Okay' } });
    expect(v?.lines[1]?.text).toContain('clears itself');
  });
});
