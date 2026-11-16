import { expect, test } from '@playwright/test';
import { box } from './api';
import { addTestPanel, expectApart, openAgent, overlaps, PEOPLE, WIDE } from './agent-window-panels-api';

/* On a desktop each side panel stands left of an agent's terminal and leaves it alone, one made only through the
   shared mechanism too. */

for (const who of PEOPLE) {
  for (const s of WIDE) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`each panel stands left of the terminal and leaves it alone: ${named}`, async ({ page }) => {
      const { terminal, errors, connections, toggle, openPanel, panel, window, words } = await openAgent(page, s, who);
      const before = await box(terminal);
      const outer = await box(window);
      const connected = connections();
      for (const name of ['card', 'notebook', 'task'] as const) {
        const shown = await openPanel(name);
        await expect(shown.locator('.ac-body')).toHaveCSS('scrollbar-gutter', 'stable');
        if (name === 'notebook') {
          await expect(shown.locator('.notebook')).toHaveCSS('scrollbar-gutter', 'stable');
          await expect(shown.locator('.notebook-add textarea')).toHaveCSS('padding', '8px 12px');
        }
        await expect.poll(() => box(terminal)).toEqual(before);
        const rect = await box(shown);
        if (name === 'card') await page.screenshot({ path: test.info().outputPath(`desktop-one-${s.lang}-${s.theme}.png`) });
        expect(Math.abs(rect.y - outer.y), `${name} and window tops`).toBeLessThanOrEqual(1);
        expect(Math.abs(rect.y + rect.height - outer.y - outer.height), `${name} and window bottoms`).toBeLessThanOrEqual(1);
        expect(overlaps(rect, before)).toBe(false);
        expect(rect.x + rect.width).toBeLessThanOrEqual(before.x);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        await shown.getByRole('button', { name: words.close, exact: true }).click();
        await expect(panel(name)).toHaveCount(0);
        await expect(toggle(name)).toBeFocused();
        expect(await box(terminal)).toEqual(before);
      }
      expect(await box(window)).toMatchObject({ width: before.width + 2 });
      expect(connections()).toBe(connected);
      expect(errors).toEqual([]);
    });
  }

  test(`on a wide screen all panels that fit stand beside the terminal: ${who}`, async ({ page }) => {
    const { terminal, errors, openPanel, panel, window } = await openAgent(page, { lang: 'en', theme: 'dark', width: 1920 }, who);
    const before = await box(terminal);
    const outer = await box(window);
    await openPanel('card');
    await openPanel('notebook');
    for (const rect of await expectApart(page, [panel('card'), panel('notebook')])) {
      expect(Math.abs(rect.y - outer.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(rect.y + rect.height - outer.y - outer.height)).toBeLessThanOrEqual(1);
      expect(overlaps(rect, before)).toBe(false);
    }
    expect(await box(terminal)).toEqual(before);
    expect(errors).toEqual([]);
  });

  test(`a panel made only through the shared mechanism behaves the same: ${who}`, async ({ page }) => {
    await addTestPanel(page);
    const { window, terminal, errors, words } = await openAgent(page, { lang: 'en', theme: 'dark', width: 1440 }, who);
    const before = await box(terminal);
    const toggle = window.locator(':scope > .t-bar').getByRole('button', { name: 'Test panel', exact: true });
    await toggle.click();
    const shown = window.getByRole('complementary', { name: 'Test panel', exact: true });
    await expect(shown).toHaveText(/What the test panel says/);
    const rect = await box(shown);
    expect(await box(terminal)).toEqual(before);
    expect(overlaps(rect, before)).toBe(false);
    expect(rect.x + rect.width).toBeLessThanOrEqual(before.x);
    expect(rect.width).toBe(400);
    await page.keyboard.press('Escape');
    await expect(shown).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await shown.getByRole('button', { name: words.close, exact: true }).click();
    await expect(shown).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
