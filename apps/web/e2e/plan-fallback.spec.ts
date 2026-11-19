import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { AgentCardView, SubView } from '../src/types';
import { CARD, SUB, serveAgentWindow } from './agent-window-api';
import { box, chooseTerminal, serveApi } from './api';

/* A plan at its limit sends its employees on to its fallback plans: the Subscriptions screen lists them in their order with
   their models for the person who may change the plan, and an employee's card says which fallback it is on, until when and
   where it goes back. Every answer of the server is the test's own. */

const messages = { en, ru };
const RESET = '2026-11-20T22:51:00.000Z';
const at = (lang: 'en' | 'ru') => new Date(RESET).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' });
const AGY: SubView = { ...SUB, id: 's-agy', provider: 'antigravity', label: 'Antigravity', owner: { id: 'p1', name: 'Ivan' }, agents: [],
  limits: { status: 'rejected', windows: [{ name: 'seven_day', utilization: 1, resetsAt: RESET }] },
  fallbacks: [{ subscription: 's-codex', model: null }, { subscription: 's-router', model: 'qwen/qwen3-coder-480b-a35b-instruct' }] };
const CODEX: SubView = { ...SUB, id: 's-codex', provider: 'codex', label: 'Codex', owner: { id: 'p6', name: 'Maximilian Konstantinopolsky' }, agents: [], fallbacks: [] };
const ROUTER: SubView = { ...SUB, id: 's-router', provider: 'openrouter', kind: 'api_key', label: 'OpenRouter for the whole company and every department', last4: '42ab', machines: [], agents: [], fallbacks: [],
  models: [{ id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B A35B Instruct' }, { id: 'z-ai/glm-5', name: 'GLM 5' }] };
const KIMI: SubView = { ...SUB, id: 's-kimi', provider: 'kimi', label: 'Kimi', owner: { id: 'p7', name: 'Nora' }, agents: [], fallbacks: [] };
const onFallback: AgentCardView = { ...CARD, subscription: CODEX, fallback: { home: AGY, until: RESET }, canEdit: true, runsOn: [AGY, CODEX].map(subscription => ({ subscription, models: [] })) };

type Look = { lang: 'en' | 'ru'; theme: 'light' | 'dark'; width: number };
const WORDS = {
  en: { tab: 'Subscriptions & API', open: 'Open the card of ', members: 'Members', card: 'Card' },
  ru: { tab: 'Подписки и API', open: 'Открыть карточку ', members: 'Сотрудники', card: 'Карточка' },
};

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

/* WebKit never sees a button of the department page hold still: there the click goes without waiting for it to stop moving. */
const press = (locator: Locator, browser: string) => locator.click(browser === 'webkit' ? { force: true } : {});

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/* Nothing in it sticks out of it. */
async function inside(outer: Locator, inner: Locator) {
  const o = await box(outer);
  for (const one of await inner.all()) {
    const b = await box(one);
    expect(b.x).toBeGreaterThanOrEqual(o.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(o.x + o.width + 0.5);
  }
}

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const look = `${lang}, ${theme}, ${width}px`;

  test(`a plan's fallback plans on its card in ${look}`, async ({ page, browserName }, info) => {
    const t = messages[lang];
    const words = WORDS[lang];
    const errors = await opened(page, { lang, theme, width });
    const saved: unknown[] = [];
    await serveApi(page);
    await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [AGY, CODEX, ROUTER, KIMI] } }));
    await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
    await page.route('**/api/subscriptions/s-agy', async route => {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { subscription: { ...AGY, ...(route.request().postDataJSON() as object) } } });
    });
    await page.goto('/');
    await press(page.getByRole('button', { name: words.tab, exact: true }), browserName);
    await press(page.getByRole('button', { name: `${words.open}Antigravity` }), browserName);
    const card = page.getByRole('article', { name: 'Antigravity, Ivan' });
    await expect(card.getByText(t.subs.fallbacks, { exact: true })).toBeVisible();
    const list = card.locator('.fallback-list li');
    await expect(list).toHaveCount(2);
    await expect(list.nth(0)).toContainText('Codex, Maximilian Konstantinopolsky');
    await expect(list.nth(1).getByRole('combobox')).toHaveValue('qwen/qwen3-coder-480b-a35b-instruct');
    /* The fallback plans are a band of the card of their own since #1444. */
    const part = card.locator('.plan-fallbacks');
    await part.scrollIntoViewIfNeeded();
    await part.screenshot({ path: info.outputPath(`fallbacks-${lang}-${theme}-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`fallbacks-page-${lang}-${theme}-${width}.png`), fullPage: true });
    await inside(card, card.locator('.plan-fallbacks, .fallback-list li, .fallback-moves button, .plan-fallbacks select'));
    /* The moves of a fallback wrap below its name as one group, all on one row. */
    const moves = await Promise.all((await list.nth(0).locator('.fallback-moves button').all()).map(box));
    expect(new Set(moves.map(b => Math.round(b.y))).size).toBe(1);
    await noSideScroll(page);
    await press(card.getByRole('button', { name: t.subs.fallbackDownLabel('Codex, Maximilian Konstantinopolsky') }), browserName);
    await expect.poll(() => saved).toEqual([{ fallbacks: [AGY.fallbacks![1], AGY.fallbacks![0]] }]);
    expect(errors).toEqual([]);
  });

  test(`an employee on a fallback plan, on its card, in ${look}`, async ({ page, browserName }, info) => {
    const t = messages[lang];
    const words = WORDS[lang];
    const errors = await opened(page, { lang, theme, width });
    await chooseTerminal(page);
    await serveAgentWindow(page, { awake: true, hasTask: true, messages: [], connections: 0, head: true, sent: [] });
    await page.route('**/api/agents/b1', route => route.fulfill({ json: onFallback }));
    await page.goto('/departments/d2');
    await press(page.getByRole('region', { name: words.members }).getByRole('button', { name: /Bruno/ }), browserName);
    const window = page.getByRole('complementary', { name: /^Bruno,/ });
    await press(window.locator(':scope > .t-bar').getByRole('button', { name: words.card, exact: true }), browserName);
    const card = window.getByRole('complementary', { name: `${words.card}: Bruno`, exact: true });
    await expect(card).toBeVisible();
    const line = card.getByText(t.agent.onFallback('Codex, Maximilian Konstantinopolsky', 'Antigravity, Ivan', at(lang)), { exact: true });
    await expect(line).toBeVisible();
    await inside(card, line);
    await noSideScroll(page);
    await page.screenshot({ path: info.outputPath(`agent-card-fallback-${lang}-${theme}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
