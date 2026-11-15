import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { AgentCardView, DepartmentBranches, Org, SubView } from '../src/types';
import { CARD, DETAIL, SUB, serveAgentWindow } from './agent-window-api';
import { chooseTerminal, ME, serveApi } from './api';

/* An employee whose plan's machine is offline: its card and the card of its task say which machine and since when, and the
   person who runs the department moves it in one click to an online plan of the department. The department's page lists
   the accepted and handed-in task branches main does not have yet. Every answer of the server is the test's own. */

const messages = { en, ru };
const SINCE = '2026-11-13T18:07:00.000Z';
const at = (lang: 'en' | 'ru') => new Date(SINCE).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' });
const DEV_PLACE = { kind: 'department' as const, id: 'd2', name: 'Development' };
const HOME: SubView = { ...SUB, id: 's-home', provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready', online: false, owner: { id: 'p5', name: 'Clara' }, place: DEV_PLACE, machines: [{ id: 'm5', hostname: 'workstation-eu', status: 'ready', online: false }] };
const SPARE: SubView = { ...HOME, id: 's-spare', online: true, owner: { id: 'p6', name: 'Maximilian Konstantinopolsky' }, machines: [{ id: 'm6', hostname: 'win-desktop-01', status: 'ready', online: true }] };
const OFFLINE = { hostname: 'workstation-eu', since: SINCE };
const offlineCard: AgentCardView = { ...CARD, subscription: HOME, offline: OFFLINE, canEdit: true, runsOn: [HOME, SPARE].map(subscription => ({ subscription, models: [] })) };
const movedCard: AgentCardView = { ...offlineCard, subscription: SPARE, offline: null };

const BRANCHES: DepartmentBranches = {
  branches: [
    { task: 41, title: 'Lead scoring for the spring pilot with every partner of the region', status: 'review', branch: 'task-41-lead-scoring-for-the-spring-pilot', commit: 'b'.repeat(40), merged: false },
    { task: 37, title: 'Collect leads', status: 'done', branch: 'task-37', commit: 'a'.repeat(40), merged: null },
  ],
  problem: null,
};
const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 1, working: 0 },
  people: [],
  departments: [{
    id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 1, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [],
    repository: { url: 'https://github.com/acme/acme-marketing.git', branch: 'main', tokenLast4: '1234' },
  }],
};

type Look = { lang: 'en' | 'ru'; theme: 'light' | 'dark'; width: number };
const WINDOW_WORDS = { en: { members: 'Members', card: 'Card' }, ru: { members: 'Сотрудники', card: 'Карточка' } };

async function opened(page: Page, { lang, theme, width }: Look): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  return errors;
}

/* Bruno's card in his window, opened from the department's own page. */
async function brunoCard(page: Page, look: Look, browser: string) {
  const errors = await opened(page, look);
  await chooseTerminal(page);
  await serveAgentWindow(page, { awake: true, hasTask: true, messages: [], connections: 0, head: true, sent: [] });
  return { errors, open: async () => {
    const words = WINDOW_WORDS[look.lang];
    await page.goto('/departments/d2');
    await press(page.getByRole('region', { name: words.members }).getByRole('button', { name: /Bruno/ }), browser);
    const window = page.getByRole('complementary', { name: /^Bruno,/ });
    await press(window.locator(':scope > .t-bar').getByRole('button', { name: words.card, exact: true }), browser);
    const card = window.getByRole('complementary', { name: `${words.card}: Bruno`, exact: true });
    await expect(card).toBeVisible();
    return card;
  } };
}

/* WebKit never sees a button of the department page hold still: there the click goes without waiting for it to stop
   moving. */
const press = (locator: Locator, browser: string) => locator.click(browser === 'webkit' ? { force: true } : {});

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const look = `${lang}, ${theme}, ${width}px`;

  test(`offline machine and one-click move on the agent card in ${look}`, async ({ page, browserName }, info) => {
    const t = messages[lang];
    const moves: unknown[] = [];
    const { errors, open } = await brunoCard(page, { lang, theme, width }, browserName);
    await page.route('**/api/agents/b1', async route => {
      if (route.request().method() === 'PATCH') {
        moves.push(route.request().postDataJSON());
        return route.fulfill({ json: movedCard });
      }
      return route.fulfill({ json: offlineCard });
    });
    const card = await open();
    const line = card.getByText(t.agent.offlineSince('workstation-eu', at(lang)), { exact: true });
    await expect(line).toBeVisible();
    const move = card.getByRole('button', { name: t.agent.moveTo('Claude, Maximilian Konstantinopolsky'), exact: true });
    await expect(move).toBeVisible();
    await expect(card.getByRole('button', { name: /^(Move to|Перевести на) / })).toHaveCount(1);
    const [lineBox, moveBox, cardBox] = [await line.boundingBox(), await move.boundingBox(), await card.boundingBox()];
    for (const b of [lineBox!, moveBox!]) expect(b.x + b.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
    await noSideScroll(page);
    await page.screenshot({ path: info.outputPath(`agent-card-offline-${lang}-${theme}-${width}.png`), fullPage: true });
    await press(move, browserName);
    await expect(line).toHaveCount(0);
    expect(moves).toEqual([{ subscription: 's-spare' }]);
    await page.screenshot({ path: info.outputPath(`agent-card-moved-${lang}-${theme}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });

  test(`offline machine on the task card in ${look}`, async ({ page }, info) => {
    const t = messages[lang];
    const errors = await opened(page, { lang, theme, width });
    await serveApi(page);
    await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: { ...DETAIL, assigneeOffline: OFFLINE } } }));
    await page.goto('/tasks/t1');
    const task = page.getByRole('complementary', { name: `#${DETAIL.number} ${DETAIL.title}`, exact: true });
    await expect(task).toBeVisible();
    await expect(task.getByText(t.agent.offlineSince('workstation-eu', at(lang)), { exact: true })).toBeVisible();
    await noSideScroll(page);
    await page.screenshot({ path: info.outputPath(`task-card-offline-${lang}-${theme}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });

  test(`department branches not in main in ${look}`, async ({ page, browserName }, info) => {
    const t = messages[lang];
    const errors = await opened(page, { lang, theme, width });
    await serveApi(page);
    await page.route('**/api/org', route => route.fulfill({ json: ORG }));
    await page.route('**/api/departments/d2/branches', route => route.fulfill({ json: BRANCHES }));
    await page.goto('/departments/d2');
    await press(page.getByRole('button', { name: t.dept.about, exact: true }), browserName);
    const region = page.getByRole('region', { name: t.dept.branches.title, exact: true });
    await expect(region).toBeVisible();
    const items = region.getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('task-41-lead-scoring-for-the-spring-pilot');
    await expect(items.nth(0)).toContainText(t.dept.branches.state.review.notIn);
    await expect(items.nth(1)).toContainText(t.dept.branches.state.done.unknown);
    await region.evaluate(el => el.scrollIntoView({ block: 'nearest' }));
    const regionBox = (await region.boundingBox())!;
    for (const i of [0, 1]) {
      const b = (await items.nth(i).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(regionBox.x + regionBox.width + 0.5);
    }
    await noSideScroll(page);
    await page.screenshot({ path: info.outputPath(`department-branches-${lang}-${theme}-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
