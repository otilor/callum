// Journey 8: Callum on a server with a password. The sign-in page, a wrong password, the lockout with its countdown, the right password.
import { expect, test } from '@playwright/test';
import { startCallum, type Running } from '../support.js';

const PASSWORD = 'correct horse battery';
let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'morning', password: PASSWORD, signIn: false });
});
test.afterAll(async () => {
  await app.stop();
});

test.setTimeout(150_000);

test('sign in: wrong password, lockout with a countdown, then the right password', async ({ page, context }) => {
  // Closed to anyone without the password: the API says so, and nothing about the account leaks.
  const closed = await app.raw('/api/state');
  expect(closed.status).toBe(401);
  expect(JSON.stringify(closed.body)).not.toContain('Kemi');
  expect((await app.raw('/api/people/1')).status).toBe(401);
  expect((await app.raw('/api/export.csv')).status).toBe(401);

  // This week's note is marked seen from a separate session, so it does not open over the screen being looked at.
  await app.raw('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  await app.raw('/api/weekly/seen', { method: 'POST' });
  await app.raw('/api/logout', { method: 'POST' });

  await page.goto(app.url);
  await expect(page.locator('[data-screen="sign-in"]')).toBeVisible();
  const password = page.getByPlaceholder('Password');
  const signIn = page.getByRole('button', { name: 'Sign in' });

  // One wrong password: the server's own sentence, still no session.
  await password.fill('not it');
  await signIn.click();
  await expect(page.getByText("That's not the password.")).toBeVisible();
  expect((await context.cookies()).filter((c) => c.name === 'callum_session')).toHaveLength(0);
  expect((await app.raw('/api/state')).status).toBe(401);

  // Five wrong tries are allowed; the sixth is told to wait. The button then counts the seconds down.
  for (let i = 0; i < 4; i++) {
    await password.fill(`still not it ${i}`);
    const [answer] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/login')), signIn.click()]);
    expect(answer.status()).toBe(401);
  }
  await password.fill('one more');
  const [sixth] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/login')), signIn.click()]);
  expect(sixth.status()).toBe(429);
  const locked = page.getByRole('button', { name: /^Try again in \d+ s$/ });
  await expect(locked).toBeVisible();
  await expect(locked).toBeDisabled();
  const first = Number(/(\d+)/.exec(await locked.innerText())?.[1]);
  expect(first).toBeGreaterThan(40);
  expect(first).toBeLessThanOrEqual(60);
  await expect.poll(async () => Number(/(\d+)/.exec(await locked.innerText().catch(() => 'Try again in 0 s'))?.[1] ?? 0), { timeout: 8_000 }).toBeLessThan(first);

  // The right password is refused while the lockout lasts, by the server and not only by the button.
  const during = await app.raw('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  expect(during.status).toBe(429);
  expect(Number(during.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await app.raw('/api/state')).status).toBe(401);

  // When the countdown ends the button is Sign in again, and the right password opens Callum.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 70_000 });
  await password.fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
  const cookie = (await context.cookies()).find((c) => c.name === 'callum_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  const state = await page.evaluate(async () => (await fetch('/api/state')).json() as Promise<{ auth: { password: boolean }; people: unknown[] }>);
  expect(state.auth.password).toBe(true);
  expect(state.people.length).toBeGreaterThan(0);

  // Signing out closes the door again.
  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.locator('[data-screen="sign-in"]')).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/state')).status)).toBe(401);
});
