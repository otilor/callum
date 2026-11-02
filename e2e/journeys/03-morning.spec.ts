// Journey 3: a morning with replies. Open the deck, reply with Undo, snooze, close politely, book a call, and each person leaves the dock.
import { expect, test } from '@playwright/test';
import { byName, openCallum, seed, startCallum, type Outbox, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'morning' });
});
test.afterAll(async () => {
  await app.stop();
});

const userItem = (outbox: Outbox[], personId: number, kind: string) => outbox.find((o) => o.personId === personId && o.kind === kind && o.origin === 'user');

test('go through the replies: snooze, close politely, book a call, reply and undo, then reply for real', async ({ page }) => {
  await seed(app, 'morning');
  let s = await app.state();
  const waiting = () => s.people.filter((p) => p.status === 'waiting').map((p) => p.firstName).sort();
  expect(waiting()).toEqual(['Femi', 'Kemi', 'Yaw', 'Zainab']);
  expect(s.brief.wantToTalk).toBe(4);
  const calendar = s.projects.find((p) => p.name === 'Reconciliation')?.calendarUrl;
  expect(calendar).toBe('https://cal.example.com/gabriel');
  const [zainab, femi, yaw, kemi] = [byName(s, 'Zainab'), byName(s, 'Femi'), byName(s, 'Yaw'), byName(s, 'Kemi')] as const;

  await openCallum(page, app, 'home');
  await expect(page.getByText('4 people want to talk.')).toBeVisible();
  await page.getByRole('button', { name: 'Go through them' }).click();
  const deck = page.getByRole('dialog');
  await expect(deck.getByText('Reply 1 of 4')).toBeVisible();

  // Snooze Zainab ("maybe next quarter"): she leaves the dock and comes back Monday at 9:00.
  await expect(deck.getByText('Zainab Musa')).toBeVisible();
  await deck.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(page.getByText('Zainab comes back on Monday')).toBeVisible();
  s = await app.state();
  expect(byName(s, 'Zainab').status).toBe('snoozed');
  const back = new Date(byName(s, 'Zainab').snoozedUntil!);
  expect(back.getTime()).toBeGreaterThan(Date.now());
  const zone = (await app.state()).settings.timezone;
  const there = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(back);
  expect(there).toBe('Monday 09:00');
  expect(s.outbox.filter((o) => o.personId === zainab.id)).toHaveLength(0);

  // Close politely to Femi: a short thank-you is queued, with the opt-out line, and Femi is closed.
  await expect(deck.getByText('Femi Adeyemi')).toBeVisible();
  await deck.getByRole('button', { name: 'Close politely' }).click();
  await expect(page.getByText('Thanking Femi. No more follow-ups.')).toBeVisible();
  s = await app.state();
  const close = userItem(s.outbox, femi.id, 'close')!;
  expect(close.state).toBe('scheduled');
  expect(close.body).toContain('Femi');
  expect(close.body).not.toMatch(/\[[A-Z ]+\]|\{\{?\w+\}?\}/);

  // Book a call with Yaw: the calendar link goes out in the words.
  await expect(deck.getByText('Yaw Mensah')).toBeVisible();
  await deck.getByRole('button', { name: 'Book a call' }).click();
  await expect(page.getByText('Sending Yaw your calendar link')).toBeVisible();
  s = await app.state();
  const booking = userItem(s.outbox, yaw.id, 'booking')!;
  expect(booking.body).toContain(calendar!);
  expect(booking.state).toBe('scheduled');

  // Reply to Kemi, then take it back inside the ten seconds: nothing is sent and she is back on the dock.
  await expect(deck.getByText('Kemi Eze')).toBeVisible();
  await deck.getByRole('button', { name: 'Reply', exact: true }).click();
  // Toasts stack (Femi's and Yaw's are still showing), so Kemi's is the one with her name in it.
  const kemiToast = page.locator('.undo-toast', { hasText: 'Sending your reply to Kemi' });
  await expect(kemiToast).toBeVisible();
  s = await app.state();
  const first = userItem(s.outbox, kemi.id, 'reply')!;
  expect(first.state).toBe('scheduled');
  expect(first.body).toContain('Thursday works, Kemi');
  await kemiToast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => app.sql<{ state: string }>('select state from outbox where id = ?', first.id)[0]?.state).toBe('cancelled');
  await expect.poll(async () => byName(await app.state(), 'Kemi').status).toBe('waiting');
  expect(app.sql("select * from messages where person_id = ? and direction = 'out' and kind = 'reply'", kemi.id)).toHaveLength(0);

  // Femi and Yaw's messages were not undone. Once the ten seconds are over the runner sends them, and both leave the dock.
  for (const [id, kind] of [[femi.id, 'close'], [yaw.id, 'booking']] as const) {
    await expect.poll(() => app.sql<{ state: string }>('select state from outbox where person_id = ? and kind = ?', id, kind)[0]?.state, { timeout: 40_000, intervals: [1000] }).toBe('sent');
    expect(app.sql("select * from messages where person_id = ? and direction = 'out' and kind = ?", id, kind)).toHaveLength(1);
  }
  s = await app.state();
  expect(byName(s, 'Femi').status).toBe('closed');
  expect(byName(s, 'Yaw').status).not.toBe('waiting');
  expect(byName(s, 'Zainab').status).toBe('snoozed');
  expect(s.brief.wantToTalk).toBe(1);

  // Kemi is back on the dock, so she is the one person in the deck. This time the reply stays sent.
  await page.reload();
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
  await expect(page.getByText('1 person wants to talk.')).toBeVisible();
  await page.getByRole('button', { name: 'Open reply' }).click();
  await expect(deck.getByText('Kemi Eze')).toBeVisible();
  await deck.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByText('Sending your reply to Kemi')).toBeVisible();
  await expect(deck.getByText('All caught up')).toBeVisible();

  // After the ten seconds the runner sends it through the channel and records it.
  await expect.poll(async () => app.sql<{ state: string }>("select state from outbox where person_id = ? and kind = 'reply' order by id desc limit 1", kemi.id)[0]?.state, { timeout: 40_000, intervals: [1000] }).toBe('sent');
  const sent = app.sql<{ body: string }>("select body from messages where person_id = ? and direction = 'out' and kind = 'reply'", kemi.id);
  expect(sent[0]?.body).toContain('Thursday works, Kemi');
  s = await app.state();
  expect(byName(s, 'Kemi').status).not.toBe('waiting');
  expect(s.brief.wantToTalk).toBe(0);
});
