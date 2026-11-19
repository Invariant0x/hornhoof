import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { box } from './api';
import { fullDepartment, LONG_BRANCH, LONG_NAME, LONG_ROLE, LONG_TITLE, LONG_WAIT, type Tree } from './full-department';
import { serveTree } from './tree-api';

type Frame = { x: number; y: number; width: number; height: number };

const PLATE = { width: 240, height: 84 };
const FONTS = { name: '13.5px', task: '12px', state: '13px' };

/* The same turn as a department of this one agent would see it. */
function aloneIn({ tree, org }: Tree, name: string): Tree {
  const mine = (agent: { name: string }) => agent.name === name, department = org.departments[0]!;
  return {
    org: { ...org, departments: [{ ...department, employees: department.employees.filter(mine), repository: { ...department.repository!, branch: 'main' } }] },
    tree: { ...tree, lines: tree.lines.filter(l => mine(l.agent)), activity: tree.activity!.filter(a => mine(a.agent)),
      idle: tree.idle.filter(i => mine(i.agent)), waiting: tree.waiting!.filter(w => mine(w.agent)), time: tree.time.filter(t => mine(t.agent)) },
  };
}

async function open(page: Page, lang: 'en' | 'ru', info?: TestInfo, width?: number) {
  await page.goto('/');
  await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
  if (info) {
    const evidence = info.outputPath(`department-${lang}-${width}-map.png`);
    await page.screenshot({ path: evidence });
    await info.attach(`department-${lang}-${width}-map.png`, { path: evidence, contentType: 'image/png' });
  }
  await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
  await expect(page.locator('.tv-labs .dept-chip').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/* Sizes are read without the canvas' zoom. Every word stays: a plate is at least the chip's size and grows with its lines. */
const readPlates = (page: Page) => page.locator('.tv-labs .dept-chip, .tv-labs .lchip').evaluateAll((plates: HTMLElement[]) => plates.map(plate => {
  const parts = [...plate.querySelectorAll<HTMLElement>('*')].filter(el => !(el instanceof SVGElement));
  const font = (selector: string) => {
    const el = plate.querySelector(selector);
    return el && getComputedStyle(el).fontSize;
  };
  return {
    name: plate.querySelector('.mn, b')!.firstChild!.textContent!,
    trunk: plate.classList.contains('tk'),
    size: [plate.offsetWidth, plate.offsetHeight],
    fonts: { name: font('.mn, b'), task: font('.r2'), state: font('.r3') },
    clipped: [plate, ...parts].filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).map(el => el.className),
    /* The halo of a framed button shows its glow only while the card is busy or waits, and its ring only on keyboard focus:
       those two layers draw no part of the plate, so their display none hides nothing of it. Every other part is checked. */
    hidden: parts.filter(el => !el.matches('.halo > .halo-glow, .halo > .halo-ring') && getComputedStyle(el).display === 'none').map(el => el.className),
    rows: [...plate.querySelectorAll<HTMLElement>('.mn, .r2, .r3')].map(el => ({ className: el.className, whiteSpace: getComputedStyle(el).whiteSpace, textOverflow: getComputedStyle(el).textOverflow, overflow: getComputedStyle(el).overflow })),
    /* Whether any of its lines of words takes a second line: a run of words that wraps, or a part of a row that goes under
       the rest of it. */
    wrapped: (() => {
      const lines = (tops: number[]) => tops.sort((a, b) => a - b).filter((top, i, all) => !i || top - all[i - 1]! >= 8).length;
      const texts = document.createTreeWalker(plate, NodeFilter.SHOW_TEXT), words = document.createRange();
      for (let text = texts.nextNode(); text; text = texts.nextNode()) {
        words.selectNodeContents(text);
        if (lines([...words.getClientRects()].filter(r => r.width).map(r => r.top)) > 1) return true;
      }
      return [...plate.querySelectorAll<HTMLElement>('.r1, .hx')].some(row => lines([...row.children].map(part => part.getBoundingClientRect().top)) > 1);
    })(),
  };
}));

const inFrame = (frame: Frame, item: Frame) => item.x >= frame.x && item.y >= frame.y
  && item.x + item.width <= frame.x + frame.width && item.y + item.height <= frame.y + frame.height;

async function expectNoPlatesTouch(labs: Locator, count = 12) {
  const rects = await labs.locator('.dept-chip').evaluateAll(list => list.map(el => ({ row: el.dataset.row, ...el.getBoundingClientRect() })));
  expect.soft(rects.length).toBeGreaterThanOrEqual(count);
  const overlaps = rects.filter((r, i) => rects.some((other, j) => i !== j && r.top < other.bottom && other.top < r.bottom));
  expect.soft(overlaps).toEqual([]);
}

/* Every row's click area, and so every line drawn through its middle, stays on the middle of its plate. */
async function expectLinesFollowPlates(page: Page, full: Tree) {
  const rows = [...new Set(full.tree.lines.map(l => l.agent.id))];
  for (const row of rows) {
    const plate = await box(page.locator(`.tv-labs [data-row="${row}"]`));
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
      test(`plates of a full department show all their words in ${lang}, ${theme}, ${width}px`, async ({ page }, info) => {
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

        await open(page, lang, info, width);
        const treeEvidence = info.outputPath(`tree-${lang}-${theme}-${width}-open.png`);
        await page.screenshot({ path: treeEvidence });
        await info.attach(`tree-${lang}-${theme}-${width}-open.png`, { path: treeEvidence, contentType: 'image/png' });
        const labs = page.locator('.tv-labs'), all = await readPlates(page), plates = all.filter(p => !p.trunk);
        expect(plates.length).toBeGreaterThanOrEqual(12);
        expect(full.tree.lines.length).toBeGreaterThanOrEqual(50);

        /* It opens at 100% from its root. */
        await expect.soft(page.locator('.dview .zv')).toHaveText('100%');
        const frame = await box(page.locator('.tv-scroll'));
        expect.soft(inFrame(frame, await box(labs.locator('.lchip.tk.main'))), 'the main branch is on the screen').toBe(true);
        expect.soft(inFrame(frame, await box(labs.locator('.lchip.tk.turn'))), 'the turn branch is on the screen').toBe(true);
        expect.soft(inFrame(frame, await box(page.locator('svg[role="group"] .via.k'))), 'the fork of the turn is on the screen').toBe(true);

        /* Every agent uses the same chip, as wide as ever and at least as tall, with all of its words. */
        for (const plate of all) expect.soft(plate.hidden, `nothing of ${plate.name}'s plate is hidden`).toEqual([]);
        for (const plate of all) expect.soft(plate.clipped, `nothing of ${plate.name}'s plate is cut`).toEqual([]);
        for (const plate of plates) {
          expect.soft(plate.fonts, `${plate.name}'s plate keeps its type`).toEqual(FONTS);
          expect.soft(plate.size[0], `${plate.name}'s plate keeps its width`).toBe(PLATE.width);
          expect.soft(plate.size[1], `${plate.name}'s plate is at least the chip's height`).toBeGreaterThanOrEqual(PLATE.height);
          for (const row of plate.rows) {
            expect.soft(row.whiteSpace, `${plate.name}'s text wraps`).toBe('normal');
            expect.soft(row.textOverflow, `${plate.name}'s text ends in no ellipsis`).toBe('clip');
            expect.soft(row.overflow, `${plate.name}'s text is not cut`).toBe('visible');
          }
        }
        const of = (name: string) => labs.locator('.dept-chip').filter({ has: page.locator('.mn, b', { hasText: new RegExp(`^${name}`) }) });
        const card = async (name: string, text: string) => {
          await of(name).locator('.schip').evaluate(el => (el as HTMLElement).click());
          await expect(page.locator('.tv-card')).toContainText(text);
          await page.keyboard.press('Escape');
        };
        /* Task #120 is Vera's review since 0.17.0; Bruno's own task is #62. */
        await card('Bruno', '#62 Night checkout work');
        await card('Hana', lang === 'en' ? 'Head of development' : 'Руководитель разработки');
        await card('Bruno', lang === 'en' ? 'Developer' : 'Разработчик');
        await card('Bruno', lang === 'en' ? 'waits for Hana since' : 'ждет Hana с');
        await card('Mark', `#214 ${LONG_TITLE}`);
        await card('Oleg', LONG_ROLE);
        await card('Ostap', LONG_WAIT);
        await expect.soft(labs.locator('.lchip.tk.main')).toContainText(LONG_BRANCH);
        expect.soft(all.find(p => p.name === 'turn-4')!.size, 'the turn plate is its natural size').toEqual([PLATE.width, 40]);
        /* Words that fit their lines keep the chip's size; more lines make it taller, the long name's too. */
        for (const plate of plates) {
          if (plate.wrapped) expect.soft(plate.size[1], `${plate.name}'s plate grows with its lines`).toBeGreaterThan(PLATE.height);
          else expect.soft(plate.size, `${plate.name}'s plate is the chip's size`).toEqual([PLATE.width, PLATE.height]);
        }
        expect.soft(plates.find(p => p.name === LONG_NAME)!.wrapped, 'the long name takes more lines').toBe(true);

        await expectNoPlatesTouch(labs);
        await expectLinesFollowPlates(page, full);
        await expectBadgesHoldTheirText(page);
        expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page itself does not scroll sideways').toBe(true);

        /* A longer line makes only its own plate taller, and the rows under it move down by as much. */
        const short = await box(of('Nora')), gap = (await box(of('Oleg'))).y - short.y;
        await of('Nora').locator('.r2').evaluate((title, text) => { title.textContent = text; }, ` ${LONG_TITLE}`);
        await expect.poll(async () => (await box(of('Nora'))).height, { message: "Nora's plate grows with the long line", timeout: 10_000 }).toBeGreaterThan(short.height);
        const nora = await box(of('Nora'));
        await expect.poll(async () => Math.abs((await box(of('Oleg'))).y - nora.y - (gap - short.height + nora.height)), { message: 'the plates under it move down', timeout: 10_000 }).toBeLessThanOrEqual(1);
        await expectNoPlatesTouch(labs);
        await expectLinesFollowPlates(page, full);

        /* A plate below the screen can be focused and brought into view. */
        const below = of('Oleg');
        await below.focus();
        await below.evaluate(el => el.scrollIntoView({ block: 'center' }));
        await expect.poll(async () => inFrame(frame, await box(below)), { message: 'the focused plate is on the screen' }).toBe(true);
        await expect.poll(() => page.locator('.tv-scroll').evaluate(el => [el.scrollLeft, el.scrollTop]), { message: 'the tree moved, its frame did not stay scrolled' }).toEqual([0, 0]);
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
  const frame = await box(page.locator('.tv-scroll')), first = page.locator('.tv-labs .dept-chip').first();
  expect(inFrame(frame, await box(first)), 'the first plate is on the screen').toBe(true);
  expect((await readPlates(page)).find(p => p.name === 'Nora')!.size).toEqual([PLATE.width, PLATE.height]);
  await expectNoPlatesTouch(page.locator('.tv-labs'), 12);
});
