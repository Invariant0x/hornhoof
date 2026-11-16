import { expect, test } from '@playwright/test';
import { box } from './api';
import { addTestPanel, NARROW, openAgent, PEOPLE } from './agent-window-panels-api';

/* On a phone a panel lies over the terminal, one made only through the shared mechanism too. */

for (const who of PEOPLE) {
  for (const s of NARROW) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`on a phone a panel lies over the terminal and closes with its button and Escape: ${named}`, async ({ page }) => {
      const { terminal, errors, toggle, openPanel, panel, words, connections } = await openAgent(page, s, who);
      const before = await box(terminal);
      const connected = connections();
      for (const name of ['card', 'notebook', 'task'] as const) {
        const rect = await box(await openPanel(name));
        if (name === 'card') await page.screenshot({ path: test.info().outputPath(`phone-one-${s.lang}-${s.theme}.png`) });
        expect(Math.abs(rect.y - before.y), `${name} and terminal tops`).toBeLessThanOrEqual(1);
        expect(rect).toMatchObject({ x: 0, width: s.width });
        await expect(terminal).toBeHidden();
        await panel(name).getByRole('button', { name: words.close, exact: true }).click();
        await expect(panel(name)).toHaveCount(0);
        await expect(toggle(name)).toBeFocused();
        await expect(terminal).toBeVisible();
        expect(await box(terminal)).toEqual(before);
        await openPanel(name);
        await page.keyboard.press('Escape');
        await expect(panel(name)).toHaveCount(0);
        await expect(toggle(name)).toBeFocused();
        await expect(terminal).toBeVisible();
      }
      expect(connections()).toBe(connected);
      expect(errors).toEqual([]);
    });
  }

  test(`on a phone the panel made through the mechanism lies over too: ${who}`, async ({ page }) => {
    await addTestPanel(page);
    const { window, terminal, errors } = await openAgent(page, { lang: 'ru', theme: 'light', width: 375 }, who);
    await window.locator(':scope > .t-bar').getByRole('button', { name: 'Test panel', exact: true }).click();
    const shown = window.getByRole('complementary', { name: 'Test panel', exact: true });
    expect(await box(shown)).toMatchObject({ x: 0, width: 375 });
    await expect(terminal).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(shown).toHaveCount(0);
    await expect(terminal).toBeVisible();
    expect(errors).toEqual([]);
  });
}
