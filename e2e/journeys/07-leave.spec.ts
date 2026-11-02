// Journey 7: take a break from everything, resume, then wrap everything up and start again.
import { readFile } from 'node:fs/promises';
import { expect, test, type Download } from '@playwright/test';
import { openCallum, seed, startCallum, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'morning' });
});
test.afterAll(async () => {
  await app.stop();
});

async function openLeave(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('menuitem', { name: 'Take a break or wrap up' }).click();
  await expect(page.getByText('Take a break, or wrap up?')).toBeVisible();
}

test('a break: nothing goes out, then Resume', async ({ page }) => {
  await seed(app, 'morning');
  await openCallum(page, app, 'home');
  await openLeave(page);
  await page.getByRole('button', { name: 'Pause until Monday' }).click();

  const paused = await app.state();
  expect(paused.settings.pauseState).toBe('paused');
  const until = new Date(paused.settings.pausedUntil!);
  expect(until.getTime()).toBeGreaterThan(Date.now());
  const zone = paused.settings.timezone;
  expect(new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long' }).format(until)).toBe('Monday');
  // Everyone waits where they are: nobody is removed, stopped or closed by a break.
  expect(paused.people.filter((p) => ['removed', 'stopped', 'closed'].includes(p.status))).toHaveLength(0);

  // The server says so to every screen, and a message the user writes by hand is still the user's to send.
  await page.goto(app.url);
  await expect(page.getByText('Callum is on a break', { exact: false })).toBeVisible();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(async () => (await app.state()).settings.pauseState).toBe('running');
  expect((await app.state()).settings.pausedUntil).toBeNull();
});

test('wrap up everything, take the people with you, and start again', async ({ page }) => {
  await seed(app, 'morning');
  const before = await app.state();
  const waiting = before.people.filter((p) => p.status === 'waiting').length;
  expect(waiting).toBe(4);
  await openCallum(page, app, 'home');
  await openLeave(page);
  await page.getByRole('button', { name: 'Wrap up', exact: true }).click();

  await expect(page.getByText('Wrap up Callum', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Kemi, Tunde, Femi and 2 more keep talking with you in your own inbox')).toBeVisible();

  // Wrapping up downloads everything first (a spreadsheet and a JSON file), then stops everyone.
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('button', { name: 'Wrap up Callum' }).click();
  await expect(page.getByText('All wrapped up')).toBeVisible();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads.map((d) => d.suggestedFilename()).sort()).toEqual(['callum-people.csv', 'callum-people.json']);
  const csv = await readFile((await downloads.find((d) => d.suggestedFilename().endsWith('.csv'))!.path())!, 'utf8');
  const json = JSON.parse(await readFile((await downloads.find((d) => d.suggestedFilename().endsWith('.json'))!.path())!, 'utf8')) as { people: Array<{ name: string }> };
  expect(csv).toContain('Kemi Eze');
  expect(json.people).toHaveLength(before.people.length);

  let s = await app.state();
  expect(s.settings.pauseState).toBe('wrapped');
  expect(s.projects.every((p) => p.state === 'wrapped')).toBe(true);
  // Nothing automatic is left to go out, and no one who was talking is lost: they stay with the user.
  expect(s.outbox.filter((o) => o.origin === 'auto' && ['awaiting_ok', 'scheduled'].includes(o.state))).toHaveLength(0);
  expect(app.sql("select * from outbox where origin = 'auto' and state in ('awaiting_ok','scheduled','sending')")).toHaveLength(0);
  expect(s.people).toHaveLength(before.people.length);
  expect(s.people.filter((p) => p.status === 'waiting')).toHaveLength(waiting);

  // Wrapped is wrapped across a reload, and Start again brings Callum back without inventing work.
  await page.reload();
  await expect(page.getByText('All wrapped up')).toBeVisible();
  await page.getByRole('button', { name: 'Start again' }).click();
  await expect.poll(async () => (await app.state()).settings.pauseState).toBe('running');
  s = await app.state();
  expect(s.projects.some((p) => p.state === 'running')).toBe(true);
  expect(s.people).toHaveLength(before.people.length);
  await expect(page.locator('[data-screen="home"], [data-screen="first-run"], [data-screen="day-one"]')).toBeVisible();
});
