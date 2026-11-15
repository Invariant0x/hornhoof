import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { SubView, TokenPeriods, TokenSum } from '../src/types';
import { CARD } from './agent-window-api';
import { openAgent } from './agent-window-panels-api';
import { box, serveApi } from './api';

/* One section holds the plans and the APIs paid by the token: each says how it is paid, the table filters by it and shows
   what each used in 30 days, an open card shows its tokens beside its limits, the whole company connects an API with the
   models its service lists, and an employee's card picks the connection and its model. */

/* A whole flow of the section, from the list to a new connection, outlasts the default limit in WebKit on a busy machine. */
test.describe.configure({ timeout: 120_000 });

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const messages = { en, ru };
const KEY = 'sk-or-v1-e2e-0123456789abcdef';

const sum = (total: number, turns: number, noData = 0): TokenSum => {
  const input = Math.round(total / 10);
  const output = Math.round(total / 20);
  const cacheWrite = Math.round(total / 20);
  return { input, output, cacheRead: total - input - output - cacheWrite, cacheWrite, total, turns, noData };
};
const periods = (today: number, noData = 0): TokenPeriods => ({ today: sum(today, 2), week: sum(today * 6, 9), month: sum(today * 21, 30), all: sum(today * 40, 61, noData) });

const OWNER = { id: 'p1', name: 'Ivan' };
const COMPANY = { kind: 'company' as const, id: null, name: 'Whole company' };
const base = {
  kind: 'api_key' as const, status: 'ready' as const, online: true, owner: OWNER, place: COMPANY, machines: [], limits: null, limitsUpdatedAt: null,
  budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null, agents: [],
};
const MODELS = [{ id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' }, { id: 'qwen/qwen-3-coder', name: 'Qwen 3 Coder' }];
const PLAN: SubView = {
  ...base, id: 's-claude', provider: 'claude', kind: 'personal', label: 'Claude', last4: null, tier: 'Max', signedInOnce: true,
  machines: [{ id: 'm1', hostname: 'a-host', status: 'ready', online: true }],
  limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: '2026-11-15T15:00:00.000Z' }], complete: true },
  limitsUpdatedAt: '2026-11-15T11:58:00.000Z', tokens: periods(812_400, 2),
};
const ROUTER: SubView = {
  ...base, id: 's-router', provider: 'openrouter', label: 'OpenRouter', last4: 'WXYZ', isOrchestrator: true,
  api: { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' }, models: MODELS, target: { kind: 'orchestrator', id: null }, tokens: periods(1_250_000),
};
const CLAUDE_API: SubView = {
  ...base, id: 's-claude-api', provider: 'anthropic_api', label: 'Claude API', last4: 'K7Q2',
  api: { baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' }, models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }], target: { kind: 'any', id: null }, tokens: periods(96_300),
};
const ACME: SubView = {
  ...base, id: 's-acme', provider: 'custom_api', label: 'Acme LLM', last4: 'M3N4',
  api: { baseUrl: 'https://llm.acme.example/v1', protocol: 'openai' }, models: [{ id: 'acme-coder', name: 'acme-coder' }], target: { kind: 'department', id: 'd2' }, tokens: periods(0),
};
/* What the card asks for its own day, where the viewer is: a little more than the list's UTC day. */
const OWN_DAY = (sub: SubView): TokenPeriods => ({ ...sub.tokens!, today: sum(sub.tokens!.today.total + 4_200, 3) });

const pathOf = (url: URL | string) => new URL(url.toString()).pathname;

/* The section's own answers over the company of serveApi: its list, a card's tokens, an API's models and a new connection. */
async function serveSection(page: Page, sent: Request[]) {
  await serveApi(page);
  const list = [PLAN, ROUTER, CLAUDE_API, ACME];
  await page.route(url => pathOf(url) === '/api/subscriptions', route => {
    if (route.request().method() === 'POST') {
      sent.push(route.request());
      return route.fulfill({ status: 201, json: { subscription: { ...ROUTER, id: 's-new', label: 'Router 2', last4: 'cdef', isOrchestrator: false, tokens: periods(0) } } });
    }
    return route.fulfill({ json: { subscriptions: list } });
  });
  await page.route(url => /^\/api\/subscriptions\/[^/]+\/tokens$/.test(pathOf(url)), route => {
    const id = pathOf(route.request().url()).split('/')[3];
    const sub = list.find(s => s.id === id)!;
    return route.fulfill({ json: { tokens: OWN_DAY(sub) } });
  });
  await page.route(url => pathOf(url) === '/api/subscriptions/models', route => {
    sent.push(route.request());
    return route.fulfill({ json: { models: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' }, ...MODELS] } });
  });
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.23.6', commit: 'task-948' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.23.6', commit: 'task-948' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
  page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  return errors;
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function insideCard(card: Locator) {
  const blocks = await box(card.locator('.blocks'));
  for (const blk of await card.locator('.blocks > .blk').all()) {
    const own = await box(blk);
    expect(own.x + own.width).toBeLessThanOrEqual(blocks.x + blocks.width + 1);
  }
}

/* Russian in every built-in skin, English in the light one: each at a desk and on a phone. */
const LOOKS = [
  ...BUILTIN_SKINS.flatMap(skin => [1440, 375].map(width => ({ lang: 'ru' as const, skin: skin.id, width }))),
  ...[1440, 375].map(width => ({ lang: 'en' as const, skin: 'light', width })),
];

for (const { lang, skin, width } of LOOKS) {
  const mode = skin === 'light' ? 'light' : `dark ${skin}`;
  test(`Subscriptions & API: payment, tokens and a new API connection, ${lang} ${mode} ${width}`, async ({ page }, info) => {
    const t = messages[lang];
    const n = (value: number) => new Intl.NumberFormat(lang).format(value);
    const errors = watch(page);
    const sent: Request[] = [];
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: NOW });
    await page.addInitScript(({ lang, skin }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', skin);
    }, { lang, skin });
    await serveSection(page, sent);
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: t.subs.heading, exact: true })).toBeVisible();

    const rows = page.locator('tr.rm');
    const row = (text: string) => rows.filter({ hasText: text });
    await expect(rows).toHaveCount(4);
    await expect(row('Max').locator('.badge.pay-plan')).toHaveText(t.subs.pay.personal);
    for (const last4 of ['WXYZ', 'K7Q2', 'M3N4']) await expect(row(last4).locator('.badge.pay-tokens')).toHaveText(t.subs.pay.api_key);
    /* A desk has the column; a phone shows each row as entries, each value under the name of its column. */
    if (width > 600) await expect(page.getByRole('columnheader', { name: t.subs.tokensColumn })).toBeVisible();
    else await expect(row('WXYZ').getByRole('cell', { name: `${t.subs.tokensColumn} ${n(ROUTER.tokens!.month.total)}`, exact: true })).toBeVisible();
    await expect(row('WXYZ')).toContainText(n(ROUTER.tokens!.month.total));
    await expect(row('M3N4').getByRole('img')).toHaveAccessibleName('Codex');
    await expect(row('Max')).toContainText(n(PLAN.tokens!.month.total));
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(`list-${lang}-${skin}-${width}.png`), fullPage: true });

    await page.getByRole('group', { name: t.subs.payFilter }).getByRole('button', { name: new RegExp(`^${t.subs.pay.api_key}`) }).click();
    await expect(rows).toHaveCount(3);
    await expect(row('Max')).toHaveCount(0);
    await page.getByRole('group', { name: t.subs.payFilter }).getByRole('button', { name: new RegExp(`^${t.subs.pay.api_key}`) }).click();
    await expect(rows).toHaveCount(4);

    await row('WXYZ').locator('button.rowbtn').click();
    const card = page.getByRole('article', { name: /WXYZ/ });
    await expect(card).toBeVisible();
    await expect(card.locator('.badge.pay-tokens')).toHaveText(t.subs.pay.api_key);
    const part = card.locator('.blk-facts .part').filter({ has: page.locator('.part-h', { hasText: new RegExp(`^${t.subs.tokens.title}$`) }) });
    const gauges = part.locator('.gauge');
    await expect(gauges).toHaveCount(4);
    const own = OWN_DAY(ROUTER);
    await expect(gauges.nth(0)).toContainText(t.subs.tokens.today);
    await expect(gauges.nth(0)).toContainText(n(own.today.total));
    for (const [i, period] of (['week', 'month', 'all'] as const).entries()) {
      await expect(gauges.nth(i + 1)).toContainText(t.subs.tokens[period]);
      await expect(gauges.nth(i + 1)).toContainText(n(own[period].total));
    }
    await expect(gauges.nth(0)).toContainText(t.subs.tokens.split(n(own.today.input), n(own.today.output), n(own.today.cacheRead + own.today.cacheWrite)));
    await insideCard(card);
    expect(await fits(page)).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`card-${lang}-${skin}-${width}.png`), fullPage: true });

    await page.getByRole('button', { name: t.subs.connectApi, exact: true }).click();
    const form = page.getByRole('form', { name: t.subs.connectApi });
    await expect(form).toBeVisible();
    await form.getByLabel(t.subs.apiService, { exact: true }).selectOption('openrouter');
    await form.getByLabel(t.subs.apiKey, { exact: true }).fill(KEY);
    await form.getByLabel(t.subs.apiName, { exact: true }).fill('Router 2');
    await expect(form.getByLabel(t.subs.apiAddress, { exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: t.subs.loadModels, exact: true }).click();
    await expect(form).toContainText(t.subs.modelsFound(3));
    await form.getByRole('checkbox', { name: 'Qwen 3 Coder', exact: true }).check();
    await form.getByLabel(t.subs.apiServes, { exact: true }).selectOption('department:d2');
    expect(await fits(page)).toBe(true);
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`form-${lang}-${skin}-${width}.png`), fullPage: true });

    await form.getByRole('button', { name: t.subs.saveApi, exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(sent.map(r => `${r.method()} ${pathOf(r.url())}`)).toEqual(['POST /api/subscriptions/models', 'POST /api/subscriptions']);
    expect(sent[0]!.postDataJSON()).toEqual({ provider: 'openrouter', apiKey: KEY });
    expect(sent[1]!.postDataJSON()).toEqual({
      kind: 'api_key', provider: 'openrouter', label: 'Router 2', apiKey: KEY, target: { kind: 'department', id: 'd2' }, protocol: 'anthropic',
      models: [{ id: 'qwen/qwen-3-coder', name: 'Qwen 3 Coder' }],
    });
    /* The key went to the server and nowhere on the page. */
    expect(await page.evaluate(key => document.body.innerHTML.includes(key), KEY)).toBe(false);
    expect(errors).toEqual([]);
  });
}

for (const lang of ['en', 'ru'] as const) for (const width of [1440, 375]) {
  test(`An employee's card runs on an API connection and one of its models: ${lang} ${width}`, async ({ page }, info) => {
    const t = messages[lang];
    await page.clock.install({ time: NOW });
    const { errors, openPanel } = await openAgent(page, { lang, theme: 'light', width }, 'employee');
    const runsOn = [{ subscription: PLAN, models: [] }, { subscription: ROUTER, models: MODELS }, { subscription: ACME, models: ACME.models! }];
    await page.route('**/api/agents/b1', route => route.fulfill({ json: { ...CARD, subscription: ROUTER, model: 'qwen/qwen-3-coder', runsOn } }));
    const card = await openPanel('card');
    const where = card.getByLabel(t.agent.runsOn, { exact: true });
    await expect(where).toHaveValue('s-router');
    await expect(where.locator('optgroup', { has: page.locator('option[value="s-router"]') })).toHaveAttribute('label', 'OpenRouter');
    await expect(where.locator('option[value="s-router"]')).toHaveText('OpenRouter (OpenRouter)');
    await expect(where.locator('option[value="s-acme"]')).toHaveText('Acme LLM (API)');
    const model = card.getByLabel(t.agent.model, { exact: true });
    await expect(model).toHaveValue('qwen/qwen-3-coder');
    await expect(model.locator('option')).toHaveText([t.agent.default, 'Llama 4 Maverick', 'Qwen 3 Coder']);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(`agent-card-${lang}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
