import { expect, test, type Page } from '@playwright/test';
import { box } from './api';
import { LONG, noSideScroll, openMachines, SIZES, within, WORDS } from './machine-priority-steps';

/* The Priority part of a machine's card: its place, the choice and why. */

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const [width, height] of SIZES) {
  const place = `${language} ${theme} ${width}`;
  const w = WORDS[language];
  const shot = (name: string) => `${name}-${language}-${theme}-${width}.png`;
  const card = (page: Page, hostname: string) => page.getByRole('article', { name: hostname });
  const open = (page: Page, hostname: string) => page.getByRole('button', { name: `${w.open} ${hostname}`, exact: true }).click();

  test(`shows the place, the choice and why in the cards, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openMachines(page, language, theme);
    /* One card is open at a time, so each is looked at in turn. */
    await open(page, LONG);
    const pinned = card(page, LONG);
    await expect(pinned.getByText(w.pinned)).toBeVisible();
    const group = pinned.getByRole('radiogroup', { name: w.priority });
    const pick = pinned.getByRole('combobox', { name: w.pick(LONG) });
    await expect(pick).toHaveValue('3');
    /* Every choice and the list of places stay inside the card, each radio a square of its own size. */
    for (const one of [...(await group.getByRole('radio').all()), pick, group]) expect(await within(one, pinned)).toBe(true);
    for (const radio of await group.getByRole('radio').all()) {
      const size = await box(radio);
      expect([Math.round(size.width), Math.round(size.height)]).toEqual([16, 16]);
    }
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('pinned')), fullPage: true });
    await open(page, 'dev-studio');
    await expect(card(page, 'dev-studio').getByText(w.best)).toBeVisible();
    await open(page, 'olga-air');
    await expect(card(page, 'olga-air').getByText(w.out)).toBeVisible();
    await expect(card(page, 'olga-air').getByRole('radio', { name: w.outChoice })).toBeChecked();
    await open(page, 'rack-01');
    await expect(card(page, 'rack-01').getByText(w.line)).toBeVisible();
    await expect(card(page, 'rack-01').getByRole('radio')).toHaveCount(0);
    /* The long reason wraps inside its card, with no choice under it. */
    await open(page, 'marat-pc');
    const reason = card(page, 'marat-pc').getByText(w.scope);
    await expect(reason).toBeVisible();
    expect(await within(reason, card(page, 'marat-pc'))).toBe(true);
    await expect(card(page, 'marat-pc').getByRole('radio')).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('unfit')), fullPage: true });
  });
}
