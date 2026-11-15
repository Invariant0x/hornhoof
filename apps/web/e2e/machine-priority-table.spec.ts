import { expect, test } from '@playwright/test';
import { brokenHeaderWords, tableFits } from './api';
import { LONG, noSideScroll, openMachines, SIZES, within } from './machine-priority-steps';

/* The Priority column: header words stay whole, the table stands in its frame, and machines stand in their order. */

/* A header breaks only between its words, and the table stands inside its frame: as a table where it fits by whole
   words, as entries where it does not. */
for (const language of ['en', 'ru'] as const) for (const width of [1440, 1024]) {
  test(`keeps every header word whole and the table inside its frame, ${language} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openMachines(page, language, 'light');
    expect(await brokenHeaderWords(page)).toEqual([]);
    expect(await tableFits(page)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`table-${language}-${width}.png`), fullPage: true });
  });
}

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const [width, height] of SIZES) {
  const place = `${language} ${theme} ${width}`;
  const shot = (name: string) => `${name}-${language}-${theme}-${width}.png`;

  test(`orders the machines by their place, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openMachines(page, language, theme);
    const rows = page.locator('tr.rm');
    await expect(rows).toHaveCount(6);
    expect(await rows.evaluateAll(all => all.map(row => row.getAttribute('aria-label')))).toEqual(['rack-01', 'dev-studio', LONG, 'lab-nuc', 'marat-pc', 'olga-air']);
    /* On a wide screen the column's header stands on one line, as tall as the others. */
    if (width > 780) expect(new Set(await page.locator('table.dt thead th button').evaluateAll(all => all.map(one => Math.round(one.getBoundingClientRect().height)))).size).toBe(1);
    /* The number's box is as tall in every row, and the server's is filled. */
    const boxes = page.locator('td.k-prio .pn');
    await expect(boxes).toHaveCount(4);
    expect(new Set(await boxes.evaluateAll(all => all.map(one => Math.round(one.getBoundingClientRect().height))))).toEqual(new Set([22]));
    const filled = await boxes.evaluateAll(all => all.map(one => getComputedStyle(one).backgroundColor));
    expect(filled[0]).not.toBe(filled[1]);
    expect(filled[1]).toBe(filled[2]);
    /* A machine with no number has a dash, and its words for a reader of the screen. */
    await expect(page.locator('td.k-prio .pdash')).toHaveCount(2);
    for (const dash of await page.locator('td.k-prio .pdash').all()) await expect(dash).toBeVisible();
    for (const cell of await page.locator('td.k-prio').all()) expect(await within(cell, page.locator('table.dt'))).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('table')), fullPage: true });
  });
}
