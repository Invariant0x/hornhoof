import { expect, test } from '@playwright/test';
import type { NodeWait } from '../src/types';
import { serveApi } from './api';

const COMMIT = '84c8383' + 'a'.repeat(33);
const CURRENT = { version: '0.7.0', commit: COMMIT, migrations: 62 };
const BUILD = { ...CURRENT, tag: '0.7.0', created: '2026-11-05T10:00:00Z', title: 'Each node updates by itself' };
const WAITS: NodeWait[] = [
  { node: 'builtin', provider: null, hostname: null, drain: { state: 'restarting', since: '2026-11-05T11:17:00.000Z' }, work: [] },
  { node: 'n1', provider: 'antigravity', hostname: 'node-a', drain: { state: 'waiting', turnsLeft: 1, partsLeft: 0, since: '2026-11-05T12:47:00.000Z' }, work: [{ agent: 'Developer', task: 251 }] },
  { node: 'n2', provider: 'claude', hostname: 'node-a', drain: { state: 'waiting', turnsLeft: 2, partsLeft: 1, since: '2026-11-05T13:05:00.000Z' }, work: [{ agent: 'Developer with a long name', task: 7 }, { agent: 'Head of development', task: null }] },
];
const WORDS = {
  en: {
    account: 'Account', versions: 'Versions', title: 'Updating the nodes',
    rows: [
      ['Built-in node', 'Free: being replaced now, then takes work again by itself'],
      ['Antigravity on node-a', 'Waiting since 12:47 for agents to finish before the update: 1 turn left. It takes no new work until then', 'Waits for: Developer (#251)'],
      ['Claude on node-a', 'Waiting since 13:05 for agents to finish before the update: 2 turns and 1 run part left. It takes no new work until then', 'Waits for: Developer with a long name (#7), Head of development'],
    ],
  },
  ru: {
    account: 'Аккаунт', versions: 'Версии', title: 'Обновление нод',
    rows: [
      ['Встроенная нода', 'Свободна: заменяется сейчас и сама снова возьмет работу'],
      ['Antigravity на node-a', 'С 12:47 ждет конца работы агентов перед обновлением: остался 1 ход. До тех пор новой работы не берет', 'Ждет: Developer (#251)'],
      ['Claude на node-a', 'С 13:05 ждет конца работы агентов перед обновлением: осталось 2 хода и 1 часть прогона. До тех пор новой работы не берет', 'Ждет: Developer with a long name (#7), Head of development'],
    ],
  },
} as const;

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`the update screen says what each node waits for, ${language} ${theme} ${width}`, async ({ page }, info) => {
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
    /* Tall enough at phone width to show the whole dialog without scrolling inside it. */
    await page.setViewportSize({ width, height: width === 375 ? 1100 : 900 });
    await serveApi(page);
    await page.route('**/api/version', route => route.fulfill({ json: CURRENT }));
    await page.route('**/api/updates', route => route.fulfill({ json: { current: CURRENT, latest: BUILD, versions: [BUILD], available: false, checkedAt: '2026-11-05T11:00:00Z', error: null, updater: { present: true, status: null, waiting: null }, nodeWaits: WAITS } }));
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', theme);
    }, { language, theme });
    await page.goto('/');
    const words = WORDS[language];
    await page.getByRole('button', { name: words.account, exact: true }).click();
    await page.getByRole('button', { name: words.versions, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: words.versions });
    await expect(dialog.getByRole('heading', { name: words.title })).toBeVisible();
    for (const [name, ...lines] of words.rows) {
      const row = dialog.getByRole('listitem').filter({ hasText: name });
      await expect(row).toBeVisible();
      for (const line of lines) await expect(row.getByText(line, { exact: true })).toBeVisible();
    }
    await page.evaluate(async () => { await document.fonts.ready; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`update-nodes-${language}-${theme}-${width}.png`), fullPage: true });
    expect(problems).toEqual([]);
  });
}
