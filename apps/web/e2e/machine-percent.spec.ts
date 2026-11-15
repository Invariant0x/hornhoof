import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { MachineView, Org, SubView } from '../src/types';
import type { BuiltinSkinId } from '../src/skins/registry';
import { ME, serveApi } from './api';

/* The percent sign of a share on the Machines screen, on the pool's tile and on a machine's Load meter, is set in the
   text font of the skin (--f-body) at the size and weight of the figures beside it, which keep the display font, in
   every shipped language, left to right and right to left, at desktop and phone width, and so is the sign of the used
   share of a plan's limit on the Subscriptions screen. The small unit beside the figure of a meter, a machine's memory,
   disk and processor and a plan's limit, keeps its own size, colour and font. */
test.describe.configure({ timeout: 180_000 });

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const SKINS: readonly BuiltinSkinId[] = ['cyberpunk', 'light'];
const WIDTHS = [[1440, 900], [375, 2400]] as const;
/* A language added to the registry fails to compile here until its words are added. */
const WORDS: Record<Language, Messages> = { en, ru };
const LANGS = LANGUAGES.map(language => language.id);

const machine = (id: string, hostname: string, cpus: number, load: number): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [],
  load: { cpus, load, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] },
});
/* 10% and 100%, the shortest and the longest share a machine shows; together 5 of 12 cores, 42%. */
const MACHINES: MachineView[] = [machine('m1', 'build-a', 10, 1), machine('m2', 'build-b', 2, 4)];
const SHARES: Record<string, string> = { 'build-a': '10%', 'build-b': '100%' };
/* A plan whose five hour window is 40% used: its meter's figure has the unit "used" beside it. */
const PLAN: SubView = {
  id: 's-claude', provider: 'claude', kind: 'personal', label: 'Claude', last4: null, tier: 'Max', status: 'ready', online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, machines: [{ id: 'm1', hostname: 'build-a', status: 'ready', online: true }],
  limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: '2026-11-15T15:00:00.000Z' }], complete: true },
  limitsUpdatedAt: '2026-11-15T11:58:00.000Z', budget: null, isOrchestrator: false, accounts: [], accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [],
};

async function openScreen(page: Page, language: Language, skin: BuiltinSkinId, width: number, height: number, tab: 'machines' | 'subscriptions') {
  await page.setViewportSize({ width, height });
  await page.clock.install({ time: NOW });
  await serveApi(page);
  await page.addInitScript(({ language, skin }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', skin);
  }, { language, skin });
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: MACHINES, builtin: null, priority: false, move: null, canMove: false, copies: null } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: tab === 'subscriptions' ? [PLAN] : [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: WORDS[language].shell.tabs[tab], exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

type Look = {
  text: string;
  sign: string;
  elements: number;
  signFamily: string;
  lineFamily: string;
  signSize: string;
  lineSize: string;
  signWeight: string;
  lineWeight: string;
  lineNumeric: string;
  lines: number;
  inside: boolean;
  body: string;
  display: string;
};

/* What a browser makes of a share: the sign set apart against the line it stands in, whose own text holds the figures,
   both against the skin's text and display fonts resolved by the same engine, and whether the share stays whole on one
   line inside its tile. */
async function look(sign: Locator, tile: Locator): Promise<Look> {
  const frame = await tile.elementHandle();
  return sign.evaluate((el, frame) => {
    const line = el.parentElement!;
    const probe = (token: string) => {
      const p = document.createElement('span');
      p.style.fontFamily = `var(${token})`;
      line.append(p);
      const family = getComputedStyle(p).fontFamily;
      p.remove();
      return family;
    };
    const own = getComputedStyle(el);
    const its = getComputedStyle(line);
    const range = document.createRange();
    range.selectNodeContents(line);
    /* Glyphs of two fonts on one line have boxes of their own heights: a box starts a new line only below the last. */
    let lines = 0;
    let bottom = -Infinity;
    for (const r of [...range.getClientRects()].filter(r => r.width > 0).sort((a, b) => a.top - b.top)) {
      if (r.top >= bottom - 1) lines++;
      bottom = r.top >= bottom - 1 ? r.bottom : Math.max(bottom, r.bottom);
    }
    const text = range.getBoundingClientRect();
    const box = (frame as Element).getBoundingClientRect();
    return {
      text: line.textContent ?? '',
      sign: el.textContent ?? '',
      elements: line.children.length,
      signFamily: own.fontFamily,
      lineFamily: its.fontFamily,
      signSize: own.fontSize,
      lineSize: its.fontSize,
      signWeight: own.fontWeight,
      lineWeight: its.fontWeight,
      lineNumeric: its.fontVariantNumeric,
      lines,
      inside: text.left >= box.left - 0.5 && text.right <= box.right + 0.5 && text.top >= box.top - 0.5 && text.bottom <= box.bottom + 0.5,
      body: probe('--f-body'),
      display: probe('--f-display'),
    };
  }, frame);
}

/* The figures stay in their line's display font with its tabular figures, and only the sign takes the text font, at the
   line's size and weight, with no space of its own. */
function expectSignInTextFont(seen: Look, text: string) {
  expect(seen.text).toBe(text);
  expect(seen.sign).toBe('%');
  expect(seen.elements).toBe(1);
  expect(seen.body).not.toBe(seen.display);
  expect(seen.lineFamily).toBe(seen.display);
  expect(seen.signFamily).toBe(seen.body);
  expect(seen.signSize).toBe(seen.lineSize);
  expect(seen.signWeight).toBe(seen.lineWeight);
  expect(seen.lineNumeric).toContain('tabular-nums');
  expect(seen.lines).toBe(1);
  expect(seen.inside).toBe(true);
}

/* The unit beside a meter's figure as it always was: 12.5 px in the skin's muted colour, in the font and weight of its line. */
async function expectUnitAsBefore(meter: Locator, text: string) {
  const unit = meter.locator('.g-f > span');
  expect(await unit.count()).toBe(1);
  const seen = await unit.evaluate(el => {
    const p = document.createElement('span');
    p.style.color = 'var(--muted)';
    el.parentElement!.append(p);
    const muted = getComputedStyle(p).color;
    p.remove();
    const style = getComputedStyle(el);
    const line = getComputedStyle(el.parentElement!);
    return { text: el.textContent, size: style.fontSize, color: style.color, family: style.fontFamily, weight: style.fontWeight, muted, lineFamily: line.fontFamily, lineWeight: line.fontWeight };
  });
  expect(seen.text).toBe(text);
  expect(seen.size).toBe('12.5px');
  expect(seen.color).toBe(seen.muted);
  expect(seen.family).toBe(seen.lineFamily);
  expect(seen.weight).toBe(seen.lineWeight);
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const skin of SKINS) for (const language of LANGS) for (const [width, height] of WIDTHS) {
  test(`sets the percent sign of the pool's and the cards' shares in the text font, ${skin} ${language} ${width}`, async ({ page }, info) => {
    const t = WORDS[language];
    await openScreen(page, language, skin, width, height, 'machines');
    const pool = page.getByRole('region', { name: t.machines.pool, exact: true });
    const busy = pool.locator('dd').filter({ has: page.locator('.pct') });
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      await pool.screenshot({ path: info.outputPath(`pool-${skin}-${language}-${width}-${dir}.png`) });
      for (const [hostname, share] of Object.entries(SHARES)) {
        const card = page.getByRole('article', { name: hostname, exact: true });
        if (!(await card.isVisible())) await page.getByRole('button', { name: t.tables.openCard(hostname), exact: true }).click();
        const gauges = card.locator('.gauges');
        await expect(gauges).toBeVisible();
        await gauges.screenshot({ path: info.outputPath(`card-${hostname}-${skin}-${language}-${width}-${dir}.png`) });
        const meter = (label: string) => gauges.locator('.gauge').filter({ has: page.getByText(label, { exact: true }) });
        /* The units of the other meters stay as they were. */
        const cpus = MACHINES.find(m => m.hostname === hostname)!.load!.cpus;
        const units: [string, string][] = [[t.machines.memory, t.cards.gbFree], [t.machines.disk, t.cards.gbFree], [t.machines.processor, ` ${t.cards.coresWord(cpus)}`]];
        for (const [label, unit] of units) {
          await meter(label).screenshot({ path: info.outputPath(`unit-${hostname}-${label}-${skin}-${language}-${width}-${dir}.png`) });
          await expectUnitAsBefore(meter(label), unit);
        }
        /* Counted at once: the card is drawn, so a share set apart is there or never comes. */
        expect(await meter(t.machines.load).locator('.g-f .pct').count()).toBe(1);
        const seen = await look(meter(t.machines.load).locator('.g-f .pct'), meter(t.machines.load));
        expectSignInTextFont(seen, share);
        /* The figures that are not shares keep the display font. */
        expect(await meter(t.machines.memory).locator('.g-f b').evaluate(el => getComputedStyle(el).fontFamily)).toBe(seen.display);
        /* A share's line stands as tall as a figure's line without one, so the meters keep their height. */
        const figures = await gauges.locator('.g-f b').evaluateAll(all => all.map(b => b.getBoundingClientRect().height));
        expect(Math.max(...figures) - Math.min(...figures)).toBeLessThan(0.01);
      }
      expect(await pool.locator('.pool-facts .pct').count()).toBe(1);
      expectSignInTextFont(await look(pool.locator('.pool-facts .pct'), busy), '42%');
      /* The pool's tile keeps its height: the share's figure, let take its own height, is as tall as the count of machines. */
      const own = await pool.locator('.pool-facts dd').evaluateAll(all => {
        for (const dd of all) (dd as HTMLElement).style.alignSelf = 'start';
        const heights = all.map(dd => dd.getBoundingClientRect().height);
        for (const dd of all) (dd as HTMLElement).style.alignSelf = '';
        return { online: heights[0]!, busy: heights[all.findIndex(dd => dd.querySelector('.pct'))]! };
      });
      expect(Math.abs(own.busy - own.online)).toBeLessThan(0.01);
      expect(await noSideScroll(page)).toBe(true);
    }
  });

  test(`sets the percent sign of a plan's used share in the text font and keeps its unit as it was, ${skin} ${language} ${width}`, async ({ page }, info) => {
    const t = WORDS[language];
    await openScreen(page, language, skin, width, height, 'subscriptions');
    await page.locator('tr.rm').filter({ hasText: 'Max' }).locator('button.rowbtn').click();
    const limit = page.getByRole('article').locator('.gauge').filter({ has: page.locator('.g-f > span', { hasText: t.cards.used }) });
    const meters = page.getByRole('article').locator('.gauges').filter({ has: page.locator('.g-f > span', { hasText: t.cards.used }) });
    await expect(limit).toBeVisible();
    /* Pictures first, both ways, so a look that fails still leaves them. */
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      await limit.screenshot({ path: info.outputPath(`unit-plan-limit-${skin}-${language}-${width}-${dir}.png`) });
      await meters.screenshot({ path: info.outputPath(`plan-limits-${skin}-${language}-${width}-${dir}.png`) });
    }
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      await expectUnitAsBefore(limit, t.cards.used);
      /* Counted at once: the card is drawn, so a share set apart is there or never comes. */
      expect(await limit.locator('.g-f .pct').count()).toBe(1);
      expectSignInTextFont(await look(limit.locator('.g-f .pct'), limit), '40%');
      /* The figure's line is as tall as a figure's line without a share, so the meter keeps its height. */
      const [shared, plain] = await limit.locator('.g-f b').evaluate(b => {
        const alone = document.createElement('b');
        alone.textContent = '40';
        b.parentElement!.append(alone);
        const heights = [b.getBoundingClientRect().height, alone.getBoundingClientRect().height];
        alone.remove();
        return heights;
      });
      expect(Math.abs(shared! - plain!)).toBeLessThan(0.01);
      expect(await noSideScroll(page)).toBe(true);
    }
  });
}
