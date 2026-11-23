import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { BARS, open, VIEWS, WIDTHS, type Look } from './map-overlay-view';

/* The pictures Design asked for on #1635 (#1639): the map and an open department with the update's bar, the wait for the
   nodes' agents, both and neither, at 375 and 1440, in Cyberpunk, Light and Matrix, English left to right and Russian right
   to left, in each engine. They go to SHOTS_DIR, else beside this test's results; each line SHOT names one and its sha256. */
test.describe.configure({ timeout: 0 });

const SHOTS = process.env.SHOTS_DIR ?? fileURLToPath(new URL('results/map-overlay-shots', import.meta.url));
const SKINS = ['cyberpunk', 'light', 'matrix'];
const PAIRS: Pick<Look, 'lang' | 'dir'>[] = [{ lang: 'en', dir: 'ltr' }, { lang: 'ru', dir: 'rtl' }];
const BAR_NAMES = ['none', 'update', 'node-wait', 'both'];

for (const view of VIEWS) for (const [b, bars] of BARS.entries()) for (const width of WIDTHS) for (const skin of SKINS) for (const pair of PAIRS) {
  const name = `${view}-${BAR_NAMES[b]}-${width}-${skin}-${pair.lang}-${pair.dir}`;
  test(`shot ${name}`, async ({ page }, info) => {
    await open(page, { ...pair, skin }, width, bars, view);
    const png = await page.screenshot({ animations: 'disabled' });
    mkdirSync(SHOTS, { recursive: true });
    const file = `${info.project.name}-${name}.png`;
    writeFileSync(join(SHOTS, file), png);
    console.log(`SHOT ${file} sha256=${createHash('sha256').update(png).digest('hex')}`);
  });
}
