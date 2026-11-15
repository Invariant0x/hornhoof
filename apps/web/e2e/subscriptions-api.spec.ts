import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { SubView, TokenPeriods, TokenSum } from '../src/types';
import { tokenCount } from '../src/ui/token-count';
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
/* The router's 30 days by model: one it lists, one it does not, and the turns that told no model. */
const BY_MODEL = [{ model: 'meta-llama/llama-4-maverick', total: 19_687_500 }, { model: 'qwen/qwen3-coder-480b-a35b-instruct', total: 5_250_000 }, { model: null, total: 1_312_500 }];

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
    return route.fulfill({ json: { tokens: OWN_DAY(sub), models: sub.id === ROUTER.id ? BY_MODEL : [] } });
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

/* The words of the table's headers that stand on more than one line: a word broken in its middle. */
const brokenHeaderWords = (page: Page) => page.evaluate(() => {
  const broken: string[] = [];
  for (const th of document.querySelectorAll('.dt > thead th')) {
    const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top)));
        if (lines.size > 1) broken.push(word[0]);
      }
    }
  }
  return broken;
});

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
  { lang: 'en' as const, skin: 'cyberpunk', width: 1440 },
];

for (const { lang, skin, width } of LOOKS) {
  const mode = skin === 'light' ? 'light' : `dark ${skin}`;
  test(`Subscriptions & API: payment, tokens and a new API connection, ${lang} ${mode} ${width}`, async ({ page }, info) => {
    const t = messages[lang];
    const n = (value: number) => tokenCount(lang, value);
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
    /* How each is paid reads by its word and sign, in the ink of the page, as the orchestrator's mark is quiet. */
    const ink = await page.evaluate(() => getComputedStyle(document.body).color);
    for (const badge of await rows.locator('.badge.ctype').all()) {
      await expect(badge.locator('svg')).toBeVisible();
      await expect(badge).toHaveCSS('color', ink);
    }
    await expect(row('WXYZ').locator('.badge.orch')).toHaveText(t.subs.orchestrator);
    expect(await row('WXYZ').locator('.badge.orch').evaluate(el => getComputedStyle(el).color)).not.toBe(ink);
    /* An API says once that it pays as it goes, across both limit columns on a desk, under Limits as an entry. */
    if (width > 780) {
      await expect(row('WXYZ').getByText(t.subs.noPlanLimits, { exact: true })).toHaveCount(1);
      await expect(row('WXYZ').locator('td[colspan="2"]')).toHaveText(t.subs.noPlanLimits);
      /* A header breaks between its words only, in a table that fits its frame. */
      expect(await brokenHeaderWords(page)).toEqual([]);
      expect(await page.locator('.tbl').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    } else await expect(row('WXYZ').getByRole('cell', { name: `${t.subs.limits} ${t.subs.noPlanLimits}`, exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveAttribute('placeholder', width > 720 ? t.tables.searchSubscriptions : t.tables.searchSubscriptionsShort);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(`list-${lang}-${skin}-${width}.png`), fullPage: true });

    const type = page.getByRole('group', { name: t.subs.payFilter, exact: true });
    const all = type.getByRole('button', { name: new RegExp(`^${t.subs.payAll}`) });
    await expect(all).toHaveText(`${t.subs.payAll}4`);
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    for (const button of await type.getByRole('button').all()) expect((await box(button)).height).toBeGreaterThanOrEqual(44);
    await type.getByRole('button', { name: new RegExp(`^${t.subs.pay.api_key}`) }).click();
    await expect(rows).toHaveCount(3);
    await expect(row('Max')).toHaveCount(0);
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    await all.click();
    await expect(rows).toHaveCount(4);
    await expect(all).toHaveAttribute('aria-pressed', 'true');

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
    for (const [term, count] of [[t.subs.tokens.input, own.today.input], [t.subs.tokens.output, own.today.output], [t.subs.tokens.cache, own.today.cacheRead + own.today.cacheWrite]] as const)
      await expect(gauges.nth(0)).toContainText(`${term} ${n(count)}`);
    /* Each tile says its whole count in its name and tooltip; the short one stands on screen. */
    const whole = (count: number) => t.subs.tokens.full(new Intl.NumberFormat(lang).format(count), count);
    await expect(gauges.nth(2)).toHaveAccessibleName(`${t.subs.tokens.month}: ${whole(own.month.total)}`);
    await expect(gauges.nth(2)).toHaveAttribute('title', whole(own.month.total));
    /* Its 30 days by model: the name it is listed by, else its id, else the default model, each with its whole count. */
    const models = part.locator('.models li');
    await expect(part.locator('.models')).toContainText(t.subs.tokens.byModel);
    await expect(models.locator('.mname')).toHaveText(['Llama 4 Maverick', 'qwen/qwen3-coder-480b-a35b-instruct', t.subs.tokens.defaultModel]);
    await expect(models.first()).toContainText(new Intl.NumberFormat(lang).format(19_687_500));
    await expect(models.first()).toContainText(new Intl.NumberFormat(lang, { style: 'percent' }).format(0.75));
    const bar = await box(models.first().locator('.bar i'));
    expect(bar.width / (await box(models.first().locator('.bar'))).width).toBeCloseTo(0.75, 2);
    /* Each figure stands on one line, a billion as well as a thousand. */
    for (const figure of await part.locator('.g-f b').all()) expect((await box(figure)).height).toBeLessThan(36);
    await insideCard(card);
    expect(await fits(page)).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`card-${lang}-${skin}-${width}.png`), fullPage: true });

    await page.getByRole('button', { name: t.subs.connectApi, exact: true }).click();
    const form = page.getByRole('form', { name: t.subs.connectApi });
    await expect(form).toBeVisible();
    await form.getByLabel(t.subs.apiService, { exact: true }).selectOption('openrouter');
    const key = form.getByLabel(t.subs.apiKey, { exact: true });
    await key.fill(KEY);
    /* The typed key shows while the person asks, and hides again; both the field and its button are targets of 44 px. */
    await form.getByRole('button', { name: t.subs.showTypedKey.label, exact: true }).click();
    await expect(key).toHaveAttribute('type', 'text');
    await form.getByRole('button', { name: t.subs.hideTypedKey.label, exact: true }).click();
    await expect(key).toHaveAttribute('type', 'password');
    expect((await box(key)).height).toBeGreaterThanOrEqual(44);
    expect((await box(form.getByRole('button', { name: t.subs.showTypedKey.label, exact: true }))).height).toBeGreaterThanOrEqual(44);
    await form.getByLabel(t.subs.apiName, { exact: true }).fill('Router 2');
    await expect(form.getByLabel(t.subs.apiAddress, { exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: t.subs.loadModels, exact: true }).click();
    await expect(form).toContainText(t.subs.modelsFound(3));
    const qwen = form.getByRole('checkbox', { name: 'Qwen 3 Coder', exact: true });
    /* A box stands at the first line of its name, the size of a box. */
    const [tick, name] = [await box(qwen), await box(form.locator('.model-found label').filter({ has: page.getByRole('checkbox', { name: 'Qwen 3 Coder', exact: true }) }).locator('span'))];
    expect(tick.height).toBeLessThan(22);
    expect(Math.abs(tick.y + tick.height / 2 - (name.y + Math.min(name.height, 22) / 2))).toBeLessThan(5);
    await qwen.check();
    await expect(form.getByLabel(t.subs.apiKey, { exact: true })).toHaveAccessibleDescription(t.subs.apiKeyHint);
    await expect(page.getByText(t.subs.apiKeyHint, { exact: true })).toHaveCount(1);
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
