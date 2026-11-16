import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { MachineView, Org, ShownCommand, SubView } from '../src/types';
import type { BuiltinSkinId } from '../src/skins/registry';
import { ME, serveApi } from './api';

/* The percent sign of a share on the Machines screen, on the pool's tile and on a machine's Load meter, is set in the
   text font of the skin (--f-body) at the size and weight of the figures beside it, which keep the display font, in
   every shipped language, left to right and right to left, at desktop and phone width, and so is the sign of the used
   share of a plan's limit on the Subscriptions screen. The small unit beside the figure of a meter, a machine's memory,
   disk and processor and a plan's limit, keeps its own size, colour and font. Each number of a plan's limits stands with
   its unit in one piece that reads left to right, and each phrase around such pieces reads whole, in the order and the
   direction its dictionary writes it, on a page laid out either way. The stripe beside what running a machine's command
   means, on the screen and on a machine's card, stands on the side its lines start from, with its gap, either way, and
   its words read whole in their own direction, their full stop after them. */
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
/* The same plan with both windows used and the time to each reset in whole hours and days, half a minute to spare, and a
   model's own week, whose name has words after its number. */
const at = (ms: number) => new Date(NOW + ms + 30_000).toISOString();
const PLAN_BOTH: SubView = {
  ...PLAN,
  limits: {
    status: 'allowed',
    windows: [
      { name: 'five_hour', utilization: 0.4, resetsAt: at(3 * 3600_000) },
      { name: 'seven_day', utilization: 0.7, resetsAt: at(3 * 24 * 3600_000) },
      { name: 'seven_day_opus', utilization: 0.2, resetsAt: at(3 * 24 * 3600_000) },
    ],
    complete: true,
  },
};
/* A command to join a machine, shown at the top of the screen, and one that brings the core to build-a, shown on its card:
   neither joins with a key, so both show as they are, each with what running it means. */
const COMMANDS: ShownCommand[] = [
  { id: 'c-machine', kind: 'machine', plans: [], machine: null, command: 'curl -fsSL https://hq.example.com/install.sh | bash', expiresAt: new Date(NOW + 3600_000).toISOString() },
  { id: 'c-core', kind: 'core', plans: [], machineId: 'm1', machine: 'build-a', command: 'curl -fsSL https://hq.example.com/install.sh | bash', expiresAt: new Date(NOW + 3600_000).toISOString() },
];
/* Where what a phrase says first stands: both shipped languages write left to right. A language added to the registry fails
   to compile here until its way is added. */
const READS: Record<Language, 'left' | 'right'> = { en: 'left', ru: 'left' };

async function openScreen(page: Page, language: Language, skin: BuiltinSkinId, width: number, height: number, tab: 'machines' | 'subscriptions', plans: SubView[] = [PLAN], commands: ShownCommand[] = []) {
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
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: tab === 'subscriptions' ? plans : [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands } }));
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

/* Where a piece of an element's text stands against another on screen: before it is to its left. Each is found by its
   text, the first where it first stands or, with from 'last', where it last does, the second after the first when both
   stand in the text in that order, else anywhere. */
async function place(el: Locator, first: string, second: string, from: 'first' | 'last' = 'first'): Promise<'left' | 'right' | 'mixed'> {
  return el.evaluate((root, [first, second, from]) => {
    const nodes: { node: Text; from: number }[] = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node: node as Text, from: text.length });
      text += node.textContent ?? '';
    }
    const box = (start: number, length: number) => {
      const at = (i: number) => {
        const hit = nodes.findLast(n => n.from <= i)!;
        return [hit.node, i - hit.from] as const;
      };
      const range = document.createRange();
      range.setStart(...at(start));
      range.setEnd(...at(start + length - 1));
      range.setEnd(range.endContainer, range.endOffset + 1);
      return range.getBoundingClientRect();
    };
    const a = from === 'last' ? text.lastIndexOf(first) : text.indexOf(first);
    const b = text.indexOf(second, a + first.length) >= 0 ? text.indexOf(second, a + first.length) : text.indexOf(second);
    if (a < 0 || b < 0) throw new Error(`"${first}" or "${second}" is not in "${text}"`);
    const [x, y] = [box(a, first.length), box(b, second.length)];
    if (!x.width || !y.width) throw new Error(`"${first}" or "${second}" in "${text}" is not on screen`);
    return x.right <= y.left + 1 ? 'left' : y.right <= x.left + 1 ? 'right' : 'mixed';
  }, [first, second, from] as const);
}

/* A number with its unit, as «3 дня»: the number stands to the left of its unit in either direction. */
async function expectWhole(el: Locator, piece: string) {
  const [number, unit] = [piece.slice(0, piece.indexOf(' ')), piece.slice(piece.indexOf(' ') + 1)];
  expect(`${piece}: ${await place(el, number, unit)}`).toBe(`${piece}: left`);
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

  test(`keeps each number of a plan's limits with its unit in one piece and each phrase in its dictionary's order, ${skin} ${language} ${width}`, async ({ page }, info) => {
    const t = WORDS[language];
    await openScreen(page, language, skin, width, height, 'subscriptions', [PLAN_BOTH]);
    const [five, seven, soon, later, resets] = [t.subs.hours(5), t.subs.days(7), t.cards.hours(3), t.subs.days(3), t.subs.resetsIn('').trim()];
    const row = page.locator('tr.rm').filter({ hasText: 'Max' });
    const cells = row.locator('.cell-lim');
    await expect(cells).toHaveCount(2);
    /* The page's time stands at NOW from here on, so each reset reads its whole hours and days however long a busy machine
       takes; the cells say so once the page's next second has come. */
    await page.clock.setFixedTime(NOW);
    await expect(cells.nth(0)).toHaveText(t.subs.usedAndReset('40%', t.subs.resetsIn(soon)));
    await expect(cells.nth(1)).toHaveText(t.subs.usedAndReset('70%', t.subs.resetsIn(later)));
    /* Pictures first, both ways, so a look that fails still leaves them. */
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      await page.locator('.tbl').screenshot({ path: info.outputPath(`limits-list-${skin}-${language}-${width}-${dir}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
    await row.locator('button.rowbtn').click();
    const meters = page.getByRole('article').locator('.gauge').filter({ has: page.locator('.g-f > span', { hasText: t.cards.used }) });
    await expect(meters).toHaveCount(3);
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      await page.getByRole('article').locator('.gauges').filter({ has: page.locator('.g-f > span', { hasText: t.cards.used }) }).screenshot({ path: info.outputPath(`limits-card-${skin}-${language}-${width}-${dir}.png`) });
    }
    /* What a phrase says first stands on the side its language writes from, whichever way the page is laid out. Each order
       is looked at softly, so one run names every phrase out of order. */
    const reads = READS[language];
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      /* A wide table names its columns in its head; one shown as entries names them on its sort buttons and by each entry. */
      const heads = page.locator('th .sorth:visible, .sortbar .sortb:visible');
      for (const name of [five, seven]) await expectWhole(heads.filter({ hasText: name }), name);
      for (const [cell, share, time] of [[cells.nth(0), '40%', soon], [cells.nth(1), '70%', later]] as const) {
        await expectWhole(cell, time);
        expect(await place(cell, share.slice(0, -1), '%')).toBe('left');
        /* The separator follows the share as the phrase reads, and the words of the reset follow it, then their time. */
        expect.soft(`${dir} ${share} ,: ${await place(cell, share, ',')}`).toBe(`${dir} ${share} ,: ${reads}`);
        expect.soft(`${dir} , ${resets}: ${await place(cell, ',', resets)}`).toBe(`${dir} , ${resets}: ${reads}`);
        expect.soft(`${dir} ${resets} ${time}: ${await place(cell, resets, time)}`).toBe(`${dir} ${resets} ${time}: ${reads}`);
      }
      for (const [meter, name, time] of [[meters.nth(0), five, soon], [meters.nth(1), seven, later], [meters.nth(2), seven, later]] as const) {
        await expectWhole(meter.locator('.g-l'), name);
        await expectWhole(meter.locator('.g-s'), time);
        expect.soft(`${dir} ${resets} ${time}: ${await place(meter.locator('.g-s'), resets, time)}`).toBe(`${dir} ${resets} ${time}: ${reads}`);
      }
      /* A model's week: its words follow its number with their separator, as the name reads. */
      expect.soft(`${dir} ${seven} , Opus: ${await place(meters.nth(2).locator('.g-l'), seven, ', Opus')}`).toBe(`${dir} ${seven} , Opus: ${reads}`);
      expect(await noSideScroll(page)).toBe(true);
    }
  });

  test(`draws the stripe beside what running a machine's command means on the side its lines start from, ${skin} ${language} ${width}`, async ({ page }, info) => {
    const t = WORDS[language];
    await openScreen(page, language, skin, width, height, 'machines', [PLAN], COMMANDS);
    const card = page.getByRole('article', { name: 'build-a', exact: true });
    if (!(await card.isVisible())) await page.getByRole('button', { name: t.tables.openCard('build-a'), exact: true }).click();
    const stripes: [string, Locator][] = [['screen', page.locator('.panel .trust')], ['card', card.locator('.trust')]];
    /* The phrase's last word and the full stop after it. */
    const [word, stop] = [t.machines.trust.slice(0, -1).split(' ').at(-1)!, t.machines.trust.at(-1)!];
    for (const [, stripe] of stripes) await expect(stripe).toHaveText(t.machines.trust);
    /* Pictures first, both ways, so a look that fails still leaves them. */
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      for (const [where, stripe] of stripes) await stripe.screenshot({ path: info.outputPath(`trust-${where}-${skin}-${language}-${width}-${dir}.png`) });
    }
    /* The stripe and its gap stand where the lines start, nothing on the other side, and the text starts right after both.
       Each side is looked at softly, so one run names every stripe on the wrong side. */
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      for (const [where, stripe] of stripes) {
        const seen = await stripe.evaluate((el, dir) => {
          const [start, end] = dir === 'rtl' ? ['right', 'left'] as const : ['left', 'right'] as const;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          const lines = [...range.getClientRects()];
          const gap = start === 'left' ? Math.min(...lines.map(r => r.left)) - box.left : box.right - Math.max(...lines.map(r => r.right));
          const side = (s: 'left' | 'right') => `${style.getPropertyValue(`border-${s}-width`)} ${style.getPropertyValue(`padding-${s}`)}`;
          return `start ${side(start)}, end ${side(end)}, text after ${Math.round(gap)}px`;
        }, dir);
        expect.soft(`${dir} ${where}: ${seen}`).toBe(`${dir} ${where}: start 3px 10px, end 0px 0px, text after 13px`);
        /* The phrase reads in its own language's direction on a page laid out either way: its full stop follows its last word. */
        expect.soft(`${dir} ${where} ${word}${stop}: ${await place(stripe, word, stop, 'last')}`).toBe(`${dir} ${where} ${word}${stop}: ${READS[language]}`);
      }
      expect(await noSideScroll(page)).toBe(true);
    }
  });
}
