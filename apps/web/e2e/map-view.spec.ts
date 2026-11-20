import { expect, test, type Page } from '@playwright/test';
import type { Org, PersonView } from '../src/types';
import { box, ME, serveApi } from './api';

/* Two departments whose agents start work while the person looks at the map. */
const SALES = '00000000-0000-4000-8000-000000000001', DEV = '00000000-0000-4000-8000-000000000002';
const IVAN: PersonView = { id: ME.person.id, name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: { whole: true, departments: [], teams: [] } };
const org = (working: number): Org => ({
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 4, working },
  people: [IVAN],
  departments: [SALES, DEV].map((id, i) => ({ id, name: ['Sales', 'Development'][i]!, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 2, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] })),
});

const view = (page: Page) => page.locator('.map .world').evaluate((e: HTMLElement) => e.style.transform);
const scale = async (page: Page) => Number(/scale\(([^)]+)\)/.exec(await view(page))![1]);
const settled = (page: Page) => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

test.describe('the view of the company map', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('opens with the arrangement in place, and stays where the person zoomed and moved it while the company changes live and the window resizes, and after a reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    let working = 0, streams = 0;
    let goLive = () => {};
    const live = new Promise<void>(done => (goLive = done));
    await serveApi(page);
    await page.route('**/api/org', route => route.fulfill({ json: org(working) }));
    await page.route('**/api/version', route => route.fulfill({ json: { version: '0.18.8', commit: 'map-view' } }));
    await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.18.8', commit: 'map-view' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
    /* The arrangement this person keeps on the server. The map is drawn only once it came (#1620), so no block moves to it. */
    await page.route('**/api/map/layout', route => route.fulfill({ json: { blocks: { [`dept:${DEV}`]: { x: 900, y: 900 } } } }));
    /* The first stream brings the news that three agents started work, once the person has moved the view; the next stays
       open with nothing to say. */
    await page.route('**/api/stream', async route => {
      if (streams++) return;
      await live;
      working = 3;
      const news = [1, 2, 3].map(n => `data: ${JSON.stringify({ type: 'working', working: n })}\n\n`).join('');
      return route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\n${news}` });
    });
    await page.goto('/');
    await expect(page.locator('.dept')).toHaveCount(2);
    /* Development stands where the arrangement keeps it from the first frame the map is drawn. */
    const development = page.locator('.dept', { hasText: 'Development' });
    expect(await development.evaluate((e: HTMLElement) => [e.style.left, e.style.top])).toEqual(['900px', '900px']);
    /* The map shows all of itself as it first opens. */
    await expect.poll(() => view(page)).not.toBe('translate(0px, 0px) scale(1)');
    const first = await scale(page);

    /* The person zooms in over Sales with the wheel and drags the map by an empty spot. */
    const sales = await box(page.locator('.dept', { hasText: 'Sales' }));
    await page.mouse.move(sales.x + sales.width / 2, sales.y + sales.height / 2);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => scale(page)).toBeGreaterThan(first * 1.5);
    const spot = await page.evaluate(() => {
      for (let y = 300; y < 900; y += 40) {
        for (let x = 200; x < 1300; x += 40) {
          const el = document.elementFromPoint(x, y);
          if (el?.closest('.map') && !el.closest('.dept, .hub, .chips li, button, .zoom, .ticker, a, input')) return { x, y };
        }
      }
      throw new Error('no empty spot on the map');
    });
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.down();
    await page.mouse.move(spot.x + 120, spot.y + 60, { steps: 6 });
    await page.mouse.up();
    const mine = await view(page);
    const zoom = await page.locator('.zoom .zv').textContent();
    expect(mine).not.toBe('translate(0px, 0px) scale(1)');

    /* Agents start work, and the map takes the company again; the view stays. */
    goLive();
    await expect(page.locator('.hub-num')).toHaveText('3/4');
    await settled(page);
    expect(await view(page)).toBe(mine);
    /* The window gets narrower; the view stays. */
    await page.setViewportSize({ width: 1200, height: 900 });
    await settled(page);
    expect(await view(page)).toBe(mine);

    /* After a reload the map opens where the person left it, at the same zoom. */
    await page.reload();
    await expect(page.locator('.dept')).toHaveCount(2);
    await expect.poll(() => development.evaluate((e: HTMLElement) => e.style.left)).toBe('900px');
    await settled(page);
    expect(await view(page)).toBe(mine);
    await expect(page.locator('.zoom .zv')).toHaveText(zoom!);
    expect(errors).toEqual([]);
  });
});
