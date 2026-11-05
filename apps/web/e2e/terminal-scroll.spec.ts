import { expect, test, type Page } from '@playwright/test';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

type Profile = 'claude' | 'codex' | 'kimi' | 'agy';
const PROFILES: Profile[] = ['claude', 'codex', 'kimi', 'agy'];
const SNAPSHOT = process.env.TERMINAL_SCROLL_SNAPSHOT ?? 'after';

function history(profile: Profile): string {
  const lines = Array.from({ length: 80 }, (_, i) => `HISTORY-${i}`).join('\r\n');
  const mouse = '\x1b[?1000h\x1b[?1006h';
  const alternate = profile === 'agy' ? '\x1b[?1049h' : '';
  return `${lines}\r\n${alternate}${mouse}${profile}-LIVE-0`;
}

async function openTerminal(page: Page, profile: Profile, write: boolean) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', 'dark');
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sent: string[] = [];
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: write, sent };
  await serveAgentWindow(page, live);
  let sendOutput = (data: string) => { void data; };
  await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
    live.connections++;
    ws.onMessage(message => sent.push(String(message)));
    ws.send(JSON.stringify({ type: 'ready', write }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: history(profile) }));
    sendOutput = data => ws.send(JSON.stringify({ type: 'data', data }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const window = page.getByRole('complementary', { name: /^Bruno,/ });
  const rows = window.locator('.xterm-rows');
  await expect(rows).toContainText(`${profile}-LIVE-0`);
  sent.length = 0;
  const box = await window.locator('.xterm-screen').boundingBox();
  const wheel = async (deltaY: number) => {
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, deltaY);
  };
  return { window, rows, wheel, sent, errors, sendOutput };
}

for (const profile of PROFILES) {
  for (const write of [false, true]) {
    test(`wheel scrolls ${profile} history locally with write=${write}`, async ({ page }, info) => {
      const { rows, wheel, sent, errors } = await openTerminal(page, profile, write);
      await page.screenshot({ path: info.outputPath(`${profile}-${write}-${SNAPSHOT}-initial.png`) });
      await wheel(-8000);
      await expect(rows).toContainText('HISTORY-0');
      expect(sent).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${profile}-${write}-${SNAPSHOT}.png`) });
      expect(errors).toEqual([]);
    });
  }
}

for (const write of [false, true]) {
  test(`new output grows history without moving the reader with write=${write}`, async ({ page }) => {
    const { rows, wheel, sent, errors, sendOutput } = await openTerminal(page, 'agy', write);
    await wheel(-8000);
    await expect(rows).toContainText('HISTORY-0');
    sendOutput('\r\nagy-LIVE-UPDATE');
    await expect(rows).toContainText('HISTORY-0');
    for (let i = 0; i < 2; i++) await wheel(2000);
    await expect(rows).toContainText('agy-LIVE-UPDATE');
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('resizing keeps the alternate history line being read', async ({ page }) => {
  const { rows, wheel, sent, errors } = await openTerminal(page, 'agy', false);
  for (let i = 0; i < 8; i++) await wheel(-1000);
  await expect(rows).toContainText('HISTORY-0');
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(rows).toContainText('HISTORY-0');
  expect(sent.filter(message => JSON.parse(message).type !== 'resize')).toEqual([]);
  expect(errors).toEqual([]);
});
