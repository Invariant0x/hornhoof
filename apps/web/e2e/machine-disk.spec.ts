import type { DiskReport } from '@hornhoof/protocol';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Language, Messages } from '../src/i18n';
import type { MachineLowCard, MachineView, SubView } from '../src/types';
import { ME, serveApi, serveOwnerKey } from './api';

/* A machine's disk on its card, Hornhoof's share of it by part, and the card of a machine short of disk space in the
   tracker's Failures (#1750): every word stays whole inside its frame and the page never scrolls sideways, at the width
   of a desk and of a phone, in English and Russian, left to right and right to left. All of it is made up. */
test.describe.configure({ timeout: 0 });

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const GIB = 1024 ** 3;
const HOST = 'studio-workstation.local';
const OWNER = { id: ME.person.id, name: 'Ivan Korol' };
const DISK: DiskReport = {
  total: 926 * GIB,
  free: 31.5 * GIB,
  threshold: 46.3 * GIB,
  docker: { total: 295 * GIB, free: 3.2 * GIB, threshold: 14.8 * GIB },
  parts: { images: 118.4 * GIB, containers: 6.1 * GIB, volumes: 141.7 * GIB, buildCache: 22.9 * GIB, workingCopies: 17.3 * GIB, recordings: 1.2 * GIB, checkTemp: 0.4 * GIB },
  low: { since: '2026-11-20T09:40:00.000Z' },
  cleaned: [
    { part: 'checkTemp', bytes: 12.6 * GIB, at: '2026-11-20T09:39:00.000Z' },
    { part: 'buildCache', bytes: 8.2 * GIB, at: '2026-11-20T09:39:00.000Z' },
    { part: 'containers', bytes: 2.4 * GIB, at: '2026-11-20T09:38:00.000Z' },
  ],
  kept: [
    { part: 'workingCopies', agent: '00000000-0000-4000-8000-0000000000a1', path: 'hornhoof-1750/apps/web', task: 1750, bytes: 6.8 * GIB, why: 'uncommitted' },
    { part: 'workingCopies', agent: '00000000-0000-4000-8000-0000000000b2', path: 'scratch/release-check-copy', task: null, bytes: 1.9 * GIB, why: 'unpushed' },
  ],
};
const MACHINE: MachineView = {
  id: 'm1', hostname: HOST, os: 'darwin', arch: 'arm64', owner: OWNER, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 10, load: 1, memFree: 10 * GIB, memTotal: 12 * GIB, jobs: 0, tests: 0, cpuModel: 'Apple M2 Pro', diskFree: DISK.free, diskTotal: DISK.total, disk: DISK },
  lendsTests: true, running: { agents: [], parts: [] },
};
const LOW: MachineLowCard = { id: 'm1', hostname: HOST, owner: OWNER, since: DISK.low!.since, disk: DISK, names: { '00000000-0000-4000-8000-0000000000a1': 'Theodora Vasilievna-Brightwater' } };
const SUBS: SubView[] = [];

async function messagesFor(language: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${language}.ts`) as Record<string, Messages>;
  return dictionary[language]!;
}

type Look = { language: Language; skin: 'cyberpunk' | 'light'; dir: 'ltr' | 'rtl'; width: number };

/* The app at a path, with the machine and its card in what the server says, in a language, a skin and a direction. */
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
  await page.route(only('/api/requests'), route => route.fulfill({ json: { requests: [], addressed: [], proposals: [], merges: [], machinesAway: [], machinesLow: [LOW], counts: { byPerson: {}, byAgent: {}, total: 0 } } }));
  await page.addInitScript(({ language, skin }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', skin); }, look);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.evaluate(direction => { document.documentElement.dir = direction; }, look.dir);
  return t;
}

/* The machine's card opened on Machines, and its part Disk by part. */
async function diskPart(page: Page, t: Messages): Promise<{ card: Locator; part: Locator }> {
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.machines, exact: true }).click();
  await page.getByRole('button', { name: t.tables.openCard(HOST), exact: true }).click();
  const card = page.getByRole('article', { name: HOST });
  const part = card.locator('section.part', { has: page.getByRole('heading', { name: t.machines.diskParts.title, exact: true }) });
  await expect(part.locator('.disk-parts li')).toHaveCount(Object.keys(DISK.parts).length);
  await page.evaluate(() => document.fonts.ready);
  return { card, part };
}

/* The low-space card among the tracker's Failures. */
async function lowCard(page: Page, t: Messages): Promise<Locator> {
  const card = page.getByRole('region', { name: t.tasks.machineLow(HOST, OWNER.name), exact: true });
  await expect(card.locator('p')).toHaveCount(7);
  await expect(card.locator('.ml-kept li')).toHaveCount(DISK.kept!.length);
  await page.evaluate(() => document.fonts.ready);
  return card;
}

/* What of a frame is cut or stands past it, read once: a box of words narrower than its words, and a piece standing past
   the frame's edges. */
const cutIn = (frame: Locator) => frame.evaluate(root => {
  const edge = root.getBoundingClientRect();
  const found: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('h3, h5, p, li, span, bdi, b, small')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const what = `"${(el.textContent ?? '').trim().slice(0, 60)}"`;
    if (getComputedStyle(el).display !== 'inline' && el.scrollWidth > el.clientWidth + 0.5) found.push(`${what} is cut: ${el.scrollWidth} for ${el.clientWidth}`);
    if (r.left < edge.left - 0.5 || r.right > edge.right + 0.5) found.push(`${what} stands past its frame`);
  }
  return found;
});
/* The sizes of the parts that run to a second line, read once. */
const wrappedSizes = (part: Locator) => part.locator('.dp-v').evaluateAll(els => els
  .filter(el => el.getBoundingClientRect().height >= parseFloat(getComputedStyle(el).fontSize) * 2)
  .map(el => el.textContent));
/* The sizes of the parts as the rows stand, in gigabytes. */
const sizesInOrder = (part: Locator) => part.locator('.dp-v').evaluateAll(els => els.map(el => Number((el.textContent ?? '').replace(/[^\d.,]/g, '').replace(',', '.'))));
/* How far Docker's own disk stands below the line before it, beyond the gap the other lines keep. */
const dockerApart = (part: Locator) => part.locator('.dp-docker').evaluate(el => {
  const before = el.previousElementSibling!;
  const gap = (a: Element, b: Element) => b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
  return gap(before, el) - gap(before.previousElementSibling!, before);
});
const scrollsSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

const FITS: Look[] = [
  { language: 'en', skin: 'cyberpunk', dir: 'ltr', width: 1440 },
  { language: 'ru', skin: 'cyberpunk', dir: 'rtl', width: 1440 },
  { language: 'en', skin: 'light', dir: 'rtl', width: 375 },
  { language: 'ru', skin: 'light', dir: 'ltr', width: 375 },
];
const named = (look: Look) => `${look.language} ${look.dir} at ${look.width}`;

for (const look of FITS) {
  test(`the disk by part on a machine's card keeps every word whole inside the card, ${named(look)}`, async ({ page }) => {
    const t = await open(page, look, '/');
    const { card, part } = await diskPart(page, t);
    expect(await cutIn(part)).toEqual([]);
    expect(await cutIn(card.locator('.card-h'))).toEqual([]);
    const placed = await part.evaluate((el, frame) => {
      const [a, b] = [el.getBoundingClientRect(), frame!.getBoundingClientRect()];
      return Math.max(0, b.left - a.left, a.right - b.right);
    }, await card.elementHandle());
    expect(placed, 'the part past the card').toBeLessThanOrEqual(0.5);
    expect(await scrollsSideways(page)).toBe(false);
    expect(await wrappedSizes(part), 'a size on more than one line').toEqual([]);
    expect(await sizesInOrder(part), 'the parts largest first').toEqual([...await sizesInOrder(part)].sort((a, b) => b - a));
    expect(await dockerApart(part), "Docker's own disk set apart from the lines above it").toBeGreaterThanOrEqual(12);
  });

  test(`the card of a machine short of disk space keeps every word whole inside it, ${named(look)}`, async ({ page }) => {
    const t = await open(page, look, '/tasks?show=failures&view=list');
    const card = await lowCard(page, t);
    expect(await cutIn(card)).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
  });
}

/* The pictures for Design, only when asked for: HH_DISK_SHOTS=1. They go to $HH_OUT where the run hands files back: English
   and Russian left to right and English right to left, in both skins, at a desk's width and a phone's. */
const shot = (info: TestInfo, name: string) => (process.env.HH_OUT ? `${process.env.HH_OUT}/${name}.png` : info.outputPath(`${name}.png`));
const WORDS = [{ language: 'en', dir: 'ltr' }, { language: 'ru', dir: 'ltr' }, { language: 'en', dir: 'rtl' }] as const;
for (const width of [1440, 375]) {
  for (const skin of ['cyberpunk', 'light'] as const) {
    for (const { language, dir } of WORDS) {
      const look: Look = { language, skin, dir, width };
      const name = `${language}-${dir}-${skin}-${width}`;
      test(`pictures of the disk and the low-space card, ${name}`, async ({ page }, info) => {
        test.skip(!process.env.HH_DISK_SHOTS, 'pictures only when asked for');
        const t = await open(page, look, '/');
        const { part } = await diskPart(page, t);
        await part.scrollIntoViewIfNeeded();
        await part.screenshot({ path: shot(info, `disk-${name}`), animations: 'disabled' });
        await page.goto('/tasks?show=failures&view=list', { waitUntil: 'domcontentloaded' });
        await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
        const card = await lowCard(page, t);
        await card.screenshot({ path: shot(info, `low-${name}`), animations: 'disabled' });
      });
    }
  }
}
