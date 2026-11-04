import { expect, test } from '@playwright/test';
import { box } from './api';
import { addTestPanel, expectApart, openAgent, overlaps, type Who } from './agent-window-panels-api';
import { SETTINGS } from './computer-strip-api';

const PEOPLE: Who[] = ['orchestrator', 'employee'];
const WIDE = SETTINGS.filter(s => s.width === 1440);
const NARROW = SETTINGS.filter(s => s.width === 375);

for (const who of PEOPLE) {
  for (const s of WIDE) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`each panel stands left of the terminal and leaves it alone: ${named}`, async ({ page }) => {
      const { terminal, errors, connections, toggle, openPanel, panel, window, words } = await openAgent(page, s, who);
      const before = await box(terminal);
      const connected = connections();
      for (const name of ['card', 'notebook', 'task'] as const) {
        const shown = await openPanel(name);
        await expect.poll(() => box(terminal)).toEqual(before);
        const rect = await box(shown);
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

    test(`panels stand side by side and the second lies over the terminal only when it must: ${named}`, async ({ page }) => {
      const { terminal, errors, openPanel, panel } = await openAgent(page, s, who);
      const before = await box(terminal);
      await openPanel('card');
      await openPanel('notebook');
      const [first, second] = await expectApart(page, [panel('card'), panel('notebook')]);
      expect(first!.x + first!.width).toBeLessThanOrEqual(before.x);
      expect(overlaps(second!, before)).toBe(true);
      await openPanel('task');
      await expectApart(page, [panel('card'), panel('notebook'), panel('task')]);
      expect(await box(terminal)).toEqual(before);
      expect(errors).toEqual([]);
    });
  }

  test(`on a wide screen all panels that fit stand beside the terminal: ${who}`, async ({ page }) => {
    const { terminal, errors, openPanel, panel } = await openAgent(page, { lang: 'en', theme: 'dark', width: 1920 }, who);
    const before = await box(terminal);
    await openPanel('card');
    await openPanel('notebook');
    for (const rect of await expectApart(page, [panel('card'), panel('notebook')])) expect(overlaps(rect, before)).toBe(false);
    expect(await box(terminal)).toEqual(before);
    expect(errors).toEqual([]);
  });

  for (const s of NARROW) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`on a phone a panel lies over the terminal and closes with its button and Escape: ${named}`, async ({ page }) => {
      const { terminal, errors, toggle, openPanel, panel, words, connections } = await openAgent(page, s, who);
      const before = await box(terminal);
      const connected = connections();
      for (const name of ['card', 'notebook', 'task'] as const) {
        const rect = await box(await openPanel(name));
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

    test(`on a phone several panels scroll in a row, the newest in sight: ${named}`, async ({ page }) => {
      const { errors, openPanel, panel, toggle } = await openAgent(page, s, who);
      await openPanel('card');
      await openPanel('notebook');
      await expect(panel('notebook')).toBeInViewport({ ratio: 1 });
      await toggle('task').click();
      await expect(panel('task')).toBeInViewport({ ratio: 1 });
      const rects = await Promise.all((['card', 'notebook', 'task'] as const).map(name => box(panel(name))));
      for (const [i, rect] of rects.entries()) for (const other of rects.slice(i + 1)) expect(overlaps(rect, other)).toBe(false);
      await expect(toggle('card')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test(`Log still stands in the place of the terminal, panels or not: ${who}`, async ({ page }) => {
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
