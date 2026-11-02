// Takes the two pictures in the README from the demo: Home on a weekday morning with replies waiting, and a reply with
// Callum's draft. Run it with `npm run screenshots` after `npm run build && npm run build:server`.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { isSendingTime } from '../src/server/engine/windows.js';
import { localParts } from '../src/server/engine/time.js';
import { seed, startCallum } from '../e2e/support.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'img');
const ZONES = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'Europe/London', 'Africa/Lagos', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];

/** A time zone where it is a weekday morning (9:00 to 11:00) right now, so "Good morning" is true of the picture. */
function morningZone(): string {
  const now = new Date();
  const zone = ZONES.find((z) => isSendingTime(now, z) && localParts(now, z).hour < 11);
  if (!zone) throw new Error('It is not a weekday morning anywhere right now. Run this again in a few hours.');
  return zone;
}

const app = await startCallum({ scene: 'morning' });
const browser = await chromium.launch({ args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
try {
  mkdirSync(OUT, { recursive: true });
  await seed(app, 'morning');
  await app.api('/settings', { timezone: morningZone() });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(app.url);
  await page.locator('[data-screen="home"]').waitFor();
  await page.getByText('4 people want to talk.').waitFor();
  await page.waitForTimeout(1200); // the river settles
  await page.screenshot({ path: resolve(OUT, 'morning.png') });

  // The reply that says it best: Kemi, with a calendar link already in the draft.
  await page.getByRole('button', { name: 'Kemi Eze, replied and waiting on you' }).click();
  const deck = page.getByRole('dialog');
  await deck.getByText('Kemi Eze').waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(OUT, 'reply.png') });
  console.log(`Wrote ${resolve(OUT, 'morning.png')} and ${resolve(OUT, 'reply.png')}`);
} finally {
  await browser.close();
  await app.stop();
}
