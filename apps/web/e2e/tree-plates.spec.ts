import { expect, test, type Locator, type Page } from '@playwright/test';
import type { DepartmentTree, Org } from '../src/types';
import { box } from './api';
import { serveTree } from './tree-api';
import { wholeTurn } from './whole-turn';

type Tree = { tree: DepartmentTree; org: Org };
type Frame = { x: number; y: number; width: number; height: number };

/* Long texts with a word too long for a line, as branch and tool names are. */
const LONG_TITLE = 'Move the checkout to the new payment_provider_and_keep_every_old_receipt_readable in both languages for years';
const LONG_NAME = 'Oleg Constantinopolskyvonhohenzollernbergovich Jr';
const LONG_ROLE = 'Engineer_of_payments_and_receipts_in_both_languages';
const LONG_WAIT = 'Image_build_of_the_new_checkout_on_the_slowest_machine';
const LONG_BRANCH = 'release_2026_11_checkout_with_the_new_payment_provider';
const PLATE = { width: 240, height: 84 };
const FONTS = { name: '13.5px', role: '12px', task: '12px', state: '11px' };

/* A department at its real size: 12 lanes and more than 50 tasks, one agent with no state to show, and very long texts. */
function fullDepartment(): Tree {
  const { tree, org } = wholeTurn(true);
  const employees = org.departments[0]!.employees, sample = tree.lines.find(l => l.agent.name === 'Timur')!;
  org.departments[0]!.repository!.branch = LONG_BRANCH;
  tree.lines.find(l => l.externalWait)!.externalWait!.reason = LONG_WAIT;
  ['Lena', 'Mark', 'Nora', LONG_NAME].forEach((name, a) => {
    const agent = { id: `x${a}`, name };
    employees.push({ ...employees[1]!, ...agent, status: a ? 'idle' : 'off', title: name === LONG_NAME ? { en: LONG_ROLE, ru: LONG_ROLE } : employees[1]!.title });
    for (let i = 0; i < 5; i++) {
      const from = new Date(Date.parse(tree.turn!.startedAt) + (a * 50 + i * 40) * 60_000).toISOString();
      const to = new Date(Date.parse(from) + 30 * 60_000).toISOString();
      tree.lines.push({ ...sample, taskId: `x${a}-${i}`, number: 200 + a * 10 + i, title: name === 'Mark' && i === 4 ? LONG_TITLE : `Checkout part ${a}.${i}`, agent,
        createdAt: from, cutAt: from, mergedAt: to, doneAt: null, segments: [{ kind: 'work', from, to }], moves: [], lastActionAt: to, live: false });
    }
  });
  return { tree, org };
}

/* The same turn as a department of this one agent would see it. */
function aloneIn({ tree, org }: Tree, name: string): Tree {
  const mine = (agent: { name: string }) => agent.name === name, department = org.departments[0]!;
  const reviews = tree.reviews!.map(r => ({ ...r, reviewers: r.reviewers.filter(p => mine(p.agent)) })).filter(r => r.reviewers.length);
  return {
    org: { ...org, departments: [{ ...department, employees: department.employees.filter(mine), repository: { ...department.repository!, branch: 'main' } }] },
    tree: { ...tree, reviews, review: reviews.at(-1) ?? null, lines: tree.lines.filter(l => mine(l.agent)), activity: tree.activity!.filter(a => mine(a.agent)),
      idle: tree.idle.filter(i => mine(i.agent)), waiting: tree.waiting!.filter(w => mine(w.agent)), time: tree.time.filter(t => mine(t.agent)) },
  };
}

async function open(page: Page, lang: 'en' | 'ru') {
  await page.goto('/');
  await page.getByRole('button', { name: lang === 'en' ? /Development/ : /Разработка/ }).click();
  await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
  await expect(page.locator('.tv-labs .lchip').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/* Sizes are read without the canvas' zoom. Anything scrolled inside a plate or hidden in it is text a person cannot read. */
const readPlates = (page: Page) => page.locator('.tv-labs .lchip').evaluateAll((plates: HTMLElement[]) => plates.map(plate => {
  const parts = [...plate.querySelectorAll<HTMLElement>('*')].filter(el => !(el instanceof SVGElement));
  const font = (selector: string) => {
    const el = plate.querySelector(selector);
    return el && getComputedStyle(el).fontSize;
  };
  return {
    name: plate.querySelector('b')!.firstChild!.textContent!,
    trunk: plate.classList.contains('tk'),
    size: [plate.offsetWidth, plate.offsetHeight],
    fill: plate.offsetHeight - plate.querySelector<HTMLElement>('.in')!.offsetHeight,
    fonts: { name: font('b'), role: font('.tv-role'), task: font('.r2'), state: font('.ast') },
    clipped: [plate, ...parts].filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).map(el => el.className),
    hidden: parts.filter(el => getComputedStyle(el).display === 'none').map(el => el.className),
  };
}));

const inFrame = (frame: Frame, item: Frame) => item.x >= frame.x && item.y >= frame.y
  && item.x + item.width <= frame.x + frame.width && item.y + item.height <= frame.y + frame.height;

async function expectNoPlatesTouch(labs: Locator, count = 14) {
  const rects = await labs.locator('.lchip').evaluateAll(list => list.map(el => el.getBoundingClientRect()).map(r => ({ top: r.top, bottom: r.bottom })));
  expect.soft(rects.length).toBeGreaterThanOrEqual(count);
  const overlaps = rects.filter((r, i) => rects.some((other, j) => i !== j && r.top < other.bottom && other.top < r.bottom));
  expect.soft(overlaps).toEqual([]);
}

/* Every row's click area, and so every line drawn through its middle, stays on the middle of its plate. */
async function expectLinesFollowPlates(page: Page, full: Tree) {
  const rows = ['main', 'turn', ...new Set(full.tree.lines.map(l => l.agent.id))];
  for (const row of rows) {
    const plate = await box(page.locator(`.tv-labs .lchip[data-row="${row}"]`));
    const middles = await page.locator(`svg[role="group"] rect[data-row="${row}"]`).evaluateAll(list => list.map(el => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    }));
    expect.soft(middles.length, `${row} has a row`).toBeGreaterThan(0);
    for (const middle of middles) expect.soft(Math.abs(middle - (plate.y + plate.height / 2)), `${row}'s line goes through the middle of its plate`).toBeLessThanOrEqual(1);
  }
}

/* What the lines say at their ends stays inside its frame. */
async function expectBadgesHoldTheirText(page: Page) {
  const outside = await page.locator('svg[role="group"] .bdg').evaluateAll(badges => badges.filter(badge => {
    const frame = badge.querySelector('polygon')!.getBBox(), text = badge.querySelector<SVGGraphicsElement>('.bdg-t')!.getBBox();
    return text.x < frame.x || text.x + text.width > frame.x + frame.width;
  }).map(badge => badge.textContent));
  expect.soft(outside).toEqual([]);
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`plates of a full department keep their natural size in ${lang}, ${theme}, ${width}px`, async ({ page }, info) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        const full = fullDepartment();
        let shown: Tree = full;
        await serveTree(page, { during: true });
        await page.route('**/api/org', route => route.fulfill({ json: shown.org }));
        await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: shown.tree } }));

        await open(page, lang);
        await page.screenshot({ path: info.outputPath(`tree-${lang}-${theme}-${width}-open.png`) });
        const labs = page.locator('.tv-labs'), all = await readPlates(page), plates = all.filter(p => !p.trunk);
        expect(plates.length).toBeGreaterThanOrEqual(12);
        expect(full.tree.lines.length).toBeGreaterThanOrEqual(50);

        /* It opens at 100% from its root. */
        await expect.soft(page.locator('.dview .zv')).toHaveText('100%');
        const frame = await box(page.locator('.tv-scroll'));
        expect.soft(inFrame(frame, await box(labs.locator('.lchip.tk.main'))), 'the main branch is on the screen').toBe(true);
        expect.soft(inFrame(frame, await box(labs.locator('.lchip.tk.turn'))), 'the turn branch is on the screen').toBe(true);
        expect.soft(inFrame(frame, await box(page.locator('svg[role="group"] .via.k'))), 'the fork of the turn is on the screen').toBe(true);

        /* All of every plate can be read, in the usual type. */
        for (const plate of all) {
          expect.soft(plate.clipped, `nothing of ${plate.name}'s plate is cut`).toEqual([]);
          expect.soft(plate.hidden, `nothing of ${plate.name}'s plate is hidden`).toEqual([]);
          expect.soft(plate.fill, `${plate.name}'s plate is filled up to its frame`).toBe(2);
        }
        for (const plate of plates) {
          expect.soft(plate.fonts, `${plate.name}'s plate keeps its type`).toEqual({ ...FONTS, state: plate.name === 'Lena' ? null : FONTS.state });
          expect.soft(plate.size[0], `${plate.name}'s plate has its natural width`).toBe(PLATE.width);
          expect.soft(plate.size[1], `${plate.name}'s plate has its natural height at the least`).toBeGreaterThanOrEqual(PLATE.height);
        }
        const of = (name: string) => labs.locator('.lchip').filter({ has: page.locator('b', { hasText: new RegExp(`^${name}`) }) });
        await expect.soft(of('Hana')).toContainText(lang === 'en' ? 'Head of development' : 'Руководитель разработки');
        await expect.soft(of('Bruno')).toContainText(lang === 'en' ? 'Developer' : 'Разработчик');
        await expect.soft(of('Bruno')).toContainText('#120 Checkout step 120');
        await expect.soft(of('Bruno')).toContainText(lang === 'en' ? 'waits for Hana since' : 'ждет Hana с');
        await expect.soft(of('Mark')).toContainText(`#214 ${LONG_TITLE}`);
        await expect.soft(of('Oleg')).toContainText(LONG_ROLE);
        await expect.soft(of('Ostap')).toContainText(LONG_WAIT);
        await expect.soft(labs.locator('.lchip.tk.main')).toContainText(LONG_BRANCH);
        const size = (name: string) => plates.find(p => p.name === name)!.size;
        expect.soft(all.find(p => p.name === 'turn-4')!.size, 'the turn plate is its natural size').toEqual([PLATE.width, 40]);
        for (const name of ['Nora', 'Lena']) expect.soft(size(name), `${name}'s plate with short texts is exactly the natural size`).toEqual([PLATE.width, PLATE.height]);
        expect.soft(size('Mark')[1], 'a very long title wraps instead of being cut').toBeGreaterThan(PLATE.height);
        expect.soft(size(LONG_NAME)[1], 'a very long name wraps instead of being cut').toBeGreaterThan(PLATE.height);
        expect.soft(size('Ostap')[1], 'a very long state wraps instead of being cut').toBeGreaterThan(PLATE.height);

        await expectNoPlatesTouch(labs);
        await expectLinesFollowPlates(page, full);
        await expectBadgesHoldTheirText(page);
        expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page itself does not scroll sideways').toBe(true);

        /* A plate that grows later moves its lane and all below, as a new task's title does. */
        await of('Nora').locator('.tv-title').evaluate((title, text) => { title.textContent = text; }, ` ${LONG_TITLE}`);
        await expect.poll(async () => (await box(of('Oleg'))).y - (await box(of('Nora'))).y, { message: 'the lane below moved down', timeout: 30_000 }).toBeGreaterThan(96);
        await expectNoPlatesTouch(labs);
        await expectLinesFollowPlates(page, full);

        /* Keyboard focus brings a plate below the screen into view, as a move of the tree. */
        const below = of('Oleg');
        await below.focus();
        await expect.poll(async () => inFrame(frame, await box(below)), { message: 'the focused plate is on the screen', timeout: 30_000 }).toBe(true);
        await expect.poll(() => page.locator('.tv-scroll').evaluate(el => [el.scrollLeft, el.scrollTop]), { message: 'the tree moved, its frame did not stay scrolled', timeout: 30_000 }).toEqual([0, 0]);
        expect.soft(inFrame(frame, await box(below)), 'the focused plate stays on the screen after the move').toBe(true);

        /* Show everything still fits the whole tree on the screen. */
        await page.locator('.dview').getByRole('button', { name: lang === 'en' ? 'Show everything' : 'Показать все', exact: true }).click();
        expect.soft(inFrame(frame, await box(page.locator('.tv-in'))), 'the whole tree fits').toBe(true);
        await page.screenshot({ path: info.outputPath(`tree-${lang}-${theme}-${width}-whole.png`) });

        /* A plate is the same size however many others there are. */
        for (const name of ['Bruno', 'Mark']) {
          shown = aloneIn(full, name);
          await open(page, lang);
          const seen = await readPlates(page), alone = seen.find(p => !p.trunk);
          expect.soft(seen.find(p => p.name === 'main')!.size, 'the main plate with a short name is its natural size').toEqual([PLATE.width, 32]);
          expect.soft(alone!.name).toBe(name);
          expect.soft(alone!.size, `${name}'s plate is the size it is in the full department`).toEqual(plates.find(p => p.name === name)!.size);
          if (name === 'Bruno') await page.screenshot({ path: info.outputPath(`tree-${lang}-${theme}-${width}-alone.png`) });
        }
        expect(errors).toEqual([]);
      });
    }
  }
}

test("a young turn opens with its fork on a phone's screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const full = fullDepartment(), now = new Date(Date.parse(full.tree.turn!.startedAt) + 60_000).toISOString();
  await serveTree(page, { during: true });
  await page.route('**/api/org', route => route.fulfill({ json: { ...full.org, serverNow: now } }));
  await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: { ...full.tree, now } } }));
  await open(page, 'en');
  await expect(page.locator('.dview .zv')).toHaveText('100%');
  expect(inFrame(await box(page.locator('.tv-scroll')), await box(page.locator('svg[role="group"] .via.k'))), 'the fork of the turn is on the screen').toBe(true);
});

test('a department without a repository opens at 100% from its first plate', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const full = fullDepartment();
  await serveTree(page, { during: true });
  await page.route('**/api/org', route => route.fulfill({ json: full.org }));
  await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: { ...full.tree, repository: false } } }));
  await open(page, 'en');
  await expect(page.locator('.dview .zv')).toHaveText('100%');
  await expect(page.locator('.tv-labs .lchip.tk')).toHaveCount(0);
  const frame = await box(page.locator('.tv-scroll')), first = page.locator('.tv-labs .lchip').first();
  expect(inFrame(frame, await box(first)), 'the first plate is on the screen').toBe(true);
  expect((await readPlates(page)).find(p => p.name === 'Nora')!.size).toEqual([PLATE.width, PLATE.height]);
  await expectNoPlatesTouch(page.locator('.tv-labs'), 12);
});
