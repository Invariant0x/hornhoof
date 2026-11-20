import { expect, type Page } from '@playwright/test';
import type { Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { BackupsView, UpdatesView } from '../src/types';
import { serveApi } from './api';

/* The looks of Design's #1635 on the map and an open department (#1639): the widths, the languages and directions, the bars
   that stand over them, and how a test opens one and waits until nothing moves. map-overlay.spec.ts checks them and
   map-overlay.shots.ts takes Design's pictures of them. */

export const HEIGHT = 812;
export const WIDTHS = [1440, 375];
export type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; skin: string };
/* Design pairs English with left to right and Russian with right to left, in Cyberpunk and in Light. */
export const LOOKS: Look[] = [{ lang: 'en', dir: 'ltr', skin: 'cyberpunk' }, { lang: 'ru', dir: 'rtl', skin: 'light' }];
export const MESSAGES: Record<Look['lang'], Messages> = { en, ru };
export const named = (look: Look) => `${look.lang} ${look.dir} ${look.skin}`;

const CURRENT = { version: '0.39.3', commit: 'a'.repeat(40), migrations: 156 };
const quiet = (): UpdatesView => ({ current: CURRENT, available: false, checkedAt: '2026-11-20T10:00:00.000Z', latest: null, versions: [], error: null, updater: { present: true, status: null, waiting: null, calledOff: null } });
const DONE = { id: 'u39', version: '0.39.3', commit: CURRENT.commit, state: 'done', step: 'finished', log: '', at: '2026-11-20T09:00:00.000Z' } as const;
/* An update that waits for the agents of the nodes to finish their turns (#1594). */
const WAITING = { version: '0.39.4', commit: 'd'.repeat(40), since: '2026-11-20T10:00:00.000Z', until: '2026-11-20T10:30:00.000Z', turns: [{ agent: 'Ada', task: 12 }], lost: [] };
const updates = (page: Page, updater: Partial<UpdatesView['updater']>) =>
  page.route('**/api/updates', route => route.fulfill({ json: { ...quiet(), updater: { ...quiet().updater, ...updater } } satisfies UpdatesView }));
const recovery = (page: Page) =>
  page.route('**/api/backups/recovery', route => route.fulfill({ json: { recoveryNeeded: true, linkChanged: false } satisfies Pick<BackupsView, 'recoveryNeeded' | 'linkChanged'> }));

/* The bars Design looks at: none, the update's, the wait for the nodes' agents, and two at once. The update's bar shows one
   note at a time, so the second of two is the recovery file's. */
export const BARS: { name: string; count: number; serve: (page: Page) => Promise<unknown> }[] = [
  { name: 'no bar', count: 0, serve: async () => {} },
  { name: 'the update bar', count: 1, serve: page => updates(page, { status: DONE }) },
  { name: 'the node wait bar', count: 1, serve: page => updates(page, { waiting: WAITING }) },
  { name: 'two bars', count: 2, serve: async page => { await updates(page, { waiting: WAITING }); await recovery(page); } },
];
export const VIEWS = ['map', 'department'] as const;
export type View = (typeof VIEWS)[number];

export const SHELL_BARS = 'main.body > :is(.update-banner, .alert, .guard-stop)';
export const CANVAS: Record<View, string> = { map: '.map:not([inert])', department: '.dview .dcanvas' };
/* What the map and an open department show, which no block may cover as they open. */
export const CONTENT: Record<View, string> = {
  map: '.map:not([inert]) .world :is(.dept, .hub, .chip)',
  department: '.dview .world :is(.shead, .schip, .pchip, .llab, .fh)',
};
/* The blocks at the top, the bars of the shell among them, and those along the bottom. */
export const TOP_BLOCKS = `.topbar > *, ${SHELL_BARS}`;
export const BOTTOM_BLOCKS = '.map > :is(.zoom, .ticker, .map-arrange), .dview :is(.zoom, .ticker, .dv-acts)';

/* Where each view opens, and what shows once it has. */
const START: Record<View, { path: string; shown: string }> = {
  map: { path: '/', shown: '.map .dept' },
  department: { path: '/departments/d2', shown: '.dview .shead' },
};

/* A page that reads right to left. */
async function mirror(page: Page, dir: Look['dir']) {
  if (dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
}

export async function open(page: Page, look: Look, width: number, bars: (typeof BARS)[number], view: View) {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, look);
  await serveApi(page);
  await bars.serve(page);
  await page.goto(START[view].path);
  await expect(page.locator(START[view].shown).first()).toBeVisible();
  await expect(page.locator(SHELL_BARS)).toHaveCount(bars.count);
  await mirror(page, look.dir);
  await page.evaluate(async () => { await document.fonts.ready; });
  await still(page);
}

/* Two frames in a row with the same boxes: nothing moves any more. */
export async function still(page: Page) {
  let last = '';
  await expect.poll(async () => {
    const now = await page.evaluate(async () => {
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      return JSON.stringify([...document.querySelectorAll('.world, .crumbs, main.body > *, .shead, .hub')].map(e => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x * 2), Math.round(r.y * 2), Math.round(r.width * 2), Math.round(r.height * 2)];
      }));
    });
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
}
