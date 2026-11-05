import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { EventView } from '../src/types';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';
import { checkPage, open, shot, watchErrors } from './agent-window-steps';

const LONG = `${'A draft with a very_long_word_'.repeat(40)}\n`.repeat(40);
const left = (seq: number, text: string, person: EventView['person']): EventView => ({ seq, kind: 'input_left', data: { text, ref: `r${seq}` }, jobId: null, person, at: '2026-11-05T14:00:00Z' });
const fixture = (): AgentFixture => ({ awake: false, hasTask: false, messages: [], connections: 0, sent: [], events: [left(1, 'A short draft', { id: 'p1', name: 'Zed' }), left(2, LONG, null)] });

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`the log keeps words left in the input, ${lang}, ${theme}, ${width}`, async ({ page }, info) => {
        const settings = { lang, theme, width };
        const errors = watchErrors(page);
        await page.setViewportSize({ width, height: 800 });
        await page.addInitScript(([chosen, look]) => {
          localStorage.setItem('hh-lang', chosen!);
          localStorage.setItem('hh-theme', look!);
        }, [lang, theme]);
        await serveAgentWindow(page, fixture());
        const t = lang === 'en' ? en : ru;
        const window = await open(page, 'b1', lang);
        await expect(window.getByText(t.window.inputLeft.by('Zed'))).toBeVisible();
        await expect(window.getByText(t.window.inputLeft.nobody)).toBeVisible();
        const words = window.locator('.t-left');
        await expect(words).toHaveCount(2);
        await expect(words.first()).toHaveText('A short draft');
        const long = (await words.nth(1).boundingBox())!;
        expect(long.x + long.width).toBeLessThanOrEqual(width);
        expect(long.height).toBeLessThanOrEqual(400);
        expect(await words.nth(1).evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        await shot(page, info, 'input-left', settings);
        await checkPage(page, errors);
      });
    }
  }
}
