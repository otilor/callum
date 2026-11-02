import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayPerson, Project, QuietSnapshot, ReferralCard } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { pickMoment, Quiet, starterChips, type QuietProps } from './Quiet.js';

const mocks = vi.hoisted(() => ({
  ask: vi.fn(), act: vi.fn(), undo: vi.fn(), pause: vi.fn(), resumeAll: vi.fn(), realReply: vi.fn(), referralHello: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api.js')>()),
  api: { ask: mocks.ask, act: mocks.act, undo: mocks.undo, pause: mocks.pause, resumeAll: mocks.resumeAll },
  noteApi: { realReply: mocks.realReply, referralHello: mocks.referralHello },
}));

const NOW = new Date('2026-11-03T08:30:00.000Z'); // Tuesday 9:30 in Lagos
const project = { id: 1, name: 'Reconciliation', audience: null } as Project;

function snapshot(over: Partial<QuietSnapshot> = {}): QuietSnapshot {
  return { projectId: 1, empty: false, day2: null, used: null, away: [], referrals: [], paused: null, ...over };
}

const kemi: AwayPerson = {
  personId: 1, projectId: 1, first: 'Kemi', name: 'Kemi Eze', company: 'Oko Pay', role: 'Founder', until: '2026-11-20',
  followUpAt: '2026-11-23T08:00:00.000Z', text: "Thanks for your email. I'm out of the office until 20 November.", at: '2026-11-03T08:10:00.000Z',
};
const sam: ReferralCard = {
  personId: 7, projectId: 1, first: 'Sam', name: 'Sam Bello', company: null,
  referrer: { id: 1, first: 'Kemi', name: 'Kemi Eze', company: 'Oko Pay' }, context: 'runs finance at Oko Pay', channel: 'email',
  subject: 'Kemi suggested I get in touch',
  draft: "Hi Sam, Kemi suggested I reach out. I help fintech teams take reconciliation off their ops team's plate. Would a short call next week be useful?",
};

function view(props: Partial<QuietProps> = {}) {
  const base: QuietProps = {
    quiet: snapshot(), project, tz: 'Africa/Lagos', offline: false, waiting: 0, onTryNow: vi.fn(), onChanged: vi.fn(), now: () => NOW,
  };
  const merged = { ...base, ...props };
  return { ...render(<Quiet {...merged} />), props: merged };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('pickMoment', () => {
  const full = snapshot({ empty: true });
  it('puts what needs a decision before the quiet', () => {
    expect(pickMoment({ quiet: snapshot({ paused: { since: 'x', days: 3, hellos: 0, followUps: 0 }, referrals: [sam] }), offline: true, waiting: 2 })).toBe('paused');
    expect(pickMoment({ quiet: snapshot({ referrals: [sam], away: [kemi] }), offline: true, waiting: 0 })).toBe('offline');
    expect(pickMoment({ quiet: snapshot({ referrals: [sam], away: [kemi] }), offline: false, waiting: 3 })).toBe('referral');
    expect(pickMoment({ quiet: snapshot({ away: [kemi] }), offline: false, waiting: 3 })).toBe('away');
  });
  it('shows empty, used and day two only when nobody waits in the dock', () => {
    expect(pickMoment({ quiet: full, offline: false, waiting: 0 })).toBe('empty');
    expect(pickMoment({ quiet: full, offline: false, waiting: 1 })).toBeNull();
    const used = { replied: [], repliedCount: 0, finishing: 0, finishBy: null };
    const day2 = { sentYesterday: 1, nextCount: 0, nextAt: null, sent: [] };
    expect(pickMoment({ quiet: snapshot({ used, day2 }), offline: false, waiting: 0 })).toBe('used');
    expect(pickMoment({ quiet: snapshot({ day2 }), offline: false, waiting: 0 })).toBe('day2');
    expect(pickMoment({ quiet: snapshot(), offline: false, waiting: 0 })).toBeNull();
    expect(pickMoment({ quiet: null, offline: false, waiting: 0 })).toBeNull();
  });
});

describe('Quiet: empty river', () => {
  it('invites the person to say who to meet, with starter chips that go to the Ask bar', async () => {
    const onAsk = vi.fn();
    const onBringList = vi.fn();
    view({ quiet: snapshot({ empty: true }), onAsk, onBringList });
    expect(screen.getByText('Your river is empty.')).toBeInTheDocument();
    expect(screen.getByText(/Tell Callum who you want to meet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'bring a list' }));
    expect(onBringList).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Founders at small fintechs' }));
    expect(onAsk).toHaveBeenCalledWith('Founders at small fintechs');
  });

  it('starts the chips with who the project is for', () => {
    expect(starterChips({ ...project, audience: 'Heads of finance in Accra' })[0]).toBe('Heads of finance in Accra');
    expect(starterChips(null)).toHaveLength(2);
  });

  it('never offers the same chip twice', () => {
    const chips = starterChips({ ...project, audience: 'founders at small fintechs' });
    expect(chips).toHaveLength(2);
    expect(new Set(chips.map((c) => c.toLowerCase())).size).toBe(2);
  });
});

describe('Quiet: day two', () => {
  const day2 = {
    sentYesterday: 12, nextCount: 12, nextAt: '2026-11-04T08:00:00.000Z',
    sent: [{ personId: 3, name: 'Femi Adeyemi', channel: 'email' as const, at: '2026-11-02T08:26:00.000Z', text: "Hi Femi, Eko Wallet's growth caught my eye." }],
  };

  it('says no replies yet is normal, what is next, and lists what went out in place', async () => {
    view({ quiet: snapshot({ day2 }) });
    expect(screen.getByText('No replies yet, which is normal this early.')).toBeInTheDocument();
    expect(screen.getByText('12 hellos went out')).toBeInTheDocument();
    expect(screen.getByText('Next: 12 hellos tomorrow at 9:00')).toBeInTheDocument();
    expect(screen.queryByText(/Eko Wallet/)).not.toBeInTheDocument();
    const peek = screen.getByRole('button', { name: 'See what went out' });
    await userEvent.click(peek);
    expect(screen.getByText('Femi Adeyemi')).toBeInTheDocument();
    expect(screen.getByText('Email, Monday at 9:26')).toBeInTheDocument();
    expect(screen.getByText("Hi Femi, Eko Wallet's growth caught my eye.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Femi Adeyemi')).not.toBeInTheDocument();
  });

  it('leaves the next line out when nothing is lined up', () => {
    view({ quiet: snapshot({ day2: { ...day2, nextAt: null, nextCount: 0 } }) });
    expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
  });
});

describe('Quiet: group used up', () => {
  const used = { replied: [{ id: 1, first: 'Kemi' }, { id: 2, first: 'Tunde' }], repliedCount: 4, finishing: 26, finishBy: '2026-11-13T08:00:00.000Z' };

  it('says everyone has heard from you and offers more like the people who replied', async () => {
    mocks.ask.mockResolvedValue({
      text: 'Callum can look for 20 more like Kemi. That uses about 20 Apollo credits.', personIds: [],
      action: { kind: 'find_more', label: 'Find 20 more like Kemi', args: { likePersonId: 1, query: null, count: 20 } },
    });
    mocks.act.mockResolvedValue({ text: 'Added 20 people. They start as strangers.', personIds: [], action: null });
    const onChanged = vi.fn();
    view({ quiet: snapshot({ used }), onChanged });
    expect(screen.getByText('Everyone in this group has heard from you.')).toBeInTheDocument();
    expect(screen.getByText('4 people replied. The other 26 finish their follow-ups by Friday 13 November, then rest.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Find more like the people who replied' }));
    expect(mocks.ask).toHaveBeenCalledWith('Find more like Kemi', 1);
    expect(await screen.findByText(/uses about 20 Apollo credits/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Find 20 more like Kemi' }));
    expect(await screen.findByText('Added 20 people. They start as strangers.')).toBeInTheDocument();
    expect(mocks.act).toHaveBeenCalledWith(expect.objectContaining({ kind: 'find_more' }), 1);
    expect(onChanged).toHaveBeenCalled();
  });

  it('says why when Callum cannot look for more', async () => {
    mocks.ask.mockRejectedValue(new ApiError(422, 'Callum needs a list for that.'));
    view({ quiet: snapshot({ used }) });
    await userEvent.click(screen.getByRole('button', { name: 'Find more like the people who replied' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum needs a list for that.');
  });

  it('has nothing to find more like when nobody replied', () => {
    view({ quiet: snapshot({ used: { replied: [], repliedCount: 0, finishing: 0, finishBy: null } }) });
    expect(screen.getByText('Nobody has replied yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Find more/ })).not.toBeInTheDocument();
  });
});

describe('Quiet: offline', () => {
  it('says Callum cannot be reached and tries again on Try now', async () => {
    let finish: () => void = () => {};
    const onTryNow = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    view({ offline: true, onTryNow });
    expect(screen.getByRole('status')).toHaveTextContent("Callum can't be reached right now. It keeps trying.");
    await userEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(onTryNow).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Trying' })).toBeInTheDocument();
    await act(async () => finish());
    expect(await screen.findByRole('button', { name: 'Try now' })).toBeInTheDocument();
  });
});

describe('Quiet: out of office', () => {
  it('says who is away and when Callum follows up, and waits on Okay', async () => {
    view({ quiet: snapshot({ away: [kemi] }) });
    expect(screen.getByText('Kemi is away until Friday 20 November.')).toBeInTheDocument();
    expect(screen.getByText('Callum will wait and follow up on Monday 23 November at 9:00.')).toBeInTheDocument();
    expect(screen.getByText(kemi.text)).toBeInTheDocument();
    expect(screen.getByText('Auto-reply from Kemi Eze, Oko Pay, Tuesday at 9:10')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Kemi Eze, Oko Pay, away' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Okay' }));
    expect(screen.getByText('Kemi rests until they are back')).toBeInTheDocument();
    expect(screen.getByText("Callum holds Kemi's follow-up until Monday 23 November at 9:00.")).toBeInTheDocument();
    expect(mocks.realReply).not.toHaveBeenCalled();
  });

  it('moves them to the dock when the person says it is a real reply', async () => {
    mocks.realReply.mockResolvedValue({ id: 1 });
    const onChanged = vi.fn();
    view({ quiet: snapshot({ away: [kemi] }), onChanged });
    await userEvent.click(screen.getByRole('button', { name: "It's a real reply" }));
    expect(mocks.realReply).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Kemi wrote back.')).toBeInTheDocument();
    expect(screen.getByText('Kemi moved to your replies')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('says what went wrong and stays', async () => {
    mocks.realReply.mockRejectedValue(new ApiError(422, 'Kemi has not written back yet'));
    view({ quiet: snapshot({ away: [kemi] }) });
    await userEvent.click(screen.getByRole('button', { name: "It's a real reply" }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kemi has not written back yet');
    expect(screen.getByRole('button', { name: "It's a real reply" })).toBeEnabled();
  });

  it('copes with an auto-reply that gave no date', () => {
    view({ quiet: snapshot({ away: [{ ...kemi, until: null, followUpAt: null }] }) });
    expect(screen.getByText('Kemi is away.')).toBeInTheDocument();
  });
});

describe('Quiet: referral', () => {
  it('shows who pointed to whom and Callum draft, which mentions the referrer', () => {
    view({ quiet: snapshot({ referrals: [sam] }) });
    expect(screen.getByText('Kemi said Sam runs finance at Oko Pay.')).toBeInTheDocument();
    expect(screen.getByLabelText('Hello to Sam, drafted by Callum')).toHaveValue(sam.draft);
    expect(screen.getByText('By email')).toBeInTheDocument();
    expect(screen.getByText('Warm intro')).toBeInTheDocument();
  });

  it('sends the edited draft as the user hello, shows the undo window, and undoes it', async () => {
    mocks.referralHello.mockResolvedValue({ id: 55 });
    mocks.undo.mockResolvedValue({ id: 55 });
    const onChanged = vi.fn();
    const { rerender, props } = view({ quiet: snapshot({ referrals: [sam] }), onChanged });
    const draft = screen.getByLabelText('Hello to Sam, drafted by Callum');
    await userEvent.clear(draft);
    await userEvent.type(draft, 'Hi Sam, Kemi said you own finance.');
    await userEvent.click(screen.getByRole('button', { name: 'Send to Sam' }));
    expect(mocks.referralHello).toHaveBeenCalledWith(7, 'Hi Sam, Kemi said you own finance.', 'Kemi suggested I get in touch');
    expect(await screen.findByText('Your hello to Sam leaves in a few seconds. Undo if you want to change it.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();

    // The server no longer lists Sam once the hello is queued: the card stays until the person is done.
    rerender(<Quiet {...props} quiet={snapshot()} />);
    expect(screen.getByText('Your hello to Sam leaves in a few seconds. Undo if you want to change it.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith(55);
    expect(await screen.findByLabelText('Hello to Sam, drafted by Callum')).toBeInTheDocument();
  });

  it('says Sam is in the river once the undo window has passed', async () => {
    mocks.referralHello.mockResolvedValue({ id: 55 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    view({ quiet: snapshot({ referrals: [sam] }) });
    await userEvent.click(screen.getByRole('button', { name: 'Send to Sam' }));
    await screen.findByText(/leaves in a few seconds/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(screen.getByText('Sam is in the river now.')).toBeInTheDocument();
  });

  it('shows what Callum would not send, and keeps the draft', async () => {
    mocks.referralHello.mockRejectedValue(new ApiError(422, 'Add your price first. Callum never sends a message with [YOUR PRICE] in it.'));
    view({ quiet: snapshot({ referrals: [sam] }) });
    await userEvent.click(screen.getByRole('button', { name: 'Send to Sam' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum never sends a message with [YOUR PRICE] in it.');
    expect(screen.getByLabelText('Hello to Sam, drafted by Callum')).toHaveValue(sam.draft);
  });

  it('saves it for later without sending', async () => {
    view({ quiet: snapshot({ referrals: [sam] }) });
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.getByText('Saved for later')).toBeInTheDocument();
    expect(mocks.referralHello).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Write it now' }));
    expect(screen.getByLabelText('Hello to Sam, drafted by Callum')).toBeInTheDocument();
  });

  it('still reads well when nobody is known to have pointed', () => {
    view({ quiet: snapshot({ referrals: [{ ...sam, referrer: null, context: null }] }) });
    expect(screen.getByText('A reply pointed to Sam Bello.')).toBeInTheDocument();
  });
});

describe('Quiet: paused three days', () => {
  const paused = { since: '2026-10-30T15:20:00.000Z', days: 3, hellos: 12, followUps: 9 };

  it('asks whether to resume, and resumes', async () => {
    mocks.resumeAll.mockResolvedValue({});
    const onChanged = vi.fn();
    view({ quiet: snapshot({ paused }), onChanged });
    expect(screen.getByText('Paused since Friday at 16:20')).toBeInTheDocument();
    expect(screen.getByText('Callum has been paused for three days. Resume, or pick a date?')).toBeInTheDocument();
    expect(screen.getByText('12 hellos and 9 follow-ups are waiting. Replies still reach you.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resumeAll).toHaveBeenCalled();
    expect(await screen.findByText('Running again')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('pauses until a date at 9:00', async () => {
    mocks.pause.mockResolvedValue({});
    view({ quiet: snapshot({ paused }) });
    await userEvent.click(screen.getByRole('button', { name: 'Pick a date' }));
    const group = screen.getByRole('group', { name: 'Stay paused until' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Monday 9 November', 'Monday 16 November', '6 January']);
    await userEvent.click(within(group).getByRole('button', { name: 'Monday 16 November' }));
    expect(mocks.pause).toHaveBeenCalledWith('2026-11-16T08:00:00.000Z');
    expect(await screen.findByText('Paused until Monday 16 November')).toBeInTheDocument();
    expect(screen.getByText(/Callum starts again on Monday 16 November at 9:00/)).toBeInTheDocument();
  });
});

describe('Quiet: nothing to say', () => {
  it('renders nothing while the data has not arrived, or when a reply waits', () => {
    expect(view({ quiet: null }).container).toBeEmptyDOMElement();
    expect(view({ quiet: snapshot({ empty: true }), waiting: 2 }).container).toBeEmptyDOMElement();
  });
  it('can be told which moment to show', () => {
    view({ quiet: snapshot({ empty: true }), moment: 'empty' });
    expect(screen.getByText('Your river is empty.')).toBeInTheDocument();
  });
});

