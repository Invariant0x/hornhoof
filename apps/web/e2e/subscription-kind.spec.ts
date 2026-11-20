import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { ModelTokens, SubView, TokenPeriods, TokenSum } from '../src/types';
import { box, serveApi } from './api';

/* What Ivan asked of the list of Subscriptions & API: long words took more room in a row than what it holds. How each
   connection is paid now stands as a sign by its name, with its full words as the sign's name and tooltip; the name is
   one short line, the provider and its tier; the orchestrator's role is a small line under the name; no row and no card
   says it in a badge any more. The longest language and a page laid out right to left keep the sign by the name. */
test.describe.configure({ timeout: 0 });

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
/* The key's 30 days by model, so its card shows each model's count and share. */
const MODELS: Record<string, ModelTokens[]> = { 's-router': [{ model: 'qwen/qwen-3-coder', total: 15_000_000 }, { model: null, total: 10_000_000 }] };
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
    return route.fulfill({ json: { tokens: sub.tokens, models: MODELS[sub.id] ?? [] } });
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

/* The sign stands right after the name's last letter, on the name's last line and inside its frame, whichever way the page
   reads: the words of that line end by it, as a sign alone on a line or at the end of another would leave the name. */
async function signByName(sign: Locator, name: Locator, frame: Locator, dir: 'ltr' | 'rtl') {
  const words = await name.evaluate(el => {
    const sign = el.querySelector('[role="img"]')!;
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEndBefore(sign);
    const rects = [...range.getClientRects()].filter(r => r.width > 0);
    const s = sign.getBoundingClientRect();
    const middle = (s.top + s.bottom) / 2;
    const line = rects.filter(r => r.top <= middle && r.bottom >= middle);
    return { last: Math.max(...rects.map(r => r.top)), lineTop: Math.min(...line.map(r => r.top)), left: Math.min(...line.map(r => r.left)), right: Math.max(...line.map(r => r.right)), count: line.length };
  });
  expect(words.count).toBeGreaterThan(0);
  expect(words.lineTop).toBeGreaterThanOrEqual(words.last - 1);
  const s = await box(sign);
  const gap = dir === 'ltr' ? s.x - words.right : words.left - (s.x + s.width);
  expect(gap).toBeGreaterThanOrEqual(-0.5);
  expect(gap).toBeLessThanOrEqual(10);
  const f = await box(frame);
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

/* Every token count on the screen, read where it stands, and a tile's name of so many days: its number and its unit (or
   percent sign) left to right as one piece, and the words around it mirrored where the page reads right to left: a tile's line starts with its word from the
   right, and a model's share stands left of its count. Each miss is named, so one run shows them all. */
async function tokenCountsInRtl(page: Page, t: typeof en): Promise<string[]> {
  return page.evaluate(({ column, title }) => {
    const out: string[] = [];
    /* The box of the characters [from, to) of an element's text, whatever elements inside hold them. */
    const rectOf = (el: Element, from: number, to: number) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let seen = 0;
      let started = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent!.length;
        if (!started && from < seen + length) { range.setStart(node, from - seen); started = true; }
        if (started && to <= seen + length) { range.setEnd(node, to - seen); break; }
        seen += length;
      }
      return range.getBoundingClientRect();
    };
    /* The count that ends an element's text [from, to), with the words before it, if any. */
    const count = (where: string, el: Element, from = 0, to = el.textContent!.length) => {
      const text = el.textContent!.slice(from, to);
      const found = /(\d(?:[\d.,\s]*\d)?)(\s*)([^\d\s.,]*)\s*$/.exec(text);
      if (!found) return out.push(`${where}: no count in "${text}"`);
      const [, number, gap, unit] = found;
      const at = from + found.index;
      const n = rectOf(el, at, at + number!.length);
      const whole = unit ? rectOf(el, at, at + number!.length + gap!.length + unit.length) : n;
      if (unit) {
        const u = rectOf(el, at + number!.length + gap!.length, at + number!.length + gap!.length + unit.length);
        if (n.right > u.left + 1) out.push(`${where}: "${text.slice(found.index).trim()}" reads unit first (number at x=${Math.round(n.left)}, "${unit}" at x=${Math.round(u.left)})`);
      }
      const words = text.slice(0, found.index).trim();
      if (words) {
        const start = from + text.indexOf(words);
        const w = rectOf(el, start, start + words.length);
        if (w.left < whole.right - 1) out.push(`${where}: "${words}" stands left of its count "${text.slice(found.index).trim()}"`);
      }
      return out.length;
    };
    /* Only the cards' tokens parts: their limits are the meter's own (#1037). */
    const parts = [...document.querySelectorAll('article .part')].filter(part => part.querySelector('.part-h')?.textContent === title);
    const all = (selector: string) => selector.startsWith('article ') ? parts.flatMap(part => [...part.querySelectorAll(selector.slice(8))]) : [...document.querySelectorAll(selector)];
    const cells = all(`tr.rm td[data-label="${column}"]`);
    if (!cells.length) out.push('no token cells in the list');
    cells.forEach((cell, i) => count(`list row ${i + 1}`, cell));
    const figures = all('article .g-f b');
    if (!figures.length) out.push('no tile figures');
    figures.forEach((figure, i) => count(`tile ${i + 1}`, figure));
    /* A tile's name that holds a number, «7 дней», is a count as well. */
    all('article .g-l').filter(name => /\d/.test(name.textContent!)).forEach((name, i) => count(`tile name ${i + 1}`, name));
    const lines = all('article .g-s > span');
    if (!lines.length) out.push('no tile lines');
    lines.forEach((line, i) => count(`tile line ${i + 1}`, line));
    const shares = all('article .models .dd');
    if (!shares.length) out.push('no model shares');
    shares.forEach((dd, i) => {
      const small = dd.querySelector('small')!;
      const length = dd.textContent!.length;
      const split = length - small.textContent!.length;
      count(`model ${i + 1} count`, dd, 0, split);
      count(`model ${i + 1} share`, small);
      const [whole, share] = [rectOf(dd, 0, split), small.getBoundingClientRect()];
      if (share.right > whole.left + 1) out.push(`model ${i + 1}: share "${small.textContent}" stands right of its count "${dd.textContent!.slice(0, split)}"`);
    });
    return out;
  }, { column: t.subs.tokensColumn, title: t.subs.tokens.title });
}

/* Design #1053: a page laid out right to left read a token count unit first, «млн 25» for «25 млн». */
for (const { lang, skin, width } of LOOKS.filter(look => look.dir === 'rtl')) {
  const mode = skin === 'light' ? 'light' : `dark ${skin}`;
  test(`Subscriptions: each token count reads number then unit right to left, ${lang} ${mode} ${width} rtl`, async ({ page, browserName }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const t = await openList(page, lang, skin, width, 'rtl');
    for (const s of [ROUTER, CLAUDE]) await rowOf(page, s).locator('button.rowbtn').click();
    const router = page.getByRole('article', { name: /WXYZ/ });
    await expect(router.locator('.models li')).toHaveCount(2);
    /* The look as it stands, before anything is judged: the whole page, and the key's tokens close. */
    await shootWhole(page, info.outputPath(`tokens-rtl-${browserName}-${lang}-${skin}-${width}.png`));
    const part = router.locator('.part').filter({ has: page.getByRole('heading', { name: t.subs.tokens.title, exact: true }) });
    await part.scrollIntoViewIfNeeded();
    await part.screenshot({ path: info.outputPath(`tokens-rtl-card-${browserName}-${lang}-${skin}-${width}.png`) });

    expect(await tokenCountsInRtl(page, t)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
