import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Person } from '../../../shared/types.js';
import { INCIDENT_COPY } from '../../../server/runner/incidents.js';
import { ApiError } from '../../api.js';
import { appState, incident, NOW, outboxItem, person, project } from '../../test/phoneLeaveFixtures.js';
import { ToastProvider } from '../../ui/Toast.js';
import { PHONE_QUERY, useMediaQuery } from '../../useMediaQuery.js';
import { PhoneHome } from './PhoneHome.js';

const mocks = vi.hoisted(() => ({
  reply: vi.fn(),
  book: vi.fn(),
  close: vi.fn(),
  snooze: vi.fn(),
  undo: vi.fn(),
  draft: vi.fn(),
  updateProject: vi.fn(),
  setCurrentProject: vi.fn(),
  pauseProject: vi.fn(),
  resumeProject: vi.fn(),
  resumeChannel: vi.fn(),
  retry: vi.fn(),
  person: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const refresh = vi.fn(() => Promise.resolve());
const onReconnect = vi.fn();

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  refresh.mockClear();
  onReconnect.mockClear();
  window.localStorage.clear();
});

const kemi = (over: Partial<Person> = {}) =>
  person(1, 'Kemi', {
    status: 'waiting', stage: 'talking', suggested: 'book', repliedAt: '2026-11-02T06:40:00.000Z',
    lastInbound: "This is timely. We're rebuilding our month-end close in December.",
    draft: "Thanks Kemi, glad the timing works. I'll send a short deck tonight.",
    ...over,
  });

function setup(state: AppState = appState({ people: [kemi()] }), extra: Partial<React.ComponentProps<typeof PhoneHome>> = {}) {
  const user = userEvent.setup();
  const current = state.projects[0] ?? null;
  const view = render(
    <ToastProvider>
      <PhoneHome
        state={state}
        project={current}
        refresh={refresh}
        river={<div data-testid="river">river</div>}
        dock={<div data-testid="dock">dock</div>}
        onReconnect={onReconnect}
        now={() => NOW}
        {...extra}
      />
    </ToastProvider>,
  );
  return { user, ...view };
}

describe('PhoneHome', () => {
  it('shows the brief, the river and the dock the caller gave it, and the person who wants to talk as a card', () => {
    setup(appState({ people: [kemi()], brief: { wantToTalk: 1, sentYesterday: 12, acceptedRecently: ['Ada'], acceptedIds: [], nextSendAt: '2026-11-03T08:00:00.000Z', line: '' } }));
    expect(screen.getByRole('heading', { name: 'Good morning' })).toBeInTheDocument();
    expect(screen.getByText('12 hellos went out yesterday')).toBeInTheDocument();
    expect(screen.getByText('Ada accepted')).toBeInTheDocument();
    expect(screen.getByText('Next hello tomorrow at 9:00')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Your river' })).getByTestId('river')).toBeInTheDocument();
    expect(screen.getByTestId('dock')).toBeInTheDocument();
    expect(screen.getByText('1 person wants to talk')).toBeInTheDocument();
    const card = screen.getByRole('article', { name: 'Reply from Kemi Eze' });
    expect(within(card).getByText("This is timely. We're rebuilding our month-end close in December.")).toBeInTheDocument();
    expect(within(card).getByLabelText("Callum's draft, in your voice")).toHaveValue("Thanks Kemi, glad the timing works. I'll send a short deck tonight.");
    for (const name of ['Send', 'Snooze', 'Book a call', 'Close politely']) expect(within(card).getByRole('button', { name })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Book a call' })).toHaveAttribute('data-suggested', 'true');
  });

  it('Send sends the edited draft and offers Undo for ten seconds', async () => {
    mocks.reply.mockResolvedValue(outboxItem(31, 1, { undoUntil: new Date(NOW.getTime() + 10_000).toISOString() }));
    mocks.undo.mockResolvedValue({});
    const { user } = setup();
    const draft = screen.getByLabelText("Callum's draft, in your voice");
    await user.clear(draft);
    await user.type(draft, 'Thanks Kemi, Monday works.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(mocks.reply).toHaveBeenCalledWith(1, 'Thanks Kemi, Monday works.');
    const status = await screen.findByText('Sending your reply to Kemi');
    expect(status).toBeInTheDocument();
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith(31);
    expect(await screen.findByText('Not sent. Your reply to Kemi is back.')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Reply from Kemi Eze' })).toBeInTheDocument();
  });

  it('brings someone back who replies again after they were answered', async () => {
    mocks.reply.mockResolvedValue(outboxItem(31, 1));
    const first = appState({ people: [kemi()] });
    const { user, rerender } = setup(first);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
    // The state moves on: Kemi is still waiting, but this is a newer reply.
    const again = appState({ people: [kemi({ repliedAt: '2026-11-02T09:30:00.000Z', lastInbound: 'One more thing: can you do Tuesday?', draft: 'Tuesday works.' })] });
    rerender(
      <ToastProvider>
        <PhoneHome state={again} project={again.projects[0] ?? null} refresh={refresh} river={<div />} onReconnect={onReconnect} now={() => NOW} />
      </ToastProvider>,
    );
    expect(await screen.findByText('One more thing: can you do Tuesday?')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Reply from Kemi Eze' })).toBeInTheDocument();
  });

  it('runs the undo ring for what is left of the server window, less the time the call took', async () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    mocks.reply.mockImplementation(async () => {
      clock = 3000;
      return outboxItem(31, 1, { updatedAt: NOW.toISOString(), undoUntil: new Date(NOW.getTime() + 10_000).toISOString() });
    });
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Sending your reply to Kemi');
    const ring = container.ownerDocument.querySelector('.ph-ring') as SVGElement;
    expect(ring.style.animationDuration).toBe('8000ms');
    vi.restoreAllMocks();
  });

  it('offers no Undo when the undo window was already used up by the call', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    mocks.reply.mockImplementation(async () => {
      clock = 12_000;
      return outboxItem(31, 1);
    });
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Sent to Kemi');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('leaves line breaks where they were when the placeholder sentence goes', async () => {
    const draft = 'Hi Kemi,\n\nHappy to help. Our price is [YOUR PRICE] a month. Talk soon.\n\nGabriel';
    const { user } = setup(appState({ people: [kemi({ draft })] }));
    await user.click(screen.getByRole('button', { name: 'Leave the price out' }));
    expect(screen.getByLabelText("Callum's draft, in your voice")).toHaveValue('Hi Kemi,\n\nHappy to help. Talk soon.\n\nGabriel');
  });

  it('guards the other kinds of placeholder too', () => {
    setup(appState({ people: [kemi({ draft: 'Hi {{first_name}}, glad to help.' })] }));
    expect(screen.getByRole('alert')).toHaveTextContent('Fill in {{first_name}} first. Callum never sends a message with {{first_name}} in it.');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Leave it out' })).toBeInTheDocument();
  });

  it('will not send a draft that still has a placeholder, and Leave the price out fixes it', async () => {
    const state = appState({ people: [kemi({ draft: 'Happy to help. Our price is [YOUR PRICE] a month. Talk soon.' })] });
    const { user } = setup(state);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Add your price first. Callum never sends a message with [YOUR PRICE] in it.');
    await user.click(send);
    expect(mocks.reply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Leave the price out' }));
    expect(screen.getByLabelText("Callum's draft, in your voice")).toHaveValue('Happy to help. Talk soon.');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('Snooze rests the person and says until when', async () => {
    mocks.snooze.mockResolvedValue(kemi({ status: 'snoozed', snoozedUntil: '2026-11-09T08:00:00.000Z' }));
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(mocks.snooze).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Kemi comes back 9 Nov at 9:00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('Close politely sends the goodbye with an Undo', async () => {
    mocks.close.mockResolvedValue(outboxItem(32, 1, { kind: 'close' }));
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Close politely' }));
    expect(mocks.close).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Thanking Kemi. No more follow-ups.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('Book a call sends the calendar link when there is one', async () => {
    mocks.book.mockResolvedValue(outboxItem(33, 1, { kind: 'booking' }));
    const state = appState({ people: [kemi()], projects: [project({ calendarUrl: 'https://cal.com/gabriel' })] });
    const { user } = setup(state);
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    expect(mocks.book).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Sending Kemi your calendar link')).toBeInTheDocument();
  });

  it('Book a call asks for the calendar link first, saves it, then sends', async () => {
    mocks.updateProject.mockResolvedValue({});
    mocks.book.mockResolvedValue(outboxItem(33, 1, { kind: 'booking' }));
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    expect(mocks.book).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Add your calendar link first'), 'https://cal.com/gabriel');
    await user.click(screen.getByRole('button', { name: 'Save and send' }));
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { calendarUrl: 'https://cal.com/gabriel' });
    expect(mocks.book).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Sending Kemi your calendar link')).toBeInTheDocument();
  });

  it('says why when the reply did not go and keeps the card', async () => {
    mocks.reply.mockRejectedValue(new ApiError(422, 'Kemi is not waiting on you any more.'));
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kemi is not waiting on you any more.');
    expect(screen.getByRole('article', { name: 'Reply from Kemi Eze' })).toBeInTheDocument();
  });

  it('asks Callum for a draft when there is none yet', async () => {
    mocks.draft.mockResolvedValue({ body: 'Thanks Kemi, I will send a deck tonight.' });
    setup(appState({ people: [kemi({ draft: null })] }));
    expect(mocks.draft).toHaveBeenCalledWith(1, 'reply');
    await waitFor(() => expect(screen.getByLabelText("Callum's draft, in your voice")).toHaveValue('Thanks Kemi, I will send a deck tonight.'));
  });

  it('is calm when nobody is waiting, and leaves out anyone whose answer is already going', () => {
    setup(appState({ people: [kemi()], outbox: [outboxItem(40, 1)] }));
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    expect(screen.getByText('Nobody is waiting on you')).toBeInTheDocument();
  });

  it('carries the project name on the card only when there is more than one project', () => {
    const two = appState({ people: [kemi()], projects: [project(), project({ id: 2, name: 'Payroll' })] });
    const { unmount } = setup(two);
    expect(within(screen.getByRole('article')).getByText('Reconciliation')).toBeInTheDocument();
    unmount();
    setup();
    expect(within(screen.getByRole('article')).queryByText('Reconciliation')).not.toBeInTheDocument();
  });
});

describe('PhoneHome: Day one banner and people in the river', () => {
  const tunde = () => person(5, 'Tunde', { stage: 'following', touches: 1 });

  it('shows a compact banner for the hellos still to OK, and opens Day one from it', async () => {
    const onOpen = vi.fn();
    const { user } = setup(appState({ people: [kemi()] }), { dayOne: { left: 7, onOpen } });
    expect(screen.getByText('7 of 10 hellos left to OK in Reconciliation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK the hellos' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('draws no banner when Day one is not waiting', () => {
    setup(appState({ people: [kemi()] }));
    expect(screen.queryByRole('button', { name: 'OK the hellos' })).not.toBeInTheDocument();
  });

  it('opens a person from a face in the river', async () => {
    mocks.person.mockResolvedValue({ person: tunde(), messages: [], path: [] });
    const state = appState({ people: [kemi(), tunde()] });
    const { user } = setup(state, {
      river: ({ onFace }: { onFace(p: Person): void }) => <button type="button" onClick={() => onFace(tunde())}>Tunde in the river</button>,
    });
    await user.click(screen.getByRole('button', { name: 'Tunde in the river' }));
    expect(await screen.findByRole('dialog', { name: 'Tunde Eze' })).toBeInTheDocument();
    expect(mocks.person).toHaveBeenCalledWith(5);
  });

  it('lists people by how far along they are, and a row opens the same sheet', async () => {
    mocks.person.mockResolvedValue({ person: tunde(), messages: [], path: [] });
    const { user } = setup(appState({ people: [kemi(), tunde()] }));
    expect(screen.getByText('Following up')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Tunde Eze/ }));
    expect(await screen.findByRole('dialog', { name: 'Tunde Eze' })).toBeInTheDocument();
  });

  it('does not list the people who already have a card', () => {
    setup(appState({ people: [kemi(), tunde()] }));
    expect(screen.queryByText('Want to talk')).not.toBeInTheDocument();
  });
});

describe('PhoneHome: top bar and sheets', () => {
  const two = () =>
    appState({
      people: [kemi(), person(5, 'Tunde', { projectId: 2 })],
      projects: [project(), project({ id: 2, name: 'Payroll', state: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' })],
    });

  it('shows the project name as the switcher and lists the projects in a bottom sheet', async () => {
    mocks.setCurrentProject.mockResolvedValue({});
    const { user } = setup(two());
    await user.click(screen.getByRole('button', { name: 'Switch project, now Reconciliation' }));
    const sheet = screen.getByRole('dialog', { name: 'Your projects' });
    expect(within(sheet).getByRole('button', { name: 'Reconciliation, 1 person, 1 talking' })).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: /^Payroll, Paused until/ }));
    expect(mocks.setCurrentProject).toHaveBeenCalledWith(2);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Your projects' })).not.toBeInTheDocument());
  });

  it('pauses and resumes a project from its row', async () => {
    mocks.pauseProject.mockResolvedValue({});
    mocks.resumeProject.mockResolvedValue({});
    const { user } = setup(two());
    await user.click(screen.getByRole('button', { name: /Switch project/ }));
    await user.click(screen.getByRole('button', { name: 'Pause Reconciliation' }));
    // Until 9:00 on the next Monday in Lagos, and the toast says who keeps going.
    expect(mocks.pauseProject).toHaveBeenCalledWith(1, '2026-11-09T08:00:00.000Z');
    expect(await screen.findByText('Reconciliation is paused.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume Payroll' }));
    expect(mocks.resumeProject).toHaveBeenCalledWith(2);
    expect(await screen.findByText('Payroll is back to work')).toBeInTheDocument();
  });

  it('says who keeps going when another project is still running', async () => {
    mocks.pauseProject.mockResolvedValue({});
    const state = appState({ people: [], projects: [project(), project({ id: 2, name: 'Payroll' })] });
    const { user } = setup(state);
    await user.click(screen.getByRole('button', { name: /Switch project/ }));
    await user.click(screen.getByRole('button', { name: 'Pause Reconciliation' }));
    expect(await screen.findByText('Reconciliation is paused. Payroll keeps going.')).toBeInTheDocument();
  });

  it('moves focus into the sheet, keeps Tab inside it, and gives focus back to the switcher', async () => {
    const { user } = setup(two(), { onNewProject: vi.fn() });
    const switcher = screen.getByRole('button', { name: /Switch project/ });
    await user.click(switcher);
    const sheet = screen.getByRole('dialog', { name: 'Your projects' });
    expect(sheet).toHaveFocus();
    const buttons = within(sheet).getAllByRole('button');
    const last = buttons[buttons.length - 1] as HTMLElement;
    last.focus();
    await user.tab();
    expect(buttons[0]).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(switcher).toHaveFocus();
  });

  it('does the same for the Ask sheet', async () => {
    const { user } = setup(undefined, { ask: <label>Ask Callum about Reconciliation<input /></label> });
    const fab = screen.getByRole('button', { name: 'Ask Callum' });
    await user.click(fab);
    expect(screen.getByRole('dialog', { name: 'Ask Callum' })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Ask Callum about Reconciliation')).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Ask Callum about Reconciliation')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(fab).toHaveFocus();
  });

  it('opens New project from the sheet, and Escape closes it', async () => {
    const onNewProject = vi.fn();
    const { user } = setup(two(), { onNewProject });
    await user.click(screen.getByRole('button', { name: /Switch project/ }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Switch project/ }));
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it('collapses the Ask bar to an icon that opens it in a sheet', async () => {
    const { user } = setup(undefined, { ask: <label>Ask Callum about Reconciliation<input /></label> });
    expect(screen.queryByLabelText('Ask Callum about Reconciliation')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask Callum' }));
    expect(within(screen.getByRole('dialog', { name: 'Ask Callum' })).getByLabelText('Ask Callum about Reconciliation')).toBeInTheDocument();
  });

  it('shows no Ask icon when there is no Ask bar to open', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Ask Callum' })).not.toBeInTheDocument();
  });

  it('says a paused project is paused and brings it back with Resume', async () => {
    mocks.resumeProject.mockResolvedValue({});
    const state = appState({ people: [], projects: [project({ state: 'paused' }), project({ id: 2, name: 'Payroll' })] });
    const { user } = setup(state);
    expect(screen.getByText('Reconciliation is paused. Payroll keeps going.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resumeProject).toHaveBeenCalledWith(1);
  });

  it('opens Your Callum from the avatar', async () => {
    const onOpenAccount = vi.fn();
    const { user } = setup(undefined, { onOpenAccount });
    await user.click(screen.getByRole('button', { name: 'Your Callum' }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it('shows an incident above the brief and passes Reconnect on', async () => {
    const message = INCIDENT_COPY.mailbox_signed_out('Google', 'gabriel@yourcompany.com', 3);
    const { user } = setup(appState({ incidents: [incident(1, 'mailbox_signed_out', message)] }));
    await user.click(screen.getByRole('button', { name: 'Reconnect Google' }));
    expect(onReconnect).toHaveBeenCalledWith('email');
  });
});

describe('PhoneHome behind the media query', () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  function Responsive() {
    const phone = useMediaQuery(PHONE_QUERY);
    const state = appState({ people: [kemi()] });
    return phone ? (
      <PhoneHome state={state} project={state.projects[0] ?? null} refresh={refresh} river={<div />} onReconnect={onReconnect} now={() => NOW} />
    ) : (
      <p>Desktop home</p>
    );
  }

  function width(px: number) {
    window.matchMedia = ((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return { matches: max ? px <= Number(max[1]) : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    }) as unknown as typeof window.matchMedia;
  }

  it('at 390 px it is the phone layout, and Send calls api.reply', async () => {
    mocks.reply.mockResolvedValue(outboxItem(31, 1));
    width(390);
    const user = userEvent.setup();
    render(<ToastProvider><Responsive /></ToastProvider>);
    expect(screen.queryByText('Desktop home')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(mocks.reply).toHaveBeenCalledWith(1, "Thanks Kemi, glad the timing works. I'll send a short deck tonight.");
  });

  it('at 1440 px it is left to the desktop home', () => {
    width(1440);
    render(<ToastProvider><Responsive /></ToastProvider>);
    expect(screen.getByText('Desktop home')).toBeInTheDocument();
  });
});
