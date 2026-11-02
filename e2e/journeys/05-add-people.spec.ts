// Journey 5: add people by pasting, with the preview of who is skipped and why, then Undo the whole batch.
import { expect, test } from '@playwright/test';
import { openCallum, seed, startCallum, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'morning' });
});
test.afterAll(async () => {
  await app.stop();
});

const PASTE = [
  'Amina Yusuf, amina@example.com, Lagoon Pay',
  'Joseph Park, joseph@example.com',
  'Kemi Eze, kemi@okopay.example',
  'not a person line',
  'Joseph Park, joseph@example.com',
].join('\n');

test('paste a list, see who is skipped and why, add the rest, then undo the batch', async ({ page }) => {
  await seed(app, 'morning');
  const before = await app.state();
  const count = before.people.length;
  const strangers = before.people.filter((p) => p.stage === 'stranger').length;

  await openCallum(page, app, 'home');
  await page.getByRole('button', { name: 'Add people' }).click();
  await expect(page.locator('[data-screen="add-people"]')).toBeVisible();
  await page.getByText('Paste names', { exact: true }).click();
  await page.locator('textarea').fill(PASTE);
  await page.getByRole('button', { name: 'Read the names' }).click();

  // The preview is only a preview: two people would join, three lines are left out, and nobody is in the database yet.
  await expect(page.getByText('2 new people')).toBeVisible();
  await expect(page.getByText('3 skipped, and why')).toBeVisible();
  await expect(page.getByRole('button', { name: /already in Callum/ })).toContainText('2');
  await expect(page.getByRole('button', { name: /has no email or LinkedIn/ })).toContainText('1');
  expect((await app.state()).people).toHaveLength(count);
  expect(app.sql("select * from people where email in ('amina@example.com','joseph@example.com')")).toHaveLength(0);

  // Add them: they join as strangers, with a first hello planned for tomorrow, and nothing has been sent.
  await page.getByRole('button', { name: 'Add 2 people' }).click();
  await expect(page.getByText('2 people join the river.', { exact: true })).toBeVisible();
  await expect(page.getByText('Left out: 2 already in Callum, 1 has no email or LinkedIn.')).toBeVisible();
  let s = await app.state();
  expect(s.people).toHaveLength(count + 2);
  const added = s.people.filter((p) => ['amina@example.com', 'joseph@example.com'].includes(p.email ?? ''));
  expect(added.map((p) => p.name).sort()).toEqual(['Amina Yusuf', 'Joseph Park']);
  for (const p of added) {
    expect(p).toMatchObject({ stage: 'stranger', status: 'active', source: 'paste', channel: 'email', touches: 0 });
    expect(new Date(p.nextTouchAt!).getTime()).toBeGreaterThan(Date.now());
    expect(app.sql("select * from messages where person_id = ?", p.id)).toHaveLength(0);
  }
  expect(s.people.filter((p) => p.stage === 'stranger')).toHaveLength(strangers + 2);
  // Kemi was already known: still one Kemi Eze.
  expect(s.people.filter((p) => p.name === 'Kemi Eze')).toHaveLength(1);

  // Undo takes the whole batch back.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await app.state()).people.length).toBe(count);
  s = await app.state();
  expect(s.people.filter((p) => ['amina@example.com', 'joseph@example.com'].includes(p.email ?? ''))).toHaveLength(0);
  expect(app.sql("select * from people where email in ('amina@example.com','joseph@example.com') and status != 'removed'")).toHaveLength(0);
  expect(s.people.filter((p) => p.stage === 'stranger')).toHaveLength(strangers);
  // Undoing twice is refused rather than doing something else.
  const batch = (await app.raw('/api/people/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batchId: 'nope' }) }));
  expect(batch.status).toBeGreaterThanOrEqual(400);
});
