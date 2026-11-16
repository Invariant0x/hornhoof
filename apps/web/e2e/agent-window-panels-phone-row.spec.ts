import { expect, test } from '@playwright/test';
import { box } from './api';
import { NARROW, openAgent, overlaps, PEOPLE } from './agent-window-panels-api';

/* On a phone several panels scroll in a row, the newest in sight. */

for (const who of PEOPLE) {
  for (const s of NARROW) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`on a phone several panels scroll in a row, the newest in sight: ${named}`, async ({ page }) => {
      const { terminal, errors, openPanel, panel, toggle } = await openAgent(page, s, who);
      const before = await box(terminal);
      await openPanel('card');
      await openPanel('notebook');
      await page.screenshot({ path: test.info().outputPath(`phone-two-${s.lang}-${s.theme}.png`) });
      await expect(panel('notebook')).toBeInViewport({ ratio: 1 });
      await toggle('task').click();
      await expect(panel('task')).toBeInViewport({ ratio: 1 });
      const rects = await Promise.all((['card', 'notebook', 'task'] as const).map(name => box(panel(name))));
      for (const rect of rects) expect(Math.abs(rect.y - before.y)).toBeLessThanOrEqual(1);
      for (const [i, rect] of rects.entries()) for (const other of rects.slice(i + 1)) expect(overlaps(rect, other)).toBe(false);
      await expect(toggle('card')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
