import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { BackupsView, UpdatesView } from '../src/types';
import { serveApi } from './api';

/* The English words of a bar of the shell over the map, in a page that reads right to left: the line read in the page's
   direction, and its closing full stop stood at the start of the line, at the far left. Each bar's words take their
   direction from what they say, so an English line reads left to right with its full stop at its end, and the bar itself
   stays mirrored: its words at the right, its buttons after them. A page that reads left to right does not change. */
const WIDTHS = [1440, 375];
const DIRS = ['rtl', 'ltr'] as const;
const HEIGHT = 850;
/* Where the screenshots go: the folder a run collects, else beside this test's results. */
const SHOTS = process.env.HH_OUT ? join(process.env.HH_OUT, 'banner-direction') : fileURLToPath(new URL('results/banner-direction-shots', import.meta.url));

const CURRENT = { version: '0.39.1', commit: 'a276aa6c' + 'c'.repeat(32), migrations: 156 };
/* A build with no title of its own: its bar says only that it is out, and ends with a full stop. */
const NEWER = { tag: 'v0.39.2', version: '0.39.2', commit: 'b'.repeat(40), created: '2026-11-19T20:00:00.000Z', title: '', migrations: 156 };
const quiet = (): UpdatesView => ({ current: CURRENT, available: false, checkedAt: '2026-11-19T20:00:00.000Z', latest: null, versions: [], error: null, updater: { present: true, status: null, waiting: null, calledOff: null } });
const BROKEN = { status: 500, json: { error: { code: 'internal', message: 'Something went wrong.' } } };

/* Each bar as the server makes it show, the element that is the bar, and what shows it: the map itself, or a department
   opened while the company's reload fails. */
const BARS: { name: string; bar: string; serve: (page: Page) => Promise<void>; show: (page: Page) => Promise<void> }[] = [
  {
    name: 'the update that ended', bar: 'main.body > .update-banner',
    serve: async page => { await page.route('**/api/updates', route => route.fulfill({ json: { ...quiet(), updater: { present: true, status: { id: 'u39', version: '0.39.1', commit: CURRENT.commit, state: 'done', step: 'finished', log: '', at: '2026-11-19T19:00:00.000Z' }, waiting: null, calledOff: null } } satisfies UpdatesView })); },
    show: async () => {},
  },
  {
    name: 'a newer build', bar: 'main.body > .update-banner',
    serve: async page => { await page.route('**/api/updates', route => route.fulfill({ json: { ...quiet(), available: true, latest: NEWER, versions: [NEWER] } satisfies UpdatesView })); },
    show: async () => {},
  },
  {
    name: 'the recovery file', bar: 'main.body > .update-banner',
    serve: async page => { await page.route('**/api/backups/recovery', route => route.fulfill({ json: { recoveryNeeded: true, linkChanged: false } satisfies Pick<BackupsView, 'recoveryNeeded' | 'linkChanged'> })); },
    show: async () => {},
  },
  {
    name: "the company's failed reload", bar: 'main.body > .alert',
    serve: async page => {
      let failing = false;
      await page.route('**/api/org', route => (failing ? route.fulfill(BROKEN) : route.fallback()));
      await page.exposeFunction('hhFailReload', () => { failing = true; });
    },
    show: async page => {
      await page.evaluate(() => (window as unknown as { hhFailReload: () => Promise<void> }).hhFailReload());
      await page.locator('.dept', { hasText: 'Development' }).click();
    },
  },
];

/* What the bar's words look like: the box of its last character and of the one before it, the element that holds the
   words and whether it is the bar itself, the direction each reads in, and the edge the words start from. */
const words = (page: Page, bar: string) => page.locator(bar).first().evaluate((box: HTMLElement) => {
  const texts: Text[] = [];
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.trim()) texts.push(n as Text);
  const node = texts[0]!;
  const text = node.textContent!.replace(/\s+$/, '');
  const at = (i: number) => {
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const holder = node.parentElement!;
  const style = getComputedStyle(box);
  const outer = box.getBoundingClientRect();
  const inner = holder.getBoundingClientRect();
  const rtlBar = style.direction === 'rtl';
  const contentStart = rtlBar ? outer.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) : outer.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  return {
    text,
    last: at(text.length - 1),
    before: at(text.length - 2),
    reads: getComputedStyle(holder).direction,
    barReads: style.direction,
    own: holder === box,
    start: rtlBar ? inner.right : inner.left,
    contentStart,
  };
});

function shot(png: Buffer, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), png);
  console.log(`SHOT ${name}.png sha256=${createHash('sha256').update(png).digest('hex')}`);
}

for (const width of WIDTHS) for (const dir of DIRS) for (const bar of BARS) {
  test(`the English words of ${bar.name} end with their full stop, ${width}px ${dir}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', 'cyberpunk');
    });
    await serveApi(page);
    await bar.serve(page);
    await page.goto('/');
    await expect(page.locator('.dept', { hasText: 'Development' })).toBeVisible();
    if (dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await bar.show(page);
    await expect(page.locator(bar.bar).first()).toBeVisible();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    shot(await page.screenshot({ animations: 'disabled' }), `${info.project.name}-${width}-${dir}-${bar.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`);

    const seen = await words(page, bar.bar);
    expect(seen.text, 'the bar says an English line that ends with a full stop').toMatch(/^[A-Z].*\.$/);
    expect(seen.barReads, `the bar itself stays ${dir}`).toBe(dir);
    const same = Math.abs(seen.last.top - seen.before.top) < 2;
    expect(same, 'the full stop stands on the line of the character before it').toBe(true);
    /* Middles, not edges: an engine may draw two neighbouring characters a pixel into each other. */
    const middle = (r: { left: number; right: number }) => (r.left + r.right) / 2;
    expect(middle(seen.last), `the full stop of "${seen.text}" stands after "${seen.text.at(-2)}", at the end of the line, not at ${seen.last.left} left of ${seen.before.left}`).toBeGreaterThan(middle(seen.before));
    expect(seen.reads, 'the English words read left to right').toBe('ltr');
    /* The bar stays mirrored: its words start at its start edge, the right in rtl and the left in ltr. */
    if (!seen.own) expect(Math.abs(seen.start - seen.contentStart), `the words start at the bar's ${dir === 'rtl' ? 'right' : 'left'} edge ${seen.contentStart}, not ${seen.start}`).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}
