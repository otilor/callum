// Journey 2: day one. OK three hellos, edit one, skip one, Undo one within 10 seconds, watch the counter.
import { expect, test, type Page } from '@playwright/test';
import { byName, seed, startCallum, type Outbox, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'fresh' });
});
test.afterAll(async () => {
  await app.stop();
});

/** The first-run steps, ending on Day one. */
async function startFromFirstRun(page: Page): Promise<void> {
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  for (const step of ['Next', 'Looks right', 'Next', 'Next']) await page.getByRole('button', { name: step }).first().click();
  await page.getByRole('button', { name: /^Start \w+ at 9:00$/ }).click();
  await expect(page.locator('[data-screen="day-one"]')).toBeVisible();
}

const item = (outbox: Outbox[], personId: number) => outbox.find((o) => o.personId === personId && o.kind !== 'reply');

test('OK three hellos, edit one, skip one, undo one within ten seconds, and the counter follows the server', async ({ page }) => {
  await seed(app, 'fresh');
  await startFromFirstRun(page);
  const left = page.locator('[data-screen="day-one"]');

  let s = await app.state();
  expect(s.projects[0]?.approvalsLeft).toBe(10);
  await expect(left.getByText('10 left')).toBeVisible();
  const kemi = byName(s, 'Kemi Eze');
  const tunde = byName(s, 'Tunde Bello');
  expect(item(s.outbox, kemi.id)?.state).toBe('awaiting_ok');

  // 1. OK Kemi's hello as it is.
  await expect(left.getByText('Kemi Eze')).toBeVisible();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  // "tomorrow", or the weekday it is when tomorrow is a weekend.
  await expect(page.getByText(/^Kemi's hello goes out .+ at 9:00 their time$/)).toBeVisible();
  await expect(left.getByText('9 left')).toBeVisible();
  s = await app.state();
  const kemiItem = item(s.outbox, kemi.id)!;
  expect(kemiItem.state).toBe('scheduled');
  expect(kemiItem.undoUntil).not.toBeNull();
  expect(new Date(kemiItem.undoUntil!).getTime() - Date.now()).toBeLessThanOrEqual(10_000);
  expect(s.projects[0]?.approvalsLeft).toBe(9);

  // 2. Edit Tunde's hello, then OK it. The server keeps the edited words.
  await expect(left.getByText('Tunde Bello')).toBeVisible();
  const edited = "Hi Tunde, I help fintech teams hand reconciliation to a calm colleague. Would a quick chat on Thursday be useful?";
  await page.getByText(/^Hi Tunde/).fill(edited);
  await expect(page.getByText('Edited. Callum learns from this.')).toBeVisible();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(left.getByText('8 left')).toBeVisible();
  s = await app.state();
  expect(item(s.outbox, tunde.id)?.body).toBe(edited);
  expect(item(s.outbox, tunde.id)?.state).toBe('scheduled');

  // 3. Skip the next person. Callum stops with them: nothing for them is queued and they are never contacted.
  const ada = byName(s, 'Ada Nwosu');
  await expect(left.getByText('Ada Nwosu')).toBeVisible();
  await page.getByRole('button', { name: "Don't contact" }).click();
  await expect.poll(async () => byName(await app.state(), ada.name).status).toBe('stopped');
  s = await app.state();
  expect(s.outbox.filter((o) => o.personId === ada.id && ['awaiting_ok', 'scheduled'].includes(o.state))).toHaveLength(0);
  expect(byName(s, ada.name).nextTouchAt).toBeNull();

  // 4. OK the next hello and take it back inside ten seconds.
  const countBefore = (await app.state()).projects[0]!.approvalsLeft;
  const scheduledBefore = new Set((await app.state()).outbox.filter((o) => o.state === 'scheduled').map((o) => o.id));
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect.poll(async () => (await app.state()).outbox.filter((o) => o.state === 'scheduled' && !scheduledBefore.has(o.id)).length).toBe(1);
  const nextWaiting = (await app.state()).outbox.find((o) => o.state === 'scheduled' && !scheduledBefore.has(o.id))!;
  expect((await app.state()).projects[0]?.approvalsLeft).toBe(countBefore - 1);
  // Toasts stack, so each OK has its own: this one is found by the name in it, and its own Undo is the one pressed.
  const who = (await app.state()).people.find((p) => p.id === nextWaiting.personId)!;
  const toast = page.locator('.undo-toast', { hasText: `${who.firstName}'s hello goes out` });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await app.state()).outbox.find((o) => o.id === nextWaiting.id)?.state).toBe('awaiting_ok');
  expect((await app.state()).projects[0]?.approvalsLeft).toBe(countBefore);
  await expect(left.getByText(`${countBefore} left`)).toBeVisible();

  // Nothing has been sent: the first slot is tomorrow.
  s = await app.state();
  expect(s.outbox.filter((o) => o.state === 'sent' || o.state === 'sending')).toHaveLength(0);

  // Ten seconds after the first OK the undo is over for good: the server refuses it and the hello stays scheduled.
  await expect.poll(() => Date.now() > new Date(kemiItem.undoUntil!).getTime(), { timeout: 15_000, intervals: [500] }).toBe(true);
  const late = await app.raw(`/api/outbox/${kemiItem.id}/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(late.status).toBeGreaterThanOrEqual(400);
  expect(late.status).toBeLessThan(500);
  expect(app.sql<{ state: string }>('select state from outbox where id = ?', kemiItem.id)[0]?.state).toBe('scheduled');
});
