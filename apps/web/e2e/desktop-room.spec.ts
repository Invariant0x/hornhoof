import { expect, test, type Page } from '@playwright/test';
import type { Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { Department, DeptRole, Employee, Org, TaskLine } from '../src/types';
import { detail, ME, serveApi } from './api';
import { captureWith } from './capture';
import { DEV, serveTasksBoard, TASKS } from './tasks-board/api';

/* Nothing of a page sits under the top bar or under the open card (#1556, Design's amendment of mockup 10). The department's
   schema opens and fits with its column headers, cards and chips clear of the bar and the department's name, which keep a
   band of their own; what is dragged up goes out of sight at that band. On a wide screen the tracker's work ends where the
   card starts, its titles wrapped whole beside it, and the row whose card opens or closes stays in sight; on a phone the
   card is the whole screen under the top bar. Pseudo-locale text makes every word longer and adds one too long for a line;
   it is test data, not a language the app ships. Shots go to HH_SCREENSHOT_DIR when it is set. */

const capture = captureWith('desktop-room', process.env.HH_SCREENSHOT_DIR);
const MESSAGES = { en, ru } as const;
const skin = (scheme: 'light' | 'dark') => BUILTIN_SKINS.find(s => s.scheme === scheme)!.id;

type Look = { lang: 'en' | 'ru'; scheme: 'light' | 'dark'; text: 'plain' | 'pseudo'; dir: 'ltr' | 'rtl' };
type Size = { width: number; height: number };
const named = (look: Look) => `${look.lang} ${look.scheme} ${look.text} ${look.dir}`;

const ACCENTED: Record<string, string> = Object.fromEntries(
  [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [c, [...'åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ'][i]!]),
);
/* Half as long again, in letters a font draws wider, with a word no narrow line holds. */
export const pseudo = (text: string): string => {
  const letters = [...text].map(c => ACCENTED[c] ?? c).join('');
  return `[${letters} ${'ļöñĝéŕ '.repeat(Math.ceil(text.length / 14))}Ŵöŕðšţöößîĝƒöŕåñýļîñéåţåļļ]`;
};
const words = (look: Look, text: string) => (look.text === 'pseudo' ? pseudo(text) : text);

type Box = { x: number; y: number; width: number; height: number };
const whole = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
const meets = (a: Box, b: Box) => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
  && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/* The part of a box its canvas shows. */
const shown = (b: Box, frame: Box): Box => {
  const x = Math.max(b.x, frame.x), y = Math.max(b.y, frame.y);
  return { x, y, width: Math.max(0, Math.min(b.x + b.width, frame.x + frame.width) - x), height: Math.max(0, Math.min(b.y + b.height, frame.y + frame.height) - y) };
};

async function open(page: Page, look: Look, size: Size, path: string) {
  await page.setViewportSize(size);
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang: look.lang, theme: skin(look.scheme) });
  await page.goto(path);
}

/* Two frames in a row with the same boxes: the page has stopped moving. */
async function still(page: Page, selector: string) {
  const boxes = () => page.evaluate(async s => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return JSON.stringify([...document.querySelectorAll(s)].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; }));
  }, selector);
  let before = await boxes();
  for (let now = await boxes(); now !== before; now = await boxes()) before = now;
}

/* ---- The department's schema ---- */

const role = (id: string, title: { en: string; ru: string }, gate: number | null = null, schema?: DeptRole['schema']): DeptRole => ({
  id, title, description: { en: `${title.en}: what this role does.`, ru: `${title.ru}: что делает эта роль.` },
  kind: id === 'DEV-HEAD' ? 'head' : 'member', gate, ...(schema ? { schema } : {}),
});
const employee = (id: string, name: string, roleId: string, kind: Employee['kind'] = 'worker'): Employee => ({
  id, name, roleId, title: null, kind, model: '', modelName: null, provider: 'claude', state: 'sleeping', status: 'idle', on: true,
  effort: null, timer: null, task: null, context: null, program: null, alarm: null, retry: null, failure: null,
});

/* A development department with deep frames: four developers and three reviewers stand one under another. */
function schemaOrg(look: Look): Org {
  const both = (en: string, ru: string) => ({ en: words(look, en), ru: words(look, ru) });
  const roles = [
    role('DEV-HEAD', both('Head of development', 'Глава разработки')), role('DEV-ARCH', both('Architect', 'Архитектор'), null, 'before_work'),
    role('DEV-ENG', both('Developer', 'Разработчик')), role('DEV-REV', both('Code reviewer', 'Ревьюер кода'), 1),
    role('DEV-SEC', both('Security engineer', 'Инженер по безопасности'), 2), role('DEV-TEST', both('Test engineer', 'Инженер по тестированию'), null, 'final_check'),
  ];
  const staff: [string, string, string][] = [
    ['head', 'Hana', 'DEV-HEAD'], ['ada', 'Ada', 'DEV-ARCH'], ['bruno', 'Bruno', 'DEV-ENG'], ['dina', 'Dina', 'DEV-ENG'], ['egor', 'Egor', 'DEV-ENG'],
    ['fern', 'Fern', 'DEV-ENG'], ['rita', 'Rita', 'DEV-REV'], ['roma', 'Roma', 'DEV-REV'], ['rosa', 'Rosa', 'DEV-REV'], ['sam', 'Sam', 'DEV-SEC'], ['tom', 'Tom', 'DEV-TEST'],
  ];
  const employees = staff.map(([id, name, roleId]) => employee(id, words(look, name), roleId, roleId === 'DEV-HEAD' ? 'head' : 'worker'));
  const department: Department = {
    id: 'd2', name: look.text === 'pseudo' ? pseudo('Development of the shop') : null, templateKey: 'development', roleCode: 'DEV', about: '',
    agents: { total: employees.length, working: 0 }, products: [], teams: [], people: [], employees, roles, workLines: [], reworkAt: null,
  };
  return { company: ME.company, orchestrator: null, agents: department.agents, people: [], serverNow: '2026-11-05T12:00:00.000Z', departments: [department] };
}

async function serveSchema(page: Page, org: Org) {
  await serveApi(page);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    return path === '/api/org' ? route.fulfill({ json: org }) : route.fallback();
  });
}

const PARTS = '.dview .world :is(.frame .fh, .schip, .shead, .pchip)';

/* The boxes of the schema's column headers, cards and chips, of its canvas, and of the top bar and the department's name. */
const schemaBoxes = (page: Page) => page.evaluate(parts => {
  const box = (e: Element | null) => { const r = e!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return {
    bars: [box(document.querySelector('header.topbar')), box(document.querySelector('.dview .crumbs'))],
    canvas: box(document.querySelector('.dview .dcanvas')),
    parts: [...document.querySelectorAll(parts)].map(e => ({ name: (e.textContent ?? '').trim().slice(0, 40), header: e.classList.contains('fh'), box: box(e) })),
  };
}, PARTS);

/* As the schema opens or fits: no header, card or chip meets the top bar or the department's name, and every column header the
   canvas shows across is whole inside it, from top to bottom. */
async function clearOnSight(page: Page, when: string) {
  await still(page, PARTS);
  const { bars, canvas, parts } = await schemaBoxes(page);
  expect(parts.filter(p => p.header).length, `${when}: the column headers`).toBe(5);
  expect(parts.filter(p => bars.some(bar => meets(whole(p.box), whole(bar)))).map(p => p.name), `${when}: parts under the top bar`).toEqual([]);
  const c = whole(canvas);
  const cut = parts.filter(p => p.header && meets({ ...whole(p.box), y: c.y, height: c.height }, c))
    .filter(p => Math.round(p.box.y) < c.y || Math.round(p.box.y + p.box.height) > c.y + c.height);
  expect(cut.map(p => p.name), `${when}: headers cut by the edge of the canvas`).toEqual([]);
}

/* After the person pulled or zoomed it: what of the schema still shows meets neither the top bar nor the department's name. */
async function clearOfBar(page: Page, when: string) {
  await still(page, PARTS);
  const { bars, canvas, parts } = await schemaBoxes(page);
  expect(parts.filter(p => bars.some(bar => meets(whole(shown(p.box, canvas)), whole(bar)))).map(p => p.name), `${when}: parts under the top bar`).toEqual([]);
}

/* A pull of the schema by its bare background: a press where no card is, moved by `by`. WebKit selects words under a pull
   and then drags the selection, so none is left before it. */
async function pull(page: Page, by: { x: number; y: number }) {
  await page.evaluate(() => getSelection()?.removeAllRanges());
  const start = await page.evaluate(by => {
    const r = document.querySelector('.dview .dcanvas')!.getBoundingClientRect();
    const bare = (x: number, y: number) => ['dcanvas', 'world'].some(name => document.elementFromPoint(x, y)?.classList.contains(name));
    const [left, right] = [r.x + 16 + Math.max(0, -by.x), r.right - 16 - Math.max(0, by.x)];
    const [top, bottom] = [r.y + 16 + Math.max(0, -by.y), r.bottom - 16 - Math.max(0, by.y)];
    for (let y = bottom; y >= top; y -= 10) for (let x = left; x <= right; x += 10) if (bare(x, y)) return { x, y };
    return null;
  }, by);
  if (!start) throw new Error('the schema shows no bare background to pull it by');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + by.x, start.y + by.y, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => getSelection()?.removeAllRanges());
}

const SCHEMA_LOOKS: Look[] = [
  { lang: 'en', scheme: 'light', text: 'plain', dir: 'ltr' },
  { lang: 'ru', scheme: 'dark', text: 'plain', dir: 'ltr' },
  { lang: 'en', scheme: 'light', text: 'pseudo', dir: 'ltr' },
];
for (const size of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const look of SCHEMA_LOOKS) {
    const t: Messages = MESSAGES[look.lang];
    test(`keeps the schema's headers, cards and chips out from under the top bar: ${named(look)} ${size.width}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await serveSchema(page, schemaOrg(look));
      await open(page, look, size, '/departments/d2');
      await expect(page.getByRole('region', { name: t.dept.schema, exact: true }).locator('.frame .fh')).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);
      await clearOnSight(page, 'on opening');
      await capture(page, info, `schema-${look.lang}-${look.scheme}-${look.text}-${size.width}-${info.project.name}`);

      const zoom = page.locator('.dview .zoom');
      await zoom.getByRole('button', { name: t.map.showAll, exact: true }).click({ force: true });
      await clearOnSight(page, 'after Show everything');

      /* The moves of the release recording: pulled up and left, zoomed in twice, pulled left and a little down. */
      await pull(page, { x: -200, y: -200 });
      for (let i = 0; i < 2; i++) await zoom.getByRole('button', { name: t.map.zoomIn, exact: true }).click({ force: true });
      await pull(page, { x: -250, y: 60 });
      await clearOfBar(page, 'after the moves of a recording');

      /* Fit again, then pulled up until the first column's header reaches the middle of the top bar. */
      await zoom.getByRole('button', { name: t.map.showAll, exact: true }).click({ force: true });
      await clearOnSight(page, 'after Show everything again');
      const [header, bar] = [(await page.locator('.dview .frame .fh').first().boundingBox())!, (await page.locator('header.topbar').boundingBox())!];
      await pull(page, { x: 0, y: Math.round(bar.y + bar.height / 2 - header.y) });
      await clearOfBar(page, 'pulled up to the top bar');
      expect(errors).toEqual([]);
    });
  }
}

/* ---- The tracker and the open card ---- */

/* The board's 138 tasks and one more of Development with a title as long as real ones get. */
const LONG: TaskLine = { ...TASKS.find(x => x.title === 'Take card payments')!, id: 't900', number: 900, parentId: null,
  title: 'Move the checkout to the new payment provider and keep every old receipt readable in both languages for years to come' };
const boardTasks = (look: Look): TaskLine[] => [LONG, ...TASKS].map(x => ({ ...x, title: words(look, x.title) }));

async function serveBoard(page: Page, tasks: TaskLine[]) {
  await serveTasksBoard(page);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/tasks') return route.fulfill({ json: { tasks } });
    const shown = tasks.find(x => path === `/api/tasks/${x.id}`);
    if (shown) return route.fulfill({ json: { task: { ...detail(shown), neededFor: [], mayEdit: true, version: 1 } } });
    return route.fallback();
  });
}

/* Every title of the list, in sight or further down: its box, whether it shows all its words, and the words it breaks across
   lines although the word alone fits its line. */
const titles = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tr-list .tr-title')].flatMap(e => {
  const r = e.getBoundingClientRect();
  if (!r.width) return [];
  const text = e.firstChild;
  const split: string[] = [];
  if (text?.nodeType === Node.TEXT_NODE) {
    const probe = e.appendChild(document.createElement('span'));
    probe.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap;';
    for (const m of (text.textContent ?? '').matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(text, m.index);
      range.setEnd(text, m.index + m[0].length);
      const lines = new Set([...range.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.bottom))).size;
      probe.textContent = m[0];
      if (lines > 1 && probe.getBoundingClientRect().width <= e.clientWidth) split.push(m[0]);
    }
    probe.remove();
  }
  return [{ name: (e.textContent ?? '').slice(0, 40), box: { x: r.x, y: r.y, width: r.width, height: r.height }, cut: e.scrollWidth > e.clientWidth, overflow: getComputedStyle(e).textOverflow, split }];
}));

/* A row a little below the middle of the screen, once the page is scrolled to the middle of the list. */
async function rowMidway(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('main.body')!;
    body.scrollTop = (body.scrollHeight - body.clientHeight) / 2;
    const rows = [...document.querySelectorAll<HTMLElement>('.tr-list li.tr-row')];
    const row = rows.find(x => x.getBoundingClientRect().top > innerHeight * 0.55 && x.getBoundingClientRect().bottom < innerHeight - 8) ?? rows[0]!;
    return row.getAttribute('aria-label')!;
  });
}
/* Where the row's own line stands in the page's sight, and how far the page is scrolled. */
const rowSight = (page: Page, name: string) => page.getByRole('listitem', { name, exact: true }).evaluate(e => {
  const line = e.querySelector(':scope > .tr-cells')!.getBoundingClientRect();
  const body = e.closest('.body')!, view = body.getBoundingClientRect();
  return { top: line.top - view.top - body.clientTop, bottom: line.bottom - view.top - body.clientTop, height: body.clientHeight, scroll: body.scrollTop };
});
type Sight = Awaited<ReturnType<typeof rowSight>>;
/* The row is whole in sight, and the page moved only if it had to, as far as brings the row to its edge. */
function inSight(now: Sight, before: Sight, what: string) {
  expect(Math.round(now.top), `${what}: the row's top in sight`).toBeGreaterThanOrEqual(0);
  expect(Math.round(now.bottom), `${what}: the row's bottom in sight`).toBeLessThanOrEqual(now.height);
  if (Math.round(now.scroll) !== Math.round(before.scroll)) expect(Math.min(Math.abs(now.top), Math.abs(now.bottom - now.height)), `${what}: scrolled further than needed`).toBeLessThanOrEqual(1);
}

const CARD_LOOKS: Look[] = [
  { lang: 'en', scheme: 'light', text: 'plain', dir: 'ltr' },
  { lang: 'ru', scheme: 'dark', text: 'plain', dir: 'ltr' },
  { lang: 'en', scheme: 'light', text: 'pseudo', dir: 'ltr' },
  { lang: 'en', scheme: 'dark', text: 'pseudo', dir: 'rtl' },
];
for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  for (const look of CARD_LOOKS) {
    const t: Messages = MESSAGES[look.lang];
    test(`ends the work where the open card starts and wraps every title whole beside it: ${named(look)} ${size.width}`, async ({ page }, info) => {
      const tasks = boardTasks(look);
      await serveBoard(page, tasks);
      await open(page, look, size, `/tasks?department=${DEV.id}`);
      await expect(page.locator('h1.tr-where')).toBeVisible();
      await page.evaluate(d => { document.documentElement.dir = d; }, look.dir);
      const list = page.getByRole('region', { name: t.tracker.views.list, exact: true });
      await expect(list.getByRole('listitem', { name: `#900 ${tasks[0]!.title}`, exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      /* The row whose card opens stays in sight while the work narrows. */
      const name = await rowMidway(page);
      const before = await rowSight(page, name);
      await list.getByRole('listitem', { name, exact: true }).locator(':scope > .tr-cells .tr-title').click({ force: true });
      const card = page.locator('.acard.at-end');
      await expect(card.getByRole('heading', { name: name.replace(/^#\d+ /, ''), exact: true })).toBeVisible();
      await still(page, '.tr-list .tr-title, .acard.at-end');
      inSight(await rowSight(page, name), before, 'opened');
      await capture(page, info, `card-${look.lang}-${look.scheme}-${look.text}-${look.dir}-${size.width}-${info.project.name}`);

      /* The card at the end side, 460 px from under the top bar to the bottom; the page ends exactly where it starts, and the
         main area and the list end no further. */
      const edges = await page.evaluate(() => {
        const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return { card: box('.acard.at-end'), page: box('main.body'), main: box('.tr-main'), list: box('.tr-list') };
      });
      const ltr = look.dir === 'ltr';
      expect(Math.round(edges.card.width)).toBe(460);
      expect(Math.round(edges.card.top)).toBe(68);
      expect(Math.round(edges.card.bottom)).toBe(size.height);
      expect(Math.round(ltr ? edges.card.right : edges.card.left)).toBe(ltr ? size.width : 0);
      expect(Math.round(ltr ? edges.page.right : edges.page.left), 'the page ends where the card starts').toBe(Math.round(ltr ? edges.card.left : edges.card.right));
      for (const area of [edges.main, edges.list]) {
        const overlap = ltr ? area.right - edges.card.left : edges.card.right - area.left;
        expect(Math.max(0, Math.round(overlap)), 'the work under the card').toBe(0);
      }

      const seen = await titles(page);
      expect(seen.length).toBeGreaterThan(20);
      const panel = whole(edges.card);
      /* The card runs from under the top bar to the bottom, so a title further down is under it wherever it is under its sides. */
      expect(seen.filter(x => meets({ ...whole(x.box), y: panel.y, height: panel.height }, panel)).map(x => x.name), 'titles under the card').toEqual([]);
      expect(seen.filter(x => x.cut || x.overflow === 'ellipsis').map(x => x.name), 'titles cut short').toEqual([]);
      expect(seen.flatMap(x => x.split), 'words broken across lines').toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      /* Closed, the card gives the width back and the row stays in sight. */
      const opened = await rowSight(page, name);
      await card.getByRole('button', { name: t.window.close, exact: true }).click({ force: true });
      await expect(card).toHaveCount(0);
      await still(page, '.tr-list .tr-title');
      inSight(await rowSight(page, name), opened, 'closed');
      expect(Math.round((await page.locator('.tr-main').boundingBox())!.width)).toBeGreaterThan(Math.round(edges.main.width));
    });
  }
}

test('lays the card over the whole screen under the top bar on a phone: en light 375', async ({ page }, info) => {
  const look: Look = { lang: 'en', scheme: 'light', text: 'plain', dir: 'ltr' };
  const tasks = boardTasks(look);
  await serveBoard(page, tasks);
  await open(page, look, { width: 375, height: 812 }, `/tasks?department=${DEV.id}`);
  const list = page.getByRole('region', { name: en.tracker.views.list, exact: true });
  await list.getByRole('listitem', { name: `#900 ${tasks[0]!.title}`, exact: true }).locator(':scope > .tr-cells .tr-title').click({ force: true });
  const card = page.locator('.acard.at-end');
  await expect(card.getByRole('heading', { name: tasks[0]!.title, exact: true })).toBeVisible();
  await still(page, '.acard.at-end');
  expect(whole((await card.boundingBox())!)).toEqual({ x: 0, y: 68, width: 375, height: 812 - 68 });
  await capture(page, info, `card-phone-375-${info.project.name}`);
});
