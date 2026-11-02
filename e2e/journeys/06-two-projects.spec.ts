// Journey 6: two projects. Start a new one, switch between them, pause one while the other keeps going, wrap one up with its CSV.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openCallum, seed, startCallum, type Running } from '../support.js';

let app: Running;
test.beforeAll(async () => {
  app = await startCallum({ scene: 'fresh' });
});
test.afterAll(async () => {
  await app.stop();
});

test('new project, switch, pause one, wrap one with its CSV', async ({ page }) => {
  await seed(app, 'fresh');
  // The first project is started and its ten OKs given the way the API does it (First run and Day one have their own journeys).
  await app.api('/start', { projectId: 1 });
  for (const item of (await app.state()).outbox.filter((o) => o.state === 'awaiting_ok')) await app.api(`/outbox/${item.id}/approve`, {});
  let s = await app.state();
  expect(s.projects.map((p) => [p.name, p.state, p.approvalsLeft])).toEqual([['Reconciliation', 'running', 0]]);

  await openCallum(page, app, 'home');

  // A new project: the offer, who to meet (a pasted list), the plan, Start.
  await page.getByRole('button', { name: /Projects, now showing/ }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('[data-screen="new-project"]')).toBeVisible();
  await page.getByRole('button', { name: /Payroll example/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByText('Paste names', { exact: true }).click();
  await page.locator('textarea').first().fill('Rita Obi, rita@example.com, Obi Foods\nSam Lee, sam@example.com, Lee Logistics');
  await page.getByRole('button', { name: 'Read the names' }).click();
  await page.getByRole('button', { name: /These 2 look right/ }).first().click();
  await page.getByRole('button', { name: 'Start Payroll' }).click();
  await expect(page.getByText('Payroll is ready')).toBeVisible();
  await page.getByRole('button', { name: /See Payroll at home/ }).click();
  await expect(page.getByRole('button', { name: 'Projects, now showing Payroll' })).toBeVisible();

  s = await app.state();
  expect(s.projects.map((p) => p.name)).toEqual(['Reconciliation', 'Payroll']);
  const payroll = s.projects.find((p) => p.name === 'Payroll')!;
  expect(payroll.state).toBe('running');
  expect(payroll.startedAt).not.toBeNull();
  const rita = s.people.find((p) => p.email === 'rita@example.com')!;
  expect(rita.projectId).toBe(payroll.id);
  expect(s.people.filter((p) => p.projectId === payroll.id)).toHaveLength(2);
  // Nothing has gone to Rita or Sam; their hellos wait for the OKs of the new project.
  expect(app.sql("select * from messages where person_id = ?", rita.id)).toHaveLength(0);
  expect(s.outbox.filter((o) => o.personId === rita.id).every((o) => o.state === 'awaiting_ok')).toBe(true);

  // Switch: the server remembers which project is current.
  await page.getByRole('button', { name: /Projects, now showing/ }).click();
  await page.getByRole('button', { name: /^Reconciliation/ }).first().click();
  await expect.poll(async () => (await app.state()).settings.currentProjectId).toBe(1);
  await expect(page.getByRole('button', { name: 'Projects, now showing Reconciliation' })).toBeVisible();

  // Pause Reconciliation. Payroll is untouched and keeps running.
  await page.getByRole('button', { name: /Projects, now showing/ }).click();
  await page.getByRole('button', { name: 'More for Reconciliation' }).click();
  await page.getByRole('menuitem', { name: 'Pause Reconciliation' }).click();
  await expect(page.getByText('Reconciliation is paused. Nothing goes out from it until you resume.')).toBeVisible();
  s = await app.state();
  expect(s.projects.map((p) => [p.name, p.state])).toEqual([['Reconciliation', 'paused'], ['Payroll', 'running']]);
  expect(s.settings.pauseState).toBe('running');

  // And back (the list of projects is still open after a pause).
  await expect(page.getByRole('dialog', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'More for Reconciliation' }).click();
  await page.getByRole('menuitem', { name: 'Resume Reconciliation' }).click();
  await expect.poll(async () => (await app.state()).projects.find((p) => p.name === 'Reconciliation')?.state).toBe('running');

  // Wrap Payroll up, downloading its people first. The CSV is Payroll's people and only theirs.
  await expect(page.getByRole('dialog', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'More for Payroll' }).click();
  await page.getByRole('menuitem', { name: /^Wrap up/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download and wrap up' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^callum-export-.*\.csv$/);
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('Rita Obi');
  expect(csv).toContain('sam@example.com');
  expect(csv).not.toContain('Kemi Eze');

  await expect.poll(async () => (await app.state()).projects.find((p) => p.name === 'Payroll')?.state).toBe('wrapped');
  s = await app.state();
  expect(s.projects.find((p) => p.name === 'Reconciliation')?.state).toBe('running');
  // Wrapping cancels what had not gone out: Rita and Sam have nothing waiting.
  expect(s.outbox.filter((o) => s.people.filter((p) => p.projectId === payroll.id).some((p) => p.id === o.personId) && ['awaiting_ok', 'scheduled'].includes(o.state))).toHaveLength(0);
  // The server's own export says the same thing as the download.
  const direct = await app.raw(`/api/export.csv?projectId=${payroll.id}`);
  expect(direct.status).toBe(200);
  expect(direct.headers.get('content-type')).toContain('text/csv');
  expect(direct.body).toBe(csv);
});
