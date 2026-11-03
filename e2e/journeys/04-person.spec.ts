// Journey 4: a person's view. Open from the river, nudge, switch channel, never contact (with the confirm).
import { expect, test } from '@playwright/test';
import { byName, openCallum, seed, startCallum, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'morning' });
});
test.afterAll(async () => {
  await app.stop();
});

test('open someone from the river, nudge, switch channel, never contact', async ({ page }) => {
  await seed(app, 'morning');
  let s = await app.state();
  const bisi = byName(s, 'Bisi Alade');
  const musa = byName(s, 'Musa Ajayi');
  expect(bisi.status).toBe('active');
  expect(new Date(bisi.nextTouchAt!).getTime()).toBeGreaterThan(Date.now() + 60_000);
  expect([musa.channel, musa.stage, musa.touches]).toEqual(['email', 'stranger', 0]);

  await openCallum(page, app, 'home');

  // A face in the river opens a small card; Nudge now makes the follow-up due now (it still waits for sending hours).
  await page.getByRole('button', { name: 'Bisi Alade, Said hello' }).click();
  await expect(page.getByText('Founder at Ikoyi Pay')).toBeVisible();
  await page.getByRole('button', { name: 'Nudge now' }).click();
  // The toast names a real slot (`tomorrow at 9:00 their time`, `Thursday at 9:00`, `12 Nov at 9:00`), not a promise.
  await expect(page.getByText(/^Bisi is next\. It goes out from (today|tomorrow|[A-Z][a-z]+|\d{1,2} [A-Z][a-z]{2}) at \d{1,2}:\d{2}( their time)?\.$/)).toBeVisible();
  s = await app.state();
  expect(new Date(byName(s, 'Bisi Alade').nextTouchAt!).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  expect(byName(s, 'Bisi Alade').status).toBe('active');
  // The second nudge in a row is not a second message: nothing new is queued by pressing it.
  expect(s.outbox.filter((o) => o.personId === bisi.id && o.state !== 'cancelled')).toHaveLength(0);

  // The whole page for the same person says what the server says.
  await page.getByRole('button', { name: 'See everything' }).click();
  await expect(page.locator('[data-screen="person"]')).toBeVisible();
  const detail = await app.api<{ person: { name: string; channel: string }; messages: Array<{ kind: string; direction: string }>; next: string }>(`/people/${bisi.id}`);
  expect(detail.person.name).toBe('Bisi Alade');
  expect(detail.messages.map((m) => [m.kind, m.direction])).toEqual([['hello', 'out']]);
  await expect(page.getByText('Callum, by email')).toBeVisible();
  await expect(page.getByText("Hi Bisi, I've been following what Ikoyi Pay is building.")).toBeVisible();
  await expect(page.getByText(detail.next)).toBeVisible();

  // Back to the river, to someone who has not heard anything yet: switch the channel to LinkedIn and back to email.
  await page.getByRole('button', { name: 'Back to the river' }).click();
  await page.getByRole('button', { name: 'Musa Ajayi, Strangers' }).click();
  await page.getByRole('button', { name: 'See everything' }).click();
  await expect(page.getByText(/^First hello goes out .+ at 9:00 by email$/)).toBeVisible();
  // Moving is the rare choice, so the channels wait behind one button.
  await page.getByRole('button', { name: 'Move Musa' }).click();
  await page.getByRole('button', { name: 'Move to LinkedIn' }).click();
  await expect(page.getByText(/^The invite goes out .+ at 9:00 on LinkedIn$/)).toBeVisible();
  s = await app.state();
  expect(byName(s, 'Musa Ajayi').channel).toBe('linkedin');
  const invite = s.outbox.find((o) => o.personId === musa.id && o.state !== 'cancelled');
  if (invite) expect(invite.channel).toBe('linkedin');
  await page.getByRole('button', { name: 'Move to email' }).click();
  await expect(page.getByText(/^First hello goes out .+ at 9:00 by email$/)).toBeVisible();
  expect(byName(await app.state(), 'Musa Ajayi').channel).toBe('email');

  // Never contact asks first. Keep changes nothing.
  await page.getByRole('button', { name: 'Never contact Musa' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText("Callum cancels everything still waiting and won't reach out again");
  await confirm.getByRole('button', { name: 'Keep' }).click();
  await expect(confirm).toHaveCount(0);
  expect(byName(await app.state(), 'Musa Ajayi').status).toBe('active');

  // Confirming stops them for good: stopped on the server, nothing queued, and no action reaches them any more.
  await page.getByRole('button', { name: 'Never contact Musa' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Never contact Musa' }).click();
  await expect.poll(async () => byName(await app.state(), 'Musa Ajayi').status).toBe('stopped');
  s = await app.state();
  expect(byName(s, 'Musa Ajayi').nextTouchAt).toBeNull();
  expect(s.outbox.filter((o) => o.personId === musa.id && ['awaiting_ok', 'scheduled'].includes(o.state))).toHaveLength(0);
  expect(app.sql("select * from outbox where person_id = ? and state in ('awaiting_ok','scheduled','sending')", musa.id)).toHaveLength(0);
  for (const action of ['nudge', 'resume', 'reply']) {
    const res = await app.raw(`/api/people/${musa.id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Hello again' }) });
    expect(res.status, action).toBeGreaterThanOrEqual(400);
  }
  expect(byName(await app.state(), 'Musa Ajayi').status).toBe('stopped');
});
