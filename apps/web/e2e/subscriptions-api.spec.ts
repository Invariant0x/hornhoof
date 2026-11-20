/// <reference types="node" />
import { writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { SubView, TokenPeriods, TokenSum } from '../src/types';
import { subName } from '../src/ui/subscription';
import { tokenCount } from '../src/ui/token-count';
import { CARD } from './agent-window-api';
import { openAgent } from './agent-window-panels-api';
import { box, brokenHeaderWords, serveApi, tableFits } from './api';
import { around, focusRing, markClear, offences, sizes, tabsWhole, wholePage } from './owner-screens-look';
import type { Measured } from './owner-screens-sizes';

/* One section holds the plans and the APIs paid by the token: each says how it is paid, the table filters by it and shows
   what each used in 30 days, an open card shows its tokens beside its limits, the whole company connects an API with the
   models its service lists, and an employee's card picks the connection and its model. */

/* A whole flow of the section, from the list to a new connection, takes long in WebKit on a busy machine: no limit (note #59). */
test.describe.configure({ timeout: 0 });

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
  machines: [{ id: 'm1', hostname: 'node-a', status: 'ready', online: true }],
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
async function serveSection(page: Page, sent: Request[], list = [PLAN, ROUTER, CLAUDE_API, ACME]) {
  await serveApi(page);
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
/* A box's height in whole pixels: Firefox lays out in sixtieths of a pixel, so 44 px can come as 43.99997. */
const tall = async (locator: Locator) => Math.round((await box(locator)).height);


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
    await expect(row('Max').getByRole('img', { name: t.subs.kindHint.personal, exact: true })).toBeVisible();
    for (const last4 of ['WXYZ', 'K7Q2', 'M3N4']) await expect(row(last4).getByRole('img', { name: t.subs.kindHint.api_key, exact: true })).toBeVisible();
    /* A desk has the column; a phone shows each row as entries, each value under the name of its column. */
    if (width > 600) await expect(page.getByRole('columnheader', { name: t.subs.tokensColumn })).toBeVisible();
    else await expect(row('WXYZ').getByRole('cell', { name: `${t.subs.tokensColumn} ${n(ROUTER.tokens!.month.total)}`, exact: true })).toBeVisible();
    await expect(row('WXYZ')).toContainText(n(ROUTER.tokens!.month.total));
    await expect(row('M3N4').getByRole('img').first()).toHaveAccessibleName('Codex');
    await expect(row('Max')).toContainText(n(PLAN.tokens!.month.total));
    /* How each is paid reads by its sign in the quiet ink of the orchestrator's role, a small line under its name. */
    const ink = await page.evaluate(() => getComputedStyle(document.body).color);
    const orchestrator = row('WXYZ').locator('td.k-name').getByText(t.subs.orchestrator, { exact: true });
    await expect(orchestrator).toBeVisible();
    const quiet = await orchestrator.evaluate(el => getComputedStyle(el).color);
    expect(quiet).not.toBe(ink);
    for (const sign of await rows.locator('.pay-sign').all()) {
      await expect(sign.locator('svg')).toBeVisible();
      await expect(sign).toHaveCSS('color', quiet);
    }
    /* The role stands inside the name's cell, a line high. */
    const [mark, nameCell] = [await box(orchestrator), await box(row('WXYZ').locator('td.k-name'))];
    expect(mark.x + mark.width).toBeLessThanOrEqual(nameCell.x + nameCell.width + 1);
    expect(mark.height).toBeLessThan(30);
    /* An API says once that it pays as it goes, across both limit columns on a desk, under Limits as an entry. */
    if (width > 780) {
      await expect(row('WXYZ').getByText(t.subs.noPlanLimits, { exact: true })).toHaveCount(1);
      await expect(row('WXYZ').locator('td[colspan="2"]')).toHaveText(t.subs.noPlanLimits);
      /* A header breaks between its words only, in a table that fits its frame. */
      expect(await brokenHeaderWords(page)).toEqual([]);
      expect(await tableFits(page)).toBe(true);
    } else await expect(row('WXYZ').getByRole('cell', { name: `${t.subs.limits} ${t.subs.noPlanLimits}`, exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveAttribute('placeholder', width > 720 ? t.tables.searchSubscriptions : t.tables.searchSubscriptionsShort);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(`list-${lang}-${skin}-${width}.png`), fullPage: true });

    const type = page.getByRole('group', { name: t.subs.payFilter, exact: true });
    const all = type.getByRole('button', { name: new RegExp(`^${t.tables.all}`) });
    await expect(all).toHaveText(`${t.tables.all}4`);
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    for (const button of await type.getByRole('button').all()) expect(await tall(button)).toBeGreaterThanOrEqual(44);
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
    await expect(card.locator('.card-h').getByRole('img', { name: t.subs.kindHint.api_key, exact: true })).toBeVisible();
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
    await expect(key).toHaveCSS('-webkit-text-security', 'disc');
    await form.getByRole('button', { name: t.subs.showTypedKey.label, exact: true }).click();
    await expect(key).toHaveCSS('-webkit-text-security', 'none');
    await form.getByRole('button', { name: t.subs.hideTypedKey.label, exact: true }).click();
    await expect(key).toHaveCSS('-webkit-text-security', 'disc');
    await expect(key).toHaveAttribute('type', 'text');
    expect(await tall(key)).toBeGreaterThanOrEqual(44);
    expect(await tall(form.getByRole('button', { name: t.subs.showTypedKey.label, exact: true }))).toBeGreaterThanOrEqual(44);
    await form.getByLabel(t.subs.apiName, { exact: true }).fill('Router 2');
    await expect(form.getByLabel(t.subs.apiAddress, { exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: t.subs.loadModels, exact: true }).click();
    await expect(form).toContainText(t.subs.modelsFound(3));
    const qwen = form.getByRole('checkbox', { name: 'Qwen 3 Coder', exact: true });
    /* A box stands at the first line of its name, the size of a box. */
    const [tick, name] = [await box(qwen), await box(form.locator('.model-found label').filter({ has: page.getByRole('checkbox', { name: 'Qwen 3 Coder', exact: true }) }).locator(':scope > span:not(.tick-box)'))];
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

/* A person who runs Marketing, without the whole company, connects an API key there alone and changes and removes the one
   that serves it; the form offers only Marketing and its sub-units. */
const DANA = { person: { id: 'p2', companyId: 'c1', name: 'Dana', email: 'dana@acme.com', title: 'CMO', status: 'active' as const, scopeKind: 'listed' as const, isOwner: false }, company: { id: 'c1', name: 'Acme' } };
const MARKETING_KEY: SubView = {
  ...CLAUDE_API, id: 's-mkt', label: 'Marketing key', last4: 'MKT1', owner: OWNER, place: { kind: 'department', id: 'd1', name: 'Marketing' },
  target: { kind: 'department', id: 'd1' }, canChange: true,
};
const department = (id: string, name: string, teams: { id: string; name: string }[]) => ({
  id, name, templateKey: null, roleCode: 'CMO', about: '', agents: { total: 0, working: 0 }, products: [], people: [], employees: [], roles: [],
  teams: teams.map(team => ({ ...team, about: '', stage: 0, gate: false, turnkey: false })),
});

/* Both languages in both skins, at a desk and on a phone, and right to left: Design's rules hold on the list, the card and
   the form, the tabs above stand whole, the version mark covers no button, and the pieces are drawn for Design. */
type OwnerLook = { lang: 'en' | 'ru'; skin: 'light' | 'cyberpunk'; width: number; dir: 'ltr' | 'rtl' };
const OWNER_LOOKS: OwnerLook[] = [
  ...(['en', 'ru'] as const).flatMap(lang => (['light', 'cyberpunk'] as const).flatMap(skin => [1440, 375].map(width => ({ lang, skin, width, dir: 'ltr' as const })))),
  { lang: 'en', skin: 'light', width: 1440, dir: 'rtl' },
  { lang: 'ru', skin: 'cyberpunk', width: 375, dir: 'rtl' },
];

for (const { lang, skin, width, dir } of OWNER_LOOKS) {
  const mode = skin === 'light' ? 'light' : `dark ${skin}`;
  const look = `${lang}-${skin}-${width}-${dir}`;
  test(`Subscriptions & API: a person who runs a department keeps its API keys there alone, ${lang} ${mode} ${width}${dir === 'rtl' ? ' right to left' : ''}`, async ({ page, browserName }, info) => {
    const t = messages[lang];
    const errors = watch(page);
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: NOW });
    await page.addInitScript(({ lang, skin, dir }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', skin);
      if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
    }, { lang, skin, dir });
    await serveSection(page, [], [MARKETING_KEY]);
    await page.route(url => pathOf(url) === '/api/subscriptions', route => route.fulfill({ json: { subscriptions: [MARKETING_KEY], apiPlaces: ['d1'] } }));
    await page.route(url => pathOf(url) === '/api/me', route => route.fulfill({ json: DANA }));
    await page.route(url => pathOf(url) === '/api/org', route => route.fulfill({ json: {
      company: DANA.company, people: [], agents: { total: 0, working: 0 },
      orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
      departments: [department('d1', 'Marketing', [{ id: 't1', name: 'Social media and long-form content' }]), department('d2', 'Development', [])],
    } }));
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: t.subs.heading, exact: true })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    const section = page.locator('section.subs');
    const pieces = { head: '.people-head', connect: '.head-actions > .btn', tools: '.tools', table: '.tbl', sortHeader: 'thead .sorth', sortButton: '.sortbar .sortb', rowButton: '.rowbtn' };
    expect(await tabsWhole(page)).toEqual([]);
    expect.soft(await offences(section, { danger: [], groups: '.head-actions' })).toEqual([]);
    const measured: Measured[] = [{ browser: browserName, look, screen: 'subscriptions', sizes: await sizes(section, pieces) }];
    await wholePage(page, info.outputPath(`subs-list-${look}-${browserName}.png`));

    const rowButton = page.locator('tr.rm').filter({ hasText: 'MKT1' }).locator('button.rowbtn');
    const sortControl = (await section.locator('thead').isVisible()) ? section.locator('button.sorth').first() : section.locator('button.sortb').first();
    for (const [label, target] of [['header', sortControl], ['row', rowButton]] as const) {
      await target.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
      expect(await focusRing(page)).toBe('ring');
      await around(page, target, info.outputPath(`subs-${label}-focus-${look}-${browserName}.png`));
    }
    if (dir === 'rtl') {
      const [btnBox, chevBox] = [await box(rowButton), await box(rowButton.locator('.chev'))];
      expect(btnBox.x + btnBox.width - (chevBox.x + chevBox.width)).toBeLessThanOrEqual(2);
    }

    await rowButton.click();
    const card = page.getByRole('article', { name: /MKT1/ });
    const name = subName(t, MARKETING_KEY);
    const remove = card.getByRole('button', { name: t.subs.removeLabel(name), exact: true });
    await expect(card.getByRole('button', { name: t.subs.editApiLabel(name), exact: true })).toBeVisible();
    await expect(remove).toBeVisible();
    expect(await fits(page)).toBe(true);
    /* A working plan's actions stand in the foot of its card since #1444. */
    expect.soft(await offences(card, { danger: [t.subs.remove], groups: '.plan-card-actions .form-foot' })).toEqual([]);
    measured.push({ browser: browserName, look, screen: 'subscriptions card', sizes: await sizes(card, { side: '.blk-side', actions: '.plan-card-actions .form-foot', action: '.plan-card-actions .form-foot > button' }) });
    await wholePage(page, info.outputPath(`subs-card-${look}-${browserName}.png`));

    /* The keyboard reaches Remove and shows where it is. */
    await remove.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(remove).toBeFocused();
    expect(await focusRing(page)).toBe('ring');
    await around(page, card.locator('.plan-card-actions .form-foot'), info.outputPath(`subs-focus-${look}-${browserName}.png`));

    await page.getByRole('button', { name: t.subs.connectApi, exact: true }).click();
    const form = page.getByRole('form', { name: t.subs.connectApi });
    const serves = form.getByLabel(t.subs.apiServes, { exact: true });
    await expect(serves).toHaveValue('department:d1');
    await expect(serves.locator('option')).toHaveText(['Marketing', 'Marketing, Social media and long-form content']);
    await form.getByLabel(t.subs.apiService, { exact: true }).selectOption('openrouter');
    await form.getByLabel(t.subs.apiKey, { exact: true }).fill(KEY);
    await form.getByRole('button', { name: t.subs.loadModels, exact: true }).click();
    await expect(form).toContainText(t.subs.modelsFound(3));
    await form.getByRole('checkbox', { name: 'Qwen 3 Coder', exact: true }).check();
    expect(await fits(page)).toBe(true);
    expect.soft(await offences(form, { danger: [], groups: '.form-foot' })).toEqual([]);
    measured.push({ browser: browserName, look, screen: 'subscriptions form', sizes: await sizes(form, { fields: '.field', foot: '.form-foot > .btn' }) });
    writeFileSync(info.outputPath('sizes.json'), JSON.stringify(measured));
    await form.getByRole('button', { name: t.common.cancel, exact: true }).scrollIntoViewIfNeeded();
    expect(await markClear(page)).toEqual([]);
    await page.screenshot({ path: info.outputPath(`subs-form-foot-${look}-${browserName}.png`) });
    await wholePage(page, info.outputPath(`subs-form-${look}-${browserName}.png`));
    expect(errors).toEqual([]);
  });
}

/* Every filter group with two values or more starts with All and its count, pressed until a value is; each button is a
   target of 44 px. A Codex plan of Maria's that waits for its sign-in gives Program, Owner and State two values each. */
test('Subscriptions & API: every filter group starts with All, ru dark cyberpunk 1440', async ({ page }, info) => {
  const errors = watch(page);
  const t = ru;
  const codex: SubView = { ...PLAN, id: 's-codex', provider: 'codex', label: 'Codex', tier: null, owner: { id: 'p2', name: 'Maria' }, status: 'needs_login', machines: [{ id: 'm1', hostname: 'node-a', status: 'needs_login', online: true }], limits: null, limitsUpdatedAt: null };
  await page.clock.install({ time: NOW });
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'ru');
    localStorage.setItem('hh-theme', 'cyberpunk');
  });
  await serveSection(page, [], [PLAN, codex, ROUTER, CLAUDE_API]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
  const rows = page.locator('tr.rm');
  await expect(rows).toHaveCount(4);
  /* The ink of a link in this skin, as the page computes it. */
  const linkInk = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--cyan-ink)';
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  for (const [label, option] of [[t.subs.payFilter, t.subs.pay.personal], [t.tables.provider, 'Codex'], [t.tables.owner, 'Maria'], [t.tables.status, t.subs.states.needs_login]]) {
    const group = page.getByRole('group', { name: label, exact: true });
    const all = group.getByRole('button').first();
    await expect(all).toHaveText(`${t.tables.all}4`);
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    for (const button of await group.getByRole('button').all()) expect(await tall(button)).toBeGreaterThanOrEqual(44);
    await group.getByRole('button', { name: new RegExp(option) }).click();
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    await expect(group.getByRole('button', { name: new RegExp(option) })).toHaveCSS('border-top-color', linkInk);
    await all.click();
    await expect(rows).toHaveCount(4);
  }
  /* A program keeps its own mark in its button. */
  await expect(page.getByRole('group', { name: t.tables.provider, exact: true }).getByRole('img', { name: 'Codex' })).toBeVisible();
  expect(await fits(page)).toBe(true);
  await page.locator('.tools').screenshot({ path: info.outputPath('filters-ru-cyberpunk-1440.png') });
  await page.screenshot({ path: info.outputPath('filters-page-ru-cyberpunk-1440.png'), fullPage: true });
  expect(errors).toEqual([]);
});

/* Wider than a phone, a table that needs more than its frame by whole words stands as entries; wider still, as a table. */
test('Subscriptions & API: entries where the table does not fit by whole words, ru light 830 and 1440', async ({ page }) => {
  const errors = watch(page);
  await page.clock.install({ time: NOW });
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'ru');
    localStorage.setItem('hh-theme', 'light');
  });
  await serveSection(page, []);
  await page.setViewportSize({ width: 830, height: 900 });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: ru.shell.tabs.subscriptions, exact: true }).click();
  const table = page.locator('.dt');
  await expect(table).toHaveAttribute('data-fit', 'entries');
  await expect(page.locator('.dt > thead')).toBeHidden();
  await expect(page.getByRole('group', { name: ru.tables.sortBy })).toBeVisible();
  expect(await tableFits(page)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(table).not.toHaveAttribute('data-fit');
  await expect(page.locator('.dt > thead')).toBeVisible();
  expect(await brokenHeaderWords(page)).toEqual([]);
  expect(await fits(page)).toBe(true);
  expect(errors).toEqual([]);
});

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
