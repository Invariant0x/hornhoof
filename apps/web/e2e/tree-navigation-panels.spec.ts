import { expect, test } from '@playwright/test';
import { box } from './api';
import { openTree, variants } from './tree-navigation-steps';

/* The department's panels on the left of the tree; tree-navigation-steps.ts says what the tree holds. */
test.use({ hasTouch: true });

for (const { lang, theme, width, variant, close } of variants()) {
  test(`left department panels in ${variant}`, async ({ page }, info) => {
    const { errors, writes } = await openTree(page, lang, theme, width);
    const names = lang === 'en' ? ['Department tasks', 'About the department', 'Speed'] : ['Задачи отдела', 'Об отделе', 'Скорость'];
    const panels = [];
    for (const name of names) {
      await page.getByRole('button', { name, exact: true }).click();
      const panel = page.getByRole('complementary', { name, exact: true });
      await expect(panel).toBeVisible();
      panels.push(await box(panel));
      if (name !== names[2]) await panel.getByRole('button', { name: close, exact: true }).click();
    }
    expect(panels[0]!.x).toBe(16);
    expect(panels[1]).toEqual(panels[0]);
    expect(panels[2]).toEqual(panels[0]);
    await page.screenshot({ path: info.outputPath(`speed-left-${lang}-${theme}-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
