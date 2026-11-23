import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { TurnRefusal } from '../src/types';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';
import { chooseTerminal } from './api';
import { checkPage, open, shot, watchErrors, type Settings } from './agent-window-steps';

const fixture = (turnRefused: TurnRefusal | null): AgentFixture => ({ awake: true, hasTask: false, messages: [], connections: 0, sent: [], turnRefused });

async function atSize(page: import('@playwright/test').Page, { lang, theme, width }: Settings) {
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(([chosen, look]) => {
    localStorage.setItem('hh-lang', chosen!);
    localStorage.setItem('hh-theme', look!);
  }, [lang, theme]);
  await chooseTerminal(page);
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`the window says why a turn did not open, ${lang}, ${theme}, ${width}`, async ({ page }, info) => {
        const settings: Settings = { lang, theme, width };
        const errors = watchErrors(page);
        await atSize(page, settings);
        const live = fixture('unknown_words');
        await serveAgentWindow(page, live);
        const t = lang === 'en' ? en : ru;
        const window = await open(page, 'b1', lang);
        await expect(window.locator('.xterm-screen')).toBeVisible();
        const note = window.getByRole('status').filter({ hasText: t.window.turnRefused.unknown_words });
        await expect(note).toBeVisible();
        const box = (await note.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await shot(page, info, 'turn-refused', settings);
        await checkPage(page, errors);
      });
    }
  }
}

test('the note goes once a new turn began', async ({ page }) => {
  const live = fixture('busy');
  await atSize(page, { lang: 'en', theme: 'light', width: 1440 });
  await serveAgentWindow(page, live);
  await page.clock.install();
  const window = await open(page, 'b1', 'en');
  await expect(window.getByText(en.window.turnRefused.busy)).toBeVisible();
  live.turnRefused = null;
  /* The window looks again every 15 s when no news comes; the page's clock passes them at once. */
  await page.clock.runFor(15_000);
  await expect(window.getByText(en.window.turnRefused.busy)).toHaveCount(0);
});

test('keys typed while the view of the session connects again reach the program in order', async ({ page }) => {
  const errors = watchErrors(page);
  const live = fixture(null);
  await atSize(page, { lang: 'en', theme: 'dark', width: 1440 });
  await serveAgentWindow(page, live);
  const got: string[] = [];
  let connections = 0;
  let dropped = false;
  let closed = false;
  await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
    connections++;
    ws.onMessage(message => {
      const { type, data } = JSON.parse(String(message)) as { type: string; data?: string };
      if (type === 'input') got.push(data!);
      /* The view that gets the first key goes away, as when the machine drops for a moment. In a dev build React opens
         the first view twice, so that is not always the first view opened. */
      if (!dropped && type === 'input') {
        dropped = true;
        void ws.close({ code: 4410, reason: 'node_offline' }).then(() => { closed = true; });
      }
    });
    ws.send(JSON.stringify({ type: 'ready', write: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
  });
  const start = Date.parse('2026-11-09T10:00:00Z');
  await page.clock.install({ time: start });
  const window = await open(page, 'b1', 'en');
  await window.locator('.xterm-screen').click();
  /* From here the page's clock moves only when the test moves it. */
  await page.clock.pauseAt(start + 60_000);
  await page.keyboard.type('x');
  await expect.poll(() => got.length).toBeGreaterThan(0);
  await expect.poll(() => closed).toBe(true);
  await page.clock.runFor(10);
  /* The view went down without flashing its loader over the screen, and waits half a second before reconnecting. */
  await expect(window.locator('.t-load')).toHaveCount(0);
  await page.keyboard.type('queued');
  await page.keyboard.press('Enter');
  await page.clock.runFor(500);
  await expect.poll(() => got.join('')).toBe('xqueued\r');
  expect(connections).toBeGreaterThan(1);
  expect(errors.filter(line => !line.includes('WebSocket'))).toEqual([]);
});
