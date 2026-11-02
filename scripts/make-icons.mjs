// Renders the app icon and the tray icons from public/icon.svg's Sun dot mark with Playwright's Chromium.
// Run: node scripts/make-icons.mjs   (build/icon.png 1024 px; build/tray/*.png)
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appIcon = await readFile(join(root, 'public/icon.svg'), 'utf8');
const SUN = '#FFB020';

// A disc that fills three quarters of the square, which reads well at menu bar sizes.
const disc = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%"><circle cx="16" cy="16" r="12" fill="${fill}"/></svg>`;

const jobs = [
  { file: 'build/icon.png', size: 1024, svg: appIcon },
  // macOS template images: black with transparency; the system tints them for light and dark menu bars.
  { file: 'build/tray/trayTemplate.png', size: 16, svg: disc('#000') },
  { file: 'build/tray/trayTemplate@2x.png', size: 32, svg: disc('#000') },
  // Windows and Linux: the coloured sun disc.
  { file: 'build/tray/tray.png', size: 32, svg: disc(SUN) },
  { file: 'build/tray/tray@2x.png', size: 64, svg: disc(SUN) },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.size, height: job.size } });
    await page.setContent(`<html><body style="margin:0;background:transparent;width:${job.size}px;height:${job.size}px">${job.svg.replace(/width="\d+" height="\d+"/, `width="${job.size}" height="${job.size}"`)}</body></html>`);
    await writeFile(join(root, job.file), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: job.size, height: job.size } }));
    await page.close();
    console.log(`wrote ${job.file} (${job.size}px)`);
  }
} finally {
  await browser.close();
}
