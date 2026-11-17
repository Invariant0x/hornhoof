import { expect, test, type Page } from '@playwright/test';
import type { ConnectionHistory, MachineView, SubView } from '../src/types';
import { serveApi } from './api';

const HOST = 'build-node';
const GIB = 1024 ** 3;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const PLAN: SubView = {
  id: 'plan-1', provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready', online: true,
  last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
  machines: [{ id: 'm1', hostname: HOST, status: 'ready', online: true }], limits: null, budget: null, isOrchestrator: false, accounts: [], tier: null,
} as unknown as SubView;

const MACHINE: MachineView = {
  id: 'm1', hostname: HOST, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null,
  plans: [{ id: 'plan-1', provider: 'claude', status: 'ready', online: true }],
  load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] },
};

const drop = (at: string, back: string | null, offlineMs: number | null, over: object = {}) => ({
  nodeId: 'n1', subscriptionId: 'plan-1', at, back, offlineMs, cause: 'network', closeCode: 1006, closeReason: null, error: null, report: null, ...over,
});
const said = {
  disconnectedAt: ago(40), reconnectedAt: ago(39), offlineMs: 60_000, attempts: 4, cause: 'dns_error', closeCode: null, closeReason: null,
  errorCode: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND hornhoof.example', dnsFailed: true, watchdogTimedOut: false, clockJumpMs: 95_000, networkChanged: true,
};
const HISTORY = {
  summary: { drops: 5, averageMs: 40_000, cause: 'network' },
  events: [
    { at: ago(3), back: null, offlineMs: null, cause: 'missed_pongs', drops: [drop(ago(3), null, null, { cause: 'missed_pongs' }), drop(ago(3), ago(2), 60_000, { nodeId: 'n2', cause: 'missed_pongs' })] },
    { at: ago(40), back: ago(39), offlineMs: 60_000, cause: 'dns_error', drops: [drop(ago(40), ago(39), 60_000, { cause: 'replaced', closeCode: 4000, closeReason: 'Replaced by a newer connection.', report: said })] },
    { at: ago(180), back: ago(179.5), offlineMs: 30_000, cause: 'network', drops: [drop(ago(180), ago(179.5), 30_000)] },
    { at: ago(300), back: ago(299.9), offlineMs: 6000, cause: 'server_stopped', drops: [drop(ago(300), ago(299.9), 6000, { cause: 'server_stopped', closeCode: 1001 })] },
    { at: ago(600), back: ago(599.3), offlineMs: 42_000, cause: 'socket_error', drops: [drop(ago(600), ago(599.3), 42_000, { cause: 'socket_error', closeCode: 1002, error: `Invalid WebSocket frame: ${'a very long word '.repeat(4).replaceAll(' ', '_')}` })] },
    { at: ago(2000), back: ago(1999), offlineMs: 60_000, cause: 'node_closed', drops: [drop(ago(2000), ago(1999), 60_000, { cause: 'node_closed', closeCode: 1000, closeReason: 'Going away for an update.' })] },
  ],
} as unknown as ConnectionHistory;

/* The card of a machine, on a page as wide as asked, in the language and theme asked. */
async function openCard(page: Page, language: 'en' | 'ru', theme: 'light' | 'dark', width: number, answer: { status: number; json: unknown }) {
  await page.setViewportSize({ width, height: 1000 });
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [MACHINE], builtin: null } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [PLAN] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/m1/connections', route => route.fulfill(answer));
  await page.goto('/');
  await page.getByRole('button', { name: language === 'en' ? 'Machines' : 'Машины', exact: true }).click();
  await page.getByRole('button', { name: `${language === 'en' ? 'Open the card of' : 'Открыть карточку'} ${HOST}`, exact: true }).click();
  return page.getByRole('article', { name: HOST });
}

const TEXT = {
  en: { heading: 'Connection to the server', summary: '5 drops in the last 24 hours, 40 s on average. Most often: the network cut the connection.', health: 'Offline now', away: 'Still offline', saw: /The machine saw: ENOTFOUND, 4 tries to connect/, details: 'Show technical details', more: 'Show all 6', fewer: 'Show fewer', none: 'No drops so far.' },
  ru: { heading: 'Связь с сервером', summary: 'За сутки 5 обрывов, в среднем 40 с. Чаще всего: сеть оборвала соединение.', health: 'Сейчас нет связи', away: 'Связи пока нет', saw: /Машина видела: ENOTFOUND, попыток подключиться: 4/, details: 'Показать технические подробности', more: 'Показать все: 6', fewer: 'Показать меньше', none: 'Обрывов пока не было.' },
};

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  test(`the history of a machine ${language} ${theme} ${width}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    /* The rest of the page is not what this answers for: other screens' requests get a 404 here. */
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text()); });
    page.on('response', res => { if (res.url().includes('/api/machines') && res.status() >= 400) errors.push(`${res.status()} ${res.url()}`); });
    const text = TEXT[language];
    const card = await openCard(page, language, theme, width, { status: 200, json: HISTORY });

    await expect(card.getByRole('heading', { name: text.heading })).toBeVisible();
    await expect(card.getByText(text.summary)).toBeVisible();
    await expect(card.locator('.mc-sum .status')).toHaveText(text.health);
    await expect(card.getByText(text.away)).toBeVisible();
    /* What the machine itself saw waits behind its button (#1027). */
    await expect(card.getByText(text.saw)).toHaveCount(0);
    await card.getByRole('button', { name: text.details }).click();
    await expect(card.getByText(text.saw)).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: text.away })).toHaveClass(/away/);
    await expect(page.locator('.mc-drops > li')).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    /* A long word stays inside its line. */
    for (const line of await page.locator('.mc-drops > li').all()) {
      expect(await line.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.locator('.blk-link').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`card-${language}-${theme}-${width}.png`) });

    const more = card.getByRole('button', { name: text.more });
    await more.focus();
    await expect(more).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.mc-drops > li')).toHaveCount(6);
    await expect(card.getByRole('button', { name: text.fewer })).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.blk-link').screenshot({ path: info.outputPath(`history-${language}-${theme}-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

for (const language of ['en', 'ru'] as const) {
  test(`a machine with no drops yet ${language}`, async ({ page }, info) => {
    const card = await openCard(page, language, 'light', 1440, { status: 200, json: { summary: { drops: 0, averageMs: null, cause: null }, events: [] } });
    await expect(card.getByText(TEXT[language].none)).toBeVisible();
    await expect(page.locator('.mc-drops')).toHaveCount(0);
    await page.locator('.blk-link').screenshot({ path: info.outputPath(`empty-${language}-light-1440.png`) });
  });

  test(`a history that cannot be read ${language}`, async ({ page }, info) => {
    const card = await openCard(page, language, 'dark', 375, { status: 500, json: { error: { code: 'internal', message: 'Something failed.' } } });
    await expect(card.locator('.blk-link').getByRole('alert')).toBeVisible();
    await page.locator('.blk-link').screenshot({ path: info.outputPath(`failed-${language}-dark-375.png`) });
  });
}
