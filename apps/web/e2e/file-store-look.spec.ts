/// <reference types="node" />
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Language, Messages } from '../src/i18n';
import type { FileStoreView } from '../src/screens/FileCopies';
import type { MachineView, SubView } from '../src/types';
import { ME, serveApi, serveOwnerKey } from './api';

/* The company's files on the machines (#2021, #2053, #2056): the part of a machine's card with the room it gives them,
   what they take there and what its disk has free, its room picked from a list; and the card in Company settings with
   the copies of each file and the store's own backup. Every word stays whole inside its frame, the page never scrolls
   sideways, and the list shows its focus ring when reached by keyboard, at the width of a desk and of a phone, in
   English and Russian, left to right and right to left. All of it is made up. */
test.describe.configure({ timeout: 0 });

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const GIB = 1024 ** 3;
const HOST = 'studio-workstation-with-a-long-name.local';
const OWNER = { id: ME.person.id, name: 'Ivan Korol' };
const MACHINE: MachineView = {
  id: 'm1', hostname: HOST, os: 'darwin', arch: 'arm64', owner: OWNER, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 10, load: 1, memFree: 10 * GIB, memTotal: 12 * GIB, jobs: 0, tests: 0, cpuModel: 'Apple M2 Pro', diskFree: 182.4 * GIB, diskTotal: 926 * GIB },
  lendsTests: true, running: { agents: [], parts: [] },
  fileStore: { id: 'm1', limitBytes: null, areaBytes: 10 * GIB, usedBytes: 3.4 * GIB, diskFree: 182.4 * GIB },
};
const STORE: FileStoreView = {
  copies: 2, effectiveCopies: 2, machines: 3, filesBytes: 7.8 * GIB, usedBytes: 15.6 * GIB, capacityBytes: 30 * GIB, underCopied: 12, stuckBytes: 1.6 * GIB,
  backup: { machineId: 'm3', apart: true, away: true, files: 4812, bytes: 8.3 * GIB, waiting: 37, keptAt: '2026-11-24T21:14:00.000Z', oldestAt: '2026-10-26T08:02:00.000Z', keepDays: 30 },
};
const SUBS: SubView[] = [];

async function messagesFor(language: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${language}.ts`) as Record<string, Messages>;
  return dictionary[language]!;
}

type Look = { language: Language; skin: 'cyberpunk' | 'light'; dir: 'ltr' | 'rtl'; width: number };

/* The app at a path, with the machine and the store in what the server says, in a language, a skin and a direction. */
async function open(page: Page, look: Look, path: string): Promise<Messages> {
  const t = await messagesFor(look.language);
  await page.setViewportSize({ width: look.width, height: look.width < 600 ? 2400 : 1400 });
  await page.clock.install({ time: NOW });
  await serveApi(page);
  await serveOwnerKey(page);
  const only = (pathname: string) => (url: URL) => url.pathname === pathname;
  await page.route(only('/api/subscriptions'), route => route.fulfill({ json: { subscriptions: SUBS } }));
  await page.route(only('/api/machines'), route => route.fulfill({ json: { machines: [MACHINE], builtin: null, priority: false, move: null, canMove: false, copies: null } }));
  await page.route(only('/api/nodes/commands'), route => route.fulfill({ json: { commands: [] } }));
  await page.route(only('/api/machines/access'), route => route.fulfill({ json: { views: [] } }));
  await page.route(only('/api/company/file-store'), route => route.fulfill({ json: STORE }));
  await page.addInitScript(({ language, skin }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', skin); }, look);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.evaluate(direction => { document.documentElement.dir = direction; }, look.dir);
  return t;
}

/* The machine's card opened on Machines, and its part with the company's files. */
async function filesPart(page: Page, t: Messages): Promise<{ card: Locator; part: Locator; room: Locator }> {
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.machines, exact: true }).click();
  await page.getByRole('button', { name: t.tables.openCard(HOST), exact: true }).click();
  const card = page.getByRole('article', { name: HOST });
  const part = card.getByRole('region', { name: t.machines.filesArea, exact: true });
  const room = part.getByRole('combobox', { name: t.machines.filesAreaLabel(HOST), exact: true });
  await expect(room).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { card, part, room };
}

/* The store's card in Company settings, with its backup. */
async function storeCard(page: Page, t: Messages): Promise<Locator> {
  const card = page.getByRole('region', { name: t.fileCopies.title, exact: true });
  await expect(card.getByRole('heading', { name: t.fileCopies.backupTitle, exact: true })).toBeVisible();
  await expect(card.locator('p.update-note')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  return card;
}

/* What of a frame is cut or stands past it, read once: a box of words narrower than its words, and a piece standing past
   the frame's edges. */
const cutIn = (frame: Locator) => frame.evaluate(root => {
  const edge = root.getBoundingClientRect();
  const found: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('h3, h4, h5, p, li, span, bdi, b, small, label, select')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const what = `"${(el.textContent ?? '').trim().slice(0, 60)}"`;
    if (getComputedStyle(el).display !== 'inline' && el.tagName !== 'SELECT' && el.scrollWidth > el.clientWidth + 0.5) found.push(`${what} is cut: ${el.scrollWidth} for ${el.clientWidth}`);
    if (r.left < edge.left - 0.5 || r.right > edge.right + 0.5) found.push(`${what} stands past its frame`);
  }
  return found;
});
const scrollsSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
/* The list reached by keyboard: back out of it and into it again, so the browser shows its ring as it would to Tab. */
async function reachByKeyboard(page: Page, list: Locator): Promise<void> {
  await list.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(list).toBeFocused();
}
const ringed = (list: Locator) => list.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) > 0);

const FITS: Look[] = [
  { language: 'en', skin: 'cyberpunk', dir: 'ltr', width: 1440 },
  { language: 'ru', skin: 'cyberpunk', dir: 'rtl', width: 1440 },
  { language: 'en', skin: 'light', dir: 'rtl', width: 375 },
  { language: 'ru', skin: 'light', dir: 'ltr', width: 375 },
];
const named = (look: Look) => `${look.language} ${look.dir} at ${look.width}`;

for (const look of FITS) {
  test(`the company's files on a machine's card keep every word whole inside the card, and its room shows its ring, ${named(look)}`, async ({ page }) => {
    const t = await open(page, look, '/');
    const { card, part, room } = await filesPart(page, t);
    expect(await cutIn(part)).toEqual([]);
    const placed = await part.evaluate((el, frame) => {
      const [a, b] = [el.getBoundingClientRect(), frame!.getBoundingClientRect()];
      return Math.max(0, b.left - a.left, a.right - b.right);
    }, await card.elementHandle());
    expect(placed, 'the part past the card').toBeLessThanOrEqual(0.5);
    expect(await scrollsSideways(page)).toBe(false);
    await reachByKeyboard(page, room);
    expect(await ringed(room), 'the focus ring on the room').toBe(true);
  });

  test(`the store's card in Company settings keeps every word whole inside it, and its lists show their ring, ${named(look)}`, async ({ page }) => {
    const t = await open(page, look, '/settings/company');
    const card = await storeCard(page, t);
    expect(await cutIn(card)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
    const days = card.getByRole('combobox', { name: t.fileCopies.backupDays, exact: true });
    await reachByKeyboard(page, days);
    expect(await ringed(days), 'the focus ring on the days').toBe(true);
  });
}

/* The pictures for Design, only when asked for: HH_FILE_SHOTS=1. They go to $HH_OUT where the run hands files back:
   English and Russian left to right and English right to left, in both skins, at a desk's width and a phone's, and the
   room's list with its focus ring. */
const shot = (info: TestInfo, name: string) => (process.env.HH_OUT ? `${process.env.HH_OUT}/${name}.png` : info.outputPath(`${name}.png`));
const WORDS = [{ language: 'en', dir: 'ltr' }, { language: 'ru', dir: 'ltr' }, { language: 'en', dir: 'rtl' }] as const;
for (const width of [1440, 375]) {
  for (const skin of ['cyberpunk', 'light'] as const) {
    for (const { language, dir } of WORDS) {
      const look: Look = { language, skin, dir, width };
      const name = `${language}-${dir}-${skin}-${width}`;
      test(`pictures of the company's files on a machine and in Company settings, ${name}`, async ({ page }, info) => {
        test.skip(!process.env.HH_FILE_SHOTS, 'pictures only when asked for');
        const t = await open(page, look, '/');
        const { part, room } = await filesPart(page, t);
        await part.scrollIntoViewIfNeeded();
        await part.screenshot({ path: shot(info, `files-area-${name}`), animations: 'disabled' });
        await reachByKeyboard(page, room);
        await part.screenshot({ path: shot(info, `files-area-focus-${name}`), animations: 'disabled' });
        await page.goto('/settings/company', { waitUntil: 'domcontentloaded' });
        await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
        const card = await storeCard(page, t);
        await card.scrollIntoViewIfNeeded();
        await card.screenshot({ path: shot(info, `file-store-${name}`), animations: 'disabled' });
      });
    }
  }
}
