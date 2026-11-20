import { expect, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, LANGUAGES, type Language, type Messages } from '../src/i18n';
import { SALES, serveTasksBoard, TASKS } from './tasks-board/api';

/* What the browser checks of the tracker's empty sections (#1638, Design #1633) share with the pictures made for Design. */

export const RING_DELAY_MS = 400;
export const RING_MIN_MS = 500;
export const SLOW_MS = 10_000;
export const FAIL_MS = 30_000;
const T0 = Date.parse('2026-11-20T08:00:00Z');

/* The words of the tracker's empty blocks, which make a language the longest or the shortest of those it ships. */
const emptyWords = (t: Messages) => [...Object.values(t.tracker.empty), ...Object.values(t.tracker.emptyHint)].join(' ');
const byLength = [...LANGUAGES].map(l => l.id).sort((a, b) => emptyWords(DICTIONARIES[a]).length - emptyWords(DICTIONARIES[b]).length);
export const SHORTEST: Language = byLength[0]!;
export const LONGEST: Language = byLength[byLength.length - 1]!;

export type Look = { lang: Language; width: number; theme?: string; dir?: 'rtl' };

/* The company's work outside the sections looked at: a task of Sales that Maria answers for, so Mine, Development, Working
   and the rest hold nothing while the company is not empty. */
export const ELSEWHERE = TASKS.filter(task => task.department?.id === SALES.id);
export const NO_DECISIONS = { requests: [], proposals: [], machineAccess: [], counts: { byPerson: {}, byAgent: {}, total: 0 } };

const pathOf = (url: URL | string) => new URL(url.toString()).pathname;

/* An answer the test holds back until it lets it go; until then the page waits for it. again: the next ask waits too. */
export type Held = { asked(): number; release(): void; again(): void };

/* A path whose answer waits for the test, then comes as answered, or as the board's mock answers it. */
async function holdBack(page: Page, at: string, json: unknown): Promise<Held> {
  let asked = 0;
  let open: () => void = () => {};
  let gate = new Promise<void>(go => { open = go; });
  await page.route(url => pathOf(url) === at, async route => {
    asked++;
    await gate;
    if (json === undefined) return route.fallback().catch(() => {});
    return route.fulfill({ json }).catch(() => {});
  });
  return { asked: () => asked, release: () => open(), again: () => { gate = new Promise<void>(go => { open = go; }); } };
}

/* The tracker in a look, on the test's clock, paused: it moves only as far as a test moves it. answers: what the server
   answers instead of the board's mock, by path; held: the paths whose answers wait for the test. */
export async function openTracker(page: Page, path: string, look: Look, answers: Record<string, unknown>, held: string[] = []): Promise<Record<string, Held>> {
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0 + 1000);
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, theme, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { lang: look.lang, theme: look.theme ?? 'cyberpunk', dir: look.dir ?? 'ltr' });
  await serveTasksBoard(page);
  for (const [at, json] of Object.entries(answers)) if (!held.includes(at)) await page.route(url => pathOf(url) === at, route => route.fulfill({ json }));
  const holds: Record<string, Held> = {};
  for (const at of held) holds[at] = await holdBack(page, at, answers[at]);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  for (const at of held) await expect.poll(holds[at]!.asked).toBeGreaterThan(0);
  return holds;
}

export const boxesOf = (blocks: Locator[]) => Promise.all(blocks.map(async b => (await b.boundingBox())!));

/* Each box within half a pixel of the other. */
export function expectSameBoxes(after: { x: number; y: number; width: number; height: number }[], before: typeof after) {
  expect(after).toHaveLength(before.length);
  after.forEach((box, i) => {
    for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(box[side] - before[i]![side])).toBeLessThanOrEqual(0.5);
  });
}

/* The empty block a room shows: never one of its layers that is not shown. */
export const shownEmpty = (scope: Locator | Page) => scope.locator('.room-layer:not(.off) > .empty-state, .tr-releases .empty-state');
