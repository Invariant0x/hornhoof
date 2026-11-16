import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { SubView, TokenPeriods, TokenSum } from '../src/types';
import { box, serveApi } from './api';

/* What Ivan asked of the list of Subscriptions & API: long words took more room in a row than what it holds. How each
   connection is paid now stands as a sign by its name, with its full words as the sign's name and tooltip; the name is
   one short line, the provider and its tier; the orchestrator's role is a small line under the name; no row and no card
   says it in a badge any more. The longest language and a page laid out right to left keep the sign by the name. */
test.describe.configure({ timeout: 180_000 });

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const messages = { en, ru };

const sum = (total: number): TokenSum => ({ input: total / 10, output: total / 20, cacheRead: total - total / 10 - total / 20 - total / 20, cacheWrite: total / 20, total, turns: 3, noData: 0 });
const periods = (today: number): TokenPeriods => ({ today: sum(today), week: sum(today * 6), month: sum(today * 20), all: sum(today * 40) });

const OWNER = { id: 'p1', name: 'Ivan' };
const COMPANY = { kind: 'company' as const, id: null, name: 'Whole company' };
const LIMITS = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: '2026-11-15T15:00:00.000Z' }, { name: 'seven_day', utilization: 0.7, resetsAt: '2026-11-19T09:00:00.000Z' }], complete: true };
const base = {
  status: 'ready' as const, online: true, owner: OWNER, place: COMPANY, limits: null, limitsUpdatedAt: '2026-11-15T11:58:00.000Z',
  budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [],
};
/* Plans by their tier as the machine tells it, in small letters; keys by what they end in. */
const CLAUDE: SubView = {
  ...base, id: 's-claude', provider: 'claude', kind: 'personal', label: 'Claude', last4: null, tier: 'max',
  machines: [{ id: 'm1', hostname: 'node-a', status: 'ready', online: true }], limits: LIMITS, tokens: periods(120_000),
};
const CODEX: SubView = {
  ...base, id: 's-codex', provider: 'codex', kind: 'personal', label: 'Codex', last4: null, tier: 'pro', owner: { id: 'p2', name: 'Maria' },
  machines: [{ id: 'm2', hostname: 'node-b', status: 'ready', online: true }], limits: LIMITS, tokens: periods(80_000),
};
const ROUTER: SubView = {
  ...base, kind: 'api_key', id: 's-router', provider: 'openrouter', label: 'OpenRouter', last4: 'WXYZ', isOrchestrator: true, machines: [],
  api: { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' }, models: [{ id: 'qwen/qwen-3-coder', name: 'Qwen 3 Coder' }], target: { kind: 'orchestrator', id: null }, tokens: periods(1_250_000),
};
/* A key named at length, so its name wraps on a phone. */
const LONG: SubView = {
  ...base, kind: 'api_key', id: 's-long', provider: 'custom_api', label: 'Northern region partner shops language gateway', last4: 'M3N4', machines: [],
  api: { baseUrl: 'https://llm.northern-region.example/v1', protocol: 'openai' }, models: [{ id: 'coder', name: 'coder' }], target: { kind: 'any', id: null }, tokens: periods(0),
};
const LIST = [CLAUDE, CODEX, ROUTER, LONG];
/* What a person reads as each name, in every language. */
const NAMES: Record<string, string> = { 's-claude': 'Claude Max', 's-codex': 'Codex Pro', 's-router': 'OpenRouter ••••WXYZ', 's-long': `${LONG.label} ••••M3N4` };
const KEYS: Record<string, string> = { 's-claude': 'node-a', 's-codex': 'Maria', 's-router': 'WXYZ', 's-long': 'M3N4' };

const pathOf = (url: URL | string) => new URL(url.toString()).pathname;

async function openList(page: Page, lang: 'en' | 'ru', skin: string, width: number, dir: 'ltr' | 'rtl') {
  const t = messages[lang];
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ lang, skin }) => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', skin); }, { lang, skin });
  await serveApi(page);
  await page.route(url => pathOf(url) === '/api/subscriptions', route => route.fulfill({ json: { subscriptions: LIST } }));
  await page.route(url => /^\/api\/subscriptions\/[^/]+\/tokens$/.test(pathOf(url)), route => {
    const sub = LIST.find(s => s.id === pathOf(route.request().url()).split('/')[3])!;
    return route.fulfill({ json: { tokens: sub.tokens, models: [] } });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
  await expect(page.locator('tr.rm')).toHaveCount(LIST.length);
  await page.evaluate(() => document.fonts.ready);
  return t;
}

/* The page scrolls inside its own panel, so the window grows by what that panel hides for the picture, and then shrinks back. */
async function shootWhole(page: Page, path: string) {
  const hidden = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('*')]
    .filter(el => /auto|scroll/.test(getComputedStyle(el).overflowY)).map(el => el.scrollHeight - el.clientHeight)));
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: size.height + hidden });
  await page.screenshot({ path, fullPage: true });
  await page.setViewportSize(size);
}

const rowOf = (page: Page, s: SubView) => page.locator('tr.rm').filter({ hasText: KEYS[s.id]! });

const lineHeight = (el: Locator) => el.evaluate(e => parseFloat(getComputedStyle(e).lineHeight));

/* The sign stands by the end of the name's first line, inside its frame, whichever way the page reads: on a line of its
   own it would leave the name. */
async function signByName(sign: Locator, name: Locator, frame: Locator, dir: 'ltr' | 'rtl') {
  const [s, n, f] = [await box(sign), await box(name), await box(frame)];
  const middle = s.y + s.height / 2;
  expect(middle).toBeGreaterThanOrEqual(n.y);
  expect(middle).toBeLessThanOrEqual(n.y + await lineHeight(name));
  const gap = dir === 'ltr' ? s.x - (n.x + n.width) : n.x - (s.x + s.width);
  expect(gap).toBeGreaterThanOrEqual(-0.5);
  expect(gap).toBeLessThanOrEqual(8);
  expect(s.x).toBeGreaterThanOrEqual(f.x - 0.5);
  expect(s.x + s.width).toBeLessThanOrEqual(f.x + f.width + 0.5);
}

/* A small line right under the name, starting where the name starts. */
async function lineUnder(line: Locator, name: Locator, dir: 'ltr' | 'rtl') {
  const [l, n] = [await box(line), await box(name)];
  expect(l.y).toBeGreaterThanOrEqual(n.y + n.height - 0.5);
  expect(l.y - (n.y + n.height)).toBeLessThanOrEqual(8);
  if (dir === 'ltr') expect(Math.abs(l.x - n.x)).toBeLessThanOrEqual(1);
  else expect(Math.abs(l.x + l.width - (n.x + n.width))).toBeLessThanOrEqual(1);
  const [small, big] = await Promise.all([line, name].map(el => el.evaluate(e => parseFloat(getComputedStyle(e).fontSize))));
  expect(small).toBeLessThan(big!);
}

const LOOKS = (['en', 'ru'] as const).flatMap(lang => ['cyberpunk', 'light'].flatMap(skin => [1440, 375].flatMap(width => (['ltr', 'rtl'] as const).map(dir => ({ lang, skin, width, dir })))));

for (const { lang, skin, width, dir } of LOOKS) {
  const mode = skin === 'light' ? 'light' : `dark ${skin}`;
  test(`Subscriptions: how each is paid by its name, one short name and the orchestrator under it, ${lang} ${mode} ${width} ${dir}`, async ({ page, browserName }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const t = await openList(page, lang, skin, width, dir);
    for (const s of [ROUTER, CLAUDE]) await rowOf(page, s).locator('button.rowbtn').click();
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) await expect(card.locator('.gauge').first()).toBeVisible();
    /* The look as it stands, before anything is judged, so the same test shows a page before and after a change. */
    await shootWhole(page, info.outputPath(`subscriptions-${browserName}-${lang}-${skin}-${width}-${dir}.png`));

    /* The list and both cards are drawn now, so what follows reads them as they stand. */
    for (const s of LIST) {
      const row = rowOf(page, s);
      const cell = row.locator('td.k-name');
      const words = t.subs.kindHint[s.kind];
      /* No row says in words how it is paid or that it serves the orchestrator. */
      expect.soft(await cell.locator('.badge').count(), `badges by ${NAMES[s.id]}`).toBe(0);
      const text = await row.textContent();
      for (const word of Object.values(t.subs.pay)) expect.soft(text, `the row of ${NAMES[s.id]}`).not.toContain(word);
      const name = cell.locator('.nm b');
      expect.soft(await name.textContent(), 'the name in the list').toBe(NAMES[s.id]);
      const sign = cell.getByRole('img', { name: words, exact: true });
      expect.soft(await sign.isVisible(), `the sign by ${NAMES[s.id]}`).toBe(true);
      if (await sign.isVisible()) {
        expect(await sign.getAttribute('title')).toBe(words);
        await signByName(sign, name, cell, dir);
      }
      if (s.kind === 'personal') expect((await box(name)).height).toBeLessThan(await lineHeight(name) * 1.5);
      const role = cell.locator('.nm small').filter({ hasText: t.subs.orchestrator });
      expect.soft(await role.count(), `the line under ${NAMES[s.id]}`).toBe(s.isOrchestrator ? 1 : 0);
      if (s.isOrchestrator && await role.count() === 1) await lineUnder(role, name, dir);
    }

    for (const s of [ROUTER, CLAUDE]) {
      const head = page.getByRole('article', { name: new RegExp(s.last4 ?? `^${s.label}`) }).locator('.card-h');
      const title = head.getByRole('heading', { level: 3 });
      expect.soft(await title.textContent(), 'the name on the card').toBe(NAMES[s.id]);
      expect.soft(await head.locator('.badge').count(), `badges on the card of ${NAMES[s.id]}`).toBe(0);
      const sign = head.getByRole('img', { name: t.subs.kindHint[s.kind], exact: true });
      expect.soft(await sign.isVisible(), `the sign on the card of ${NAMES[s.id]}`).toBe(true);
      if (await sign.isVisible()) await signByName(sign, title, head, dir);
      const role = head.getByText(t.subs.orchestrator, { exact: true });
      expect.soft(await role.count(), `the line under ${NAMES[s.id]} on its card`).toBe(s.isOrchestrator ? 1 : 0);
      if (s.isOrchestrator && await role.count() === 1) await lineUnder(role, title, dir);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
