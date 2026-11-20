import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Messages } from '../src/i18n';
import type { Limits, SubView } from '../src/types';
import { SUB } from './agent-window-api';
import { serveApi } from './api';

/* The card of a plan that keeps its limits by model group (#1589): Antigravity's Claude and GPT models used their week while
   its Gemini models have most of theirs, so the card shows each group under its own name with what it used and when it
   resets, and the plan is ready. Made-up numbers; every answer of the server is the test's own. Run in Chromium, Firefox
   and WebKit by plan-limit-groups.config.ts; Chromium leaves the pictures for Design. */

type Lang = 'en' | 'ru';
type Skin = 'cyberpunk' | 'light';
type Look = { lang: Lang; skin: Skin; width: number };
const MESSAGES: Record<Lang, Messages> = { en, ru };
const lookName = ({ lang, skin, width }: Look) => `${lang}, ${skin}, ${width}px`;

const HOUR = 3_600_000;
/* Resets a fixed time from the moment the page opens, so the words of each reset read the same in every engine. */
function grouped(now: number): Limits {
  const at = (hours: number) => new Date(now + hours * HOUR).toISOString();
  const gemini = { name: 'Gemini Models', about: 'Models within this group: Gemini Flash, Gemini Pro', status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0, resetsAt: at(3) }, { name: 'seven_day', utilization: 0.06, resetsAt: at(110) }], complete: true };
  const others = { name: 'Claude and GPT models', about: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: at(4) }, { name: 'seven_day', utilization: 1, resetsAt: at(60) }], complete: true };
  return { status: 'rejected', windows: others.windows, complete: true, groups: [gemini, others] };
}

const agy = (now: number): SubView => ({
  ...SUB, id: 's-agy', provider: 'antigravity', label: 'Antigravity', owner: { id: 'p1', name: 'Ivan' }, agents: [], fallbacks: [], models: [],
  machines: [{ id: 'm1', hostname: 'example-node-01', status: 'ready', online: true }], limits: grouped(now), limitsUpdatedAt: new Date(now).toISOString(),
});

async function opened(page: Page, look: Look): Promise<{ card: Locator; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang: look.lang, skin: look.skin });
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [agy(Date.now())] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.goto('/');
  const t = MESSAGES[look.lang];
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
  await page.getByRole('button', { name: t.tables.openCard('Antigravity') }).click();
  await page.evaluate(async () => { await document.fonts.ready; });
  const card = page.getByRole('article', { name: 'Antigravity, Ivan' });
  await expect(card.getByRole('heading', { name: t.subs.groupLimits('Gemini Models') })).toBeVisible();
  return { card, errors };
}

/* What breaks the limits as drawn: a piece out of the card, words cut or ended in dots, a page wider than its window. */
async function whole(card: Locator): Promise<string[]> {
  return card.evaluate(root => {
    const out: string[] = [];
    const frame = root.getBoundingClientRect();
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const parts = [...root.querySelectorAll('.part')].filter(p => p.querySelector('.gauges'));
    for (const el of parts.flatMap(p => [p, ...p.querySelectorAll('*')])) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < frame.left - 0.5 || r.right > frame.right + 0.5)) out.push(`${name(el)} stands out of the card`);
      const s = getComputedStyle(el);
      if (s.textOverflow === 'ellipsis') out.push(`${name(el)} ends its words in dots`);
      if (el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible') out.push(`${name(el)} is cut: ${el.scrollWidth} in ${el.clientWidth}`);
    }
    if (document.documentElement.scrollWidth > innerWidth) out.push(`the page is ${document.documentElement.scrollWidth}px wide in ${innerWidth}`);
    return out;
  });
}

/* A picture of the card in a window as tall as the page, so none of it scrolls away; the window is given back as it was. */
async function shoot(page: Page, piece: Locator, path: string): Promise<string> {
  const size = page.viewportSize()!;
  const tall = await page.evaluate(() => Math.max(innerHeight, ...[...document.querySelectorAll('*')].map(el => el.getBoundingClientRect().top + el.scrollHeight)));
  await page.setViewportSize({ width: size.width, height: Math.min(8000, Math.ceil(tall)) });
  await piece.screenshot({ path });
  await page.setViewportSize(size);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const LOOKS: Look[] = (['en', 'ru'] as const).flatMap(lang => (['cyberpunk', 'light'] as const).flatMap(skin => [375, 1440].map(width => ({ lang, skin, width }))));

for (const look of LOOKS) {
  test(`shows each model group of the plan with what it used and when it resets, in ${lookName(look)}`, async ({ page, browserName }, info) => {
    const t = MESSAGES[look.lang];
    const { card, errors } = await opened(page, look);
    await expect(card.getByRole('heading', { name: t.subs.limits, exact: true })).toHaveCount(0);
    for (const [group, shares] of [['Gemini Models', ['0%', '6%']], ['Claude and GPT models', ['100%', '100%']]] as const) {
      const part = card.locator('.part').filter({ has: page.getByRole('heading', { name: t.subs.groupLimits(group) }) });
      await expect(part.locator('.gauge .g-l')).toHaveText([t.subs.hours(5), t.subs.days(7)]);
      await expect(part.locator('.gauge .g-f b')).toHaveText([...shares]);
      for (const reset of await part.locator('.gauge .g-s').allTextContents()) expect(reset).toMatch(look.lang === 'en' ? /^resets in / : /^до сброса /);
    }
    /* One group at its limit leaves the plan ready: Gemini's turns go on. */
    await expect(card.locator('.status')).toHaveText(t.subs.states.ready);
    expect(await whole(card)).toEqual([]);
    if (browserName === 'chromium') {
      const file = `card-${look.skin}-${look.lang}-${look.width}.png`;
      const sha = await shoot(page, card, info.outputPath(file));
      await info.attach(`${file} sha256`, { body: sha });
    }
    expect(errors).toEqual([]);
  });
}

/* Each number of the card with the unit or word it goes with, as "14 h", "1 online" or "Input 0", that lands on two lines:
   a pair whose pieces of text do not share one line box (#1601). */
async function splitPairs(card: Locator): Promise<string[]> {
  return card.evaluate(root => {
    const out: string[] = [];
    const oneLine = (range: Range) => {
      const tops = [...range.getClientRects()].filter(r => r.width > 0).map(r => r.top + r.height / 2);
      return Math.max(...tops) - Math.min(...tops) < 2;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const pair of (node.textContent ?? '').matchAll(/\d+[  ]\p{L}+|\p{L}+:[  ]\d+/gu)) {
        const range = document.createRange();
        range.setStart(node, pair.index);
        range.setEnd(node, pair.index + pair[0].length);
        if (!oneLine(range)) out.push(pair[0]);
      }
    }
    for (const label of root.querySelectorAll('.gauge .g-s > span')) {
      const range = document.createRange();
      range.selectNodeContents(label);
      if (!oneLine(range)) out.push(label.textContent ?? '');
    }
    return out;
  });
}

for (const look of LOOKS.filter(look => look.width === 375)) {
  test(`keeps each number of the card on one line with its unit, and still wraps between them, in ${lookName(look)}`, async ({ page }) => {
    const { card, errors } = await opened(page, look);
    expect(await splitPairs(card)).toEqual([]);
    /* A reset longer than its tile wraps between its pieces, "4 days" over "14 h", and nothing of the card is cut for it. */
    expect(await whole(card)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
