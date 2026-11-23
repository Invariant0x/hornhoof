import { expect, test } from '@playwright/test';
import { box } from './api';
import { expectApart, openAgent, overlaps, PEOPLE, WIDE } from './agent-window-panels-api';

/* Panels side by side, the chat in the place of the terminal, and what Escape and minimizing do to panels. */

for (const who of PEOPLE) {
  for (const s of WIDE) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`panels stand side by side and the second lies over the terminal only when it must: ${named}`, async ({ page }) => {
      const { terminal, errors, openPanel, panel, window } = await openAgent(page, s, who);
      const before = await box(terminal);
      const outer = await box(window);
      await openPanel('card');
      await openPanel('notebook');
      await page.screenshot({ path: test.info().outputPath(`desktop-two-${s.lang}-${s.theme}.png`) });
      const [first, second] = await expectApart(page, [panel('card'), panel('notebook')]);
      for (const rect of [first!, second!]) {
        expect(Math.abs(rect.y - outer.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(rect.y + rect.height - outer.y - outer.height)).toBeLessThanOrEqual(1);
      }
      expect(first!.x + first!.width).toBeLessThanOrEqual(before.x);
      expect(overlaps(second!, before)).toBe(true);
      await openPanel('task');
      for (const rect of await expectApart(page, [panel('card'), panel('notebook'), panel('task')])) {
        expect(Math.abs(rect.y - outer.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(rect.y + rect.height - outer.y - outer.height)).toBeLessThanOrEqual(1);
      }
      expect(await box(terminal)).toEqual(before);
      expect(errors).toEqual([]);
    });
  }

  test(`The chat still stands in the place of the terminal, panels or not: ${who}`, async ({ page }) => {
    const { window, terminal, errors, words, openPanel, panel } = await openAgent(page, { lang: 'en', theme: 'light', width: 1440 }, who);
    await window.getByRole('button', { name: words.log, exact: true }).click();
    await expect(terminal).toHaveCount(0);
    const log = window.getByRole('log');
    await expect(log).toBeVisible();
    await expect(window.locator('.side-panel')).toHaveCount(0);
    const place = await box(log);
    const inWindow = await box(window);
    expect(place.x).toBeGreaterThanOrEqual(inWindow.x);
    expect(place.x + place.width).toBeLessThanOrEqual(inWindow.x + inWindow.width);
    expect(overlaps(await box(await openPanel('card')), place)).toBe(false);
    expect(await box(log)).toEqual(place);
    await window.getByRole('button', { name: words.terminal, exact: true }).click();
    await expect(terminal).toBeVisible();
    await expect(panel('card')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('Escape closes the newest panel first, and the terminal does not hear it', async ({ page }) => {
  const { window, panel, openPanel, stops, sent, errors } = await openAgent(page, { lang: 'en', theme: 'dark', width: 1440 }, 'employee');
  const heard = () => sent.filter(frame => frame.includes('\\u001b'));
  await openPanel('card');
  await openPanel('notebook');
  await window.locator('.xterm-screen').click();
  await expect(window.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel('notebook')).toHaveCount(0);
  await expect(panel('card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel('card')).toHaveCount(0);
  expect(stops).toEqual([]);
  expect(heard()).toEqual([]);
  await window.locator('.xterm-screen').click();
  await expect(window.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(heard).toHaveLength(1);
  await window.focus();
  await page.keyboard.press('Escape');
  const stopDialog = page.getByRole('alertdialog');
  await expect(stopDialog).toBeVisible();
  expect(stops).toEqual([]);
  await stopDialog.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => stops).toEqual(['POST']);
  expect(errors).toEqual([]);
});

test('a minimized window takes its panels with it and brings them back', async ({ page }) => {
  const { window, panel, openPanel, stops, words, errors } = await openAgent(page, { lang: 'en', theme: 'dark', width: 1440 }, 'employee');
  await openPanel('card');
  await window.getByRole('button', { name: words.minimize, exact: true }).click();
  await expect(window).toBeHidden();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Restore Bruno/ }).click();
  await expect(panel('card')).toBeVisible();
  expect(stops).toEqual([]);
  expect(errors).toEqual([]);
});

test('a text someone is writing in a panel is not lost to Escape', async ({ page }) => {
  const { panel, openPanel, errors } = await openAgent(page, { lang: 'en', theme: 'dark', width: 1440 }, 'orchestrator');
  const notebook = await openPanel('notebook');
  const note = notebook.getByRole('textbox', { name: 'New note' });
  await note.fill('A draft of a note');
  await note.focus();
  await page.keyboard.press('Escape');
  await expect(panel('notebook')).toBeVisible();
  await expect(note).toHaveValue('A draft of a note');
  await page.keyboard.press('Escape');
  await expect(panel('notebook')).toHaveCount(0);
  expect(errors).toEqual([]);
});
