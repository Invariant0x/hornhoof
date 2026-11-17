import { expect, test } from '@playwright/test';
import { box } from './api';
import { barButtons, NARROW, openAgent, overlaps, PEOPLE } from './agent-window-panels-api';

/* The bar of an agent's window stays one row on a phone, with every button in reach. */

for (const who of PEOPLE) {
  for (const s of NARROW) {
    const named = `${who}, ${s.lang}, ${s.theme}`;

    test(`the window's bar stays one row on a phone, with every button in reach: ${named}`, async ({ page }) => {
      const { bar, back, errors, openPanel, panel, words, window } = await openAgent(page, s, who);
      /* The switch between the chat and the terminal, and its word. */
      const toggleTo = (label: string) => bar.getByRole('button', { name: label, exact: true });
      const word = (label: string) => toggleTo(label).locator('span');
      /* A panel covers the whole window here, and the way back takes the room of the switch's word: the switch keeps its icon
         and its name, as wide as the way back beside it. */
      const anIcon = async (label: string, way: typeof back) => {
        await expect(word(label)).toBeHidden();
        expect((await box(toggleTo(label))).width).toBe((await box(way)).width);
      };
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
      await anIcon(words.log, back);
      await page.screenshot({ path: test.info().outputPath(`bar-with-panel-${who}-${s.lang}-${s.theme}.png`) });
      await back.click();
      await expect(panel('card')).toHaveCount(0);
      await expect(back).toHaveCount(0);
      /* The window keeps an inbox, whose icon takes the word's room on a phone. */
      await expect(word(words.log)).toBeHidden();
      await inOneRow(resting);

      /* In the chat the switch is named Terminal, and the way back leads to the conversation. */
      const backToChat = bar.getByRole('button', { name: words.backToChat, exact: true });
      await toggleTo(words.log).click();
      await expect(window.getByRole('log')).toBeVisible();
      const chatting = (await barButtons(bar)).length;
      await inOneRow(chatting);
      await openPanel('card');
      await expect(backToChat).toBeVisible();
      await inOneRow(chatting + 1);
      await anIcon(words.terminal, backToChat);
      await page.screenshot({ path: test.info().outputPath(`bar-with-panel-in-chat-${who}-${s.lang}-${s.theme}.png`) });
      await backToChat.click();
      await expect(panel('card')).toHaveCount(0);
      await expect(word(words.terminal)).toBeHidden();
      await inOneRow(chatting);
      await toggleTo(words.terminal).click();
      await expect(window.locator('.xterm-screen')).toBeVisible();
      await inOneRow(resting);

      await bar.getByRole('button', { name: words.full, exact: true }).click();
      await inOneRow(resting);
      expect(errors).toEqual([]);
    });
  }
}
