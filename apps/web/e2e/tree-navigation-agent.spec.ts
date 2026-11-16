import { expect, test } from '@playwright/test';
import { box } from './api';
import { openTree, variants } from './tree-navigation-steps';

/* An agent's window opened from the tree; tree-navigation-steps.ts says what the tree holds. */
test.use({ hasTouch: true });

for (const { lang, theme, width, variant, close } of variants()) {
  test(`agent window from the tree in ${variant}`, async ({ page }, info) => {
    const { errors } = await openTree(page, lang, theme, width);
    const speedName = lang === 'en' ? 'Speed' : 'Скорость';
    await page.getByRole('button', { name: speedName, exact: true }).click();
    const speed = page.getByRole('complementary', { name: speedName, exact: true });
    const leftFrame = await box(speed);
    await speed.getByRole('button', { name: close, exact: true }).click();
    await page.locator('.tv-labs').getByRole('button', { name: /Bruno/ }).click();
    const preview = page.locator('.tv-card');
    await expect(preview).toBeVisible();
    await preview.locator('h4').getByRole('button', { name: /^Bruno/ }).click();
    const agent = page.getByRole('complementary', { name: 'Bruno', exact: true });
    await expect(agent).toBeVisible();
    await expect(page.locator('.tv-card')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`tree-agent-${lang}-${theme}-${width}.png`) });
    await agent.getByRole('button', { name: lang === 'en' ? 'Card' : 'Карточка', exact: true }).click();
    const card = agent.getByRole('complementary', { name: lang === 'en' ? 'Card: Bruno' : 'Карточка: Bruno', exact: true });
    await expect(card).toHaveClass('acard');
    expect(await box(card)).toMatchObject({ width: width === 375 ? width : leftFrame.width });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
