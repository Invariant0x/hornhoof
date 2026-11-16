import { expect, test } from '@playwright/test';
import { box } from './api';
import { barButtons, expectApart, openAgent, PEOPLE, WIDE } from './agent-window-panels-api';

/* The way back to the terminal while a panel covers it, and panels in full screen. */

for (const who of PEOPLE) {
  for (const s of WIDE) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`the way back to the terminal is there only while a panel covers it: ${named}`, async ({ page }) => {
      const { bar, back, errors, words, openPanel, panel } = await openAgent(page, s, who);
      const resting = await barButtons(bar);
      await openPanel('card');
      await expect(back).toHaveCount(0);
      expect(await barButtons(bar)).toEqual(resting);

      await openPanel('notebook');
      await expect(back).toBeVisible();
      /* It takes its room from the title: nothing to the right of it moves. */
      expect(await barButtons(bar).then(all => all.filter(b => b.name !== words.back))).toEqual(resting);
      await back.click();
      await expect(panel('notebook')).toHaveCount(0);
      await expect(back).toHaveCount(0);

      await page.setViewportSize({ width: 1100, height: 900 });
      await expect(back).toBeVisible();
      /* A department's panel takes the window's width alone, which leaves room for the row beside it. */
      if (who === 'employee') {
        const about = page.getByRole('button', { name: s.lang === 'en' ? 'About the department' : 'Об отделе', exact: true });
        await about.click();
        await expect(back).toHaveCount(0);
        await about.click();
        await expect(back).toBeVisible();
      }
      await page.setViewportSize({ width: s.width, height: 900 });
      await expect(back).toHaveCount(0);

      await bar.getByRole('button', { name: words.full, exact: true }).click();
      await expect(back).toBeVisible();
      await bar.getByRole('button', { name: words.size, exact: true }).click();
      await expect(back).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  test(`full screen: panels lie over the terminal below the window's bar, which stays in reach: ${who}`, async ({ page }) => {
    const { window, terminal, errors, words, openPanel, panel, toggle } = await openAgent(page, { lang: 'en', theme: 'dark', width: 1440 }, who);
    await window.locator(':scope > .t-bar').getByRole('button', { name: words.full, exact: true }).click();
    await expect.poll(async () => (await box(window)).width).toBe(1440);
    const before = await box(terminal);
    const rect = await box(await openPanel('card'));
    expect(await box(terminal)).toEqual(before);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(before.y);
    await openPanel('notebook');
    await expectApart(page, [panel('card'), panel('notebook')]);
    expect(await box(terminal)).toEqual(before);
    await window.locator(':scope > .t-bar').getByRole('button', { name: words.size, exact: true }).click();
    await expect.poll(async () => (await box(terminal)).width).toBeLessThan(before.width);
    await expect(panel('card')).toBeVisible();
    await expect(toggle('card')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
