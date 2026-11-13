import { expect, test } from '@playwright/test';
import { box } from './api';
import { addTestPanel, barButtons, expectApart, openAgent, overlaps, type Who } from './agent-window-panels-api';
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

  for (const s of NARROW) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`the window's bar stays one row on a phone, with every button in reach: ${named}`, async ({ page }) => {
      const { bar, back, errors, openPanel, panel, words, window } = await openAgent(page, s, who);
      /* The word of the switch between the chat and the terminal. */
      const word = (label: string) => bar.getByRole('button', { name: label, exact: true }).locator('span');
      const inOneRow = async (count: number) => {
        const buttons = await barButtons(bar);
        expect(buttons.map(b => b.name)).toHaveLength(count);
        expect((await box(bar)).height).toBeLessThanOrEqual(40);
        expect(await bar.evaluate(row => row.scrollWidth - row.clientWidth), 'the bar scrolls by').toBe(0);
        for (const b of buttons) {
          expect(b.x, String(b.name)).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width, String(b.name)).toBeLessThanOrEqual(s.width);
          expect(b.width, String(b.name)).toBeGreaterThanOrEqual(26);
          expect(b.height, String(b.name)).toBeGreaterThanOrEqual(26);
        }
        for (const [i, b] of buttons.entries()) for (const other of buttons.slice(i + 1)) expect(overlaps(b, other), `${b.name}, ${other.name}`).toBe(false);
      };
      const resting = (await barButtons(bar)).length;
      await inOneRow(resting);
      await openPanel('card');
      await expect(back).toBeVisible();
      await inOneRow(resting + 1);
      /* The panel covers the whole window here, and the way back takes the room of the switch's word: the switch keeps its icon
         and its name. */
      await expect(word(words.log)).toBeHidden();
      await page.screenshot({ path: test.info().outputPath(`bar-with-panel-${who}-${s.lang}-${s.theme}.png`) });
      await back.click();
      await expect(panel('card')).toHaveCount(0);
      await expect(back).toHaveCount(0);
      await expect(word(words.log)).toBeVisible();
      await inOneRow(resting);

      /* In the chat the switch says Terminal, a longer word, and the way back leads to the conversation. */
      const backToChat = bar.getByRole('button', { name: words.backToChat, exact: true });
      await bar.getByRole('button', { name: words.log, exact: true }).click();
      await expect(window.getByRole('log')).toBeVisible();
      const chatting = (await barButtons(bar)).length;
      await inOneRow(chatting);
      await openPanel('card');
      await expect(backToChat).toBeVisible();
      await inOneRow(chatting + 1);
      await expect(word(words.terminal)).toBeHidden();
      await page.screenshot({ path: test.info().outputPath(`bar-with-panel-in-chat-${who}-${s.lang}-${s.theme}.png`) });
      await backToChat.click();
      await expect(panel('card')).toHaveCount(0);
      await expect(word(words.terminal)).toBeVisible();
      await inOneRow(chatting);
      await bar.getByRole('button', { name: words.terminal, exact: true }).click();
      await expect(window.locator('.xterm-screen')).toBeVisible();
      await inOneRow(resting);

      await bar.getByRole('button', { name: words.full, exact: true }).click();
      await inOneRow(resting);
      expect(errors).toEqual([]);
    });

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
