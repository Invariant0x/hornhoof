import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Org, PersonView } from '../src/types';
import { box, ME, serveApi } from './api';

/* Six departments, three people with the whole company on top, Dan beside Sales and four people who each look after several
   departments from the strip under them, as on Ivan's map. */
const NAMES = ['Sales', 'Development', 'Design', 'Finance', 'Support', 'Marketing'];
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const D = NAMES.map((_, i) => ID(i + 1));
const IVAN: PersonView = { id: ME.person.id, name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: { whole: true, departments: [], teams: [] } };
const whole = (id: string, name: string, title: string) => ({ ...IVAN, id, name, email: `${name.toLowerCase()}@acme.com`, title, isOwner: false });
const deputy = (n: number, name: string, ds: number[]) => ({
  ...whole(ID(20 + n), name, ''),
  deputy: true,
  departments: ds.map(i => D[i]!),
  access: { whole: false, departments: ds.map(i => ({ id: D[i]!, name: NAMES[i]! })), teams: [] },
});
const DAN = { ...whole(ID(30), 'Dan', ''), access: { whole: false, departments: [{ id: D[0]!, name: 'Sales' }], teams: [] } };
const NINA = ID(22);
const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 0, working: 0 },
  people: [IVAN, whole('p2', 'Maria', 'COO'), whole('p3', 'Alex', 'CFO'), deputy(1, 'Oleg', [0, 4]), deputy(2, 'Nina', [1, 2, 5]), deputy(3, 'Petr', [1, 3]), deputy(4, 'Lena', [0, 1])],
  departments: D.map((id, i) => ({
    id, name: NAMES[i]!, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: i ? [] : [DAN], employees: [], roles: [],
  })),
};

type At = { x: number; y: number };
/* Development taken down and Nina put on the right, as a person might arrange the map. */
const ARRANGED: Record<string, At> = { [`dept:${D[1]}`]: { x: 860, y: 980 }, [`person:${NINA}`]: { x: 1200, y: 600 } };

async function serveMap(page: Page, blocks: Record<string, At> = {}) {
  const kept = { blocks: { ...blocks } };
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.18.7', commit: 'map-roads' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.18.7', commit: 'map-roads' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
  await page.route('**/api/map/layout', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: kept });
    const body = route.request().postDataJSON() as { blocks: Record<string, At> } | null;
    if (body) Object.assign(kept.blocks, body.blocks);
    return route.fulfill(route.request().method() === 'DELETE' ? { status: 204 } : { json: kept });
  });
  return kept;
}

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await expect(page.locator('.dept')).toHaveCount(6);
  await expect(page.locator('.dept-chips li')).toHaveCount(5);
  return errors;
}

type Seg = { el: number; axis: 'h' | 'v'; at: number; lo: number; hi: number };

/* Every quiet line drawn on the map, cut into its runs across and down. */
async function drawnSegments(page: Page): Promise<Seg[]> {
  const ds = await page.locator('.wires path.tr:not(.live)').evaluateAll(paths => paths.map(p => p.getAttribute('d')!));
  return ds.flatMap((d, el) =>
    d.split('M ').filter(Boolean).flatMap(run => {
      const pts = run.trim().split(' L ').map(p => p.split(' ').map(Number) as [number, number]);
      return pts.slice(1).map(([x, y], i): Seg => {
        const [px, py] = pts[i]!;
        if (px !== x && py !== y) throw new Error(`a slanted line: ${d}`);
        return py === y ? { el, axis: 'h', at: y, lo: Math.min(px, x), hi: Math.max(px, x) } : { el, axis: 'v', at: x, lo: Math.min(py, y), hi: Math.max(py, y) };
      });
    }),
  );
}

/* Lines that run side by side closer than a road's width for at least as long, and stretches drawn more than once. */
async function sideBySide(page: Page) {
  const segs = await drawnSegments(page);
  const near: string[] = [], twice: string[] = [];
  segs.forEach((a, i) => segs.slice(i + 1).forEach(b => {
    const along = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
    if (a.axis !== b.axis || along <= 0.5) return;
    const gap = Math.abs(a.at - b.at), what = `${a.axis} ${a.at} [${a.lo}, ${a.hi}] and ${b.at} [${b.lo}, ${b.hi}]`;
    if (gap < 0.01) twice.push(what);
    else if (gap < 28 && along >= 28) near.push(what);
  }));
  return { near, twice };
}

const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });

test.describe('lines on the company map run as roads', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('lines side by side join into one road, as laid out, while a block moves and where it is put', async ({ page }, info) => {
    await serveMap(page);
    const errors = await open(page);
    await shot(page, info, 'roads-default');
    expect(await sideBySide(page)).toEqual({ near: [], twice: [] });

    /* The corner of a card is its grip: nothing is drawn there, only the pointer turns into a hand that moves it. */
    const grip = page.getByRole('button', { name: 'Move Development' });
    const card = await box(page.locator('.dept', { hasText: 'Development' })), g = await box(grip);
    expect(Math.abs(g.x + g.width / 2 - card.x)).toBeLessThan(1);
    expect(Math.abs(g.y + g.height / 2 - card.y)).toBeLessThan(1);
    expect(await grip.evaluate(e => [e.childElementCount, getComputedStyle(e).cursor, getComputedStyle(e).backgroundColor])).toEqual([0, 'move', 'rgba(0, 0, 0, 0)']);

    /* The lines join while the hand moves the block, before it lets go. */
    await page.mouse.move(card.x + 4, card.y + 4);
    await page.mouse.down();
    await page.mouse.move(card.x - 160, card.y + 520, { steps: 10 });
    expect(await grip.evaluate(e => getComputedStyle(e).cursor)).toBe('grabbing');
    await shot(page, info, 'roads-while-moving');
    expect(await sideBySide(page)).toEqual({ near: [], twice: [] });
    await page.mouse.up();
    expect(await sideBySide(page)).toEqual({ near: [], twice: [] });
    expect(errors).toEqual([]);
  });
});

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`map roads in ${lang} ${theme} ${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        await serveMap(page);
        const errors = await open(page);
        await shot(page, info, `roads-default-${lang}-${theme}-${width}`);
        expect(await sideBySide(page)).toEqual({ near: [], twice: [] });

        /* Pointing at a card's corner draws nothing over it. */
        const card = await box(page.locator('.dept').nth(1));
        await page.mouse.move(card.x + 2, card.y + 2);
        await page.screenshot({ path: info.outputPath(`roads-corner-${lang}-${theme}-${width}.png`), animations: 'disabled', clip: { x: Math.max(0, card.x - 40), y: Math.max(0, card.y - 40), width: 120, height: 90 } });

        await page.evaluate(blocks => fetch('/api/map/layout', { method: 'PATCH', body: JSON.stringify({ blocks }) }), ARRANGED);
        await page.reload();
        await expect(page.getByRole('button', { name: lang === 'en' ? 'Put back as it was' : 'Вернуть как было' })).toBeVisible();
        await shot(page, info, `roads-arranged-${lang}-${theme}-${width}`);
        expect(await sideBySide(page)).toEqual({ near: [], twice: [] });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }
}
