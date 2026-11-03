// Journey 9: Callum at phone width (390). The river, a reply card with Send and Undo, Ask, You.
import { expect, test } from '@playwright/test';
import { byName, seed, startCallum, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'morning' });
});
test.afterAll(async () => {
  await app.stop();
});

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const noSideScroll = (page: import('@playwright/test').Page) =>
  page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));

test('river, send a reply and undo it, ask, and you, with no sideways scroll', async ({ page }) => {
  await seed(app, 'morning');
  let s = await app.state();
  const zainab = byName(s, 'Zainab');
  expect(zainab.status).toBe('waiting');

  await page.goto(app.url);
  await expect(page.locator('[data-screen="phone-home"]')).toBeVisible();
  // The river and the four waiting replies are on the first screen, in one column.
  await expect(page.getByText('4 people want to talk')).toBeVisible();
  await expect(page.getByText('Zainab Musa')).toBeVisible();
  expect(await noSideScroll(page)).toEqual({ page: 390, window: 390 });

  // Send the draft. It is queued with a ten second Undo, and Femi's card is next.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // While the ten seconds run the toast says what is happening; "Sent to Zainab" comes after they close.
  await expect(page.getByText('Sending your reply to Zainab')).toBeVisible();
  s = await app.state();
  const sent = s.outbox.find((o) => o.personId === zainab.id && o.kind === 'reply');
  expect(sent).toMatchObject({ state: 'scheduled', origin: 'user' });
  expect(sent?.body).toContain('Totally fair, Zainab');
  await expect(page.getByText('Femi Adeyemi')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => app.sql<{ state: string }>('select state from outbox where id = ?', sent!.id)[0]?.state).toBe('cancelled');
  expect(app.sql("select * from messages where person_id = ? and kind = 'reply'", zainab.id)).toHaveLength(0);
  await expect.poll(async () => byName(await app.state(), 'Zainab').status).toBe('waiting');
  expect(await noSideScroll(page)).toEqual({ page: 390, window: 390 });

  // Ask: a question goes to the server, and the answer on the page is the server's.
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('About your people, or who to meet next.')).toBeVisible();
  const question = page.getByRole('textbox').first();
  await question.fill("Who's warming up?");
  const [asked] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/ask')), question.press('Enter')]);
  expect(asked.status()).toBe(200);
  const answer = (await asked.json()) as { text: string };
  expect(answer.text.length).toBeGreaterThan(0);
  await expect(page.getByText(answer.text, { exact: true })).toBeVisible();
  expect(await noSideScroll(page)).toEqual({ page: 390, window: 390 });

  // You: the same name, address and channels as the server has.
  await page.getByRole('button', { name: 'You', exact: true }).click();
  await expect(page.getByText('Sending as gabriel@yourcompany.com')).toBeVisible();
  const settings = (await app.state()).settings as unknown as { senderName: string };
  await expect(page.getByText(settings.senderName, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('20 emails a day across both projects, 120 by week 3')).toBeVisible();
  expect(await noSideScroll(page)).toEqual({ page: 390, window: 390 });

  // And back to the river, where the reply is still waiting for the user.
  await page.getByRole('button', { name: /River/ }).click();
  await expect(page.getByText('Zainab Musa')).toBeVisible();
});
