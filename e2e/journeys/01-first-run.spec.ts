// Journey 1: first run. Connect email, say who to meet, pick a voice, see the plan, Start.
import { expect, test } from '@playwright/test';
import { openCallum, seed, startCallum, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'fresh' });
});
test.afterAll(async () => {
  await app.stop();
});

test('first run: connect email, bring a list, pick a voice, see the plan, start', async ({ page }) => {
  await seed(app, 'fresh');
  const before = await app.state();
  expect(before.settings.pauseState).toBe('running');
  expect(before.projects[0]?.startedAt).toBeNull();
  expect(before.outbox).toHaveLength(0);

  await openCallum(page, app, 'first-run');

  // Connect email (the demo adapter; the sheet for a real mailbox has its own test).
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByText('Where should Callum reach people?')).toBeVisible();
  await expect(page.getByText('gabriel@yourcompany.com')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  // The offer, in the user's words.
  await expect(page.getByText('What do you offer?')).toBeVisible();
  await page.getByRole('button', { name: 'Looks right' }).click();

  // Who to meet. The demo's search makes up people on .example addresses, so nobody real is reached.
  await expect(page.getByText('Who do you want to meet?')).toBeVisible();
  const describe = page.getByPlaceholder('Describe them like you would to a friend');
  await describe.fill('heads of people at fintechs in Accra');
  await describe.press('Enter');
  await page.getByRole('button', { name: 'Find them' }).click();
  await expect(page.getByText('50 people found')).toBeVisible();
  const found = (await app.state()).people;
  expect(found).toHaveLength(50);
  expect(found.filter((p) => p.source === 'web' && p.note?.includes('made-up'))).toHaveLength(10);

  await page.getByRole('button', { name: 'Bring a list' }).click();
  await page.getByLabel('Paste names, one per line, or a LinkedIn search link').fill('Amina Yusuf, amina@example.com, Lagoon Pay\nJoseph Park, joseph@example.com, Ireti Labs');
  await page.getByRole('button', { name: 'Use my list' }).click();
  await expect(page.getByText('52 people found')).toBeVisible();
  const afterList = await app.state();
  expect(afterList.people).toHaveLength(52);
  expect(afterList.people.filter((p) => p.email === 'amina@example.com' || p.email === 'joseph@example.com')).toHaveLength(2);
  await page.getByRole('button', { name: 'Next' }).click();

  // A voice. Picking Direct is saved on the project.
  await expect(page.getByText('How should Callum sound?')).toBeVisible();
  await page.getByRole('button', { name: 'Direct' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect.poll(async () => (await app.state()).projects[0]?.tone).toBe('direct');

  // The plan. The words on the page are the server's own plan, and nothing is sent yet.
  // "Here's tomorrow", or the weekday the first slot falls on when tomorrow is a weekend.
  await expect(page.getByText(/^Here's \w+$/)).toBeVisible();
  const plan = await app.api<{ line: string; total: number; byChannel: { email: number } }>('/plan');
  expect(plan.total).toBeGreaterThan(0);
  await expect(page.getByText(plan.line.replace(/ Nothing goes out today\.$/, ''))).toBeVisible();
  expect((await app.state()).outbox).toHaveLength(0);

  await page.getByRole('button', { name: /^Start \w+ at 9:00$/ }).click();
  await expect(page.locator('[data-screen="day-one"]')).toBeVisible();

  // The server agrees: Callum is started, and the first ten hellos wait for an OK, none of them sent.
  const after = await app.state();
  expect(after.settings.onboarded).toBe(true);
  expect(after.projects[0]?.startedAt).not.toBeNull();
  expect(after.projects[0]?.approvalsLeft).toBe(10);
  const waiting = after.outbox.filter((o) => o.state === 'awaiting_ok');
  expect(waiting).toHaveLength(10);
  expect(after.outbox.filter((o) => o.state === 'sent' || o.state === 'sending')).toHaveLength(0);
  for (const o of waiting) {
    expect(['hello', 'invite']).toContain(o.kind);
    expect(new Date(o.sendAfter).getTime()).toBeGreaterThan(Date.now());
    expect(o.body).not.toMatch(/\[[A-Z ]+\]|\{\{?\w+\}?\}/);
  }
});
