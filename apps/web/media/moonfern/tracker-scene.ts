import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

import { LANGUAGES, type Language, type Messages } from '../../src/i18n';
import { serveMoonfern } from './serve';
import { prepareScenePage } from './stream';

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/* Picks a view of the tracker as a person does: List, Board or Graph in the View group. */
export async function pickView(page: Page, name: 'List' | 'Board' | 'Graph'): Promise<void> {
  await page.locator('.tr-views label').filter({ hasText: new RegExp(`^${name}$`) }).click();
  await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
}

/* Smoothly scrolls the nearest scrolling box around a locator so it stands near the top of that box. */
export async function smoothScrollTo(page: Page, target: Locator, offset = 24, steps = 14, stepMs = 40): Promise<void> {
  const handle = await target.elementHandle();
  if (!handle) return;
  const plan = await handle.evaluate((el, off) => {
    let box: HTMLElement | null = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    const scroller = box ?? (document.scrollingElement as HTMLElement);
    const from = scroller.scrollTop;
    const to = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, from + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - off));
    (window as unknown as { __hhScroller?: HTMLElement }).__hhScroller = scroller;
    return { from, to };
  }, offset);
  for (let i = 1; i <= steps; i++) {
    const top = Math.round(plan.from + (plan.to - plan.from) * easeInOut(i / steps));
    await page.evaluate(y => {
      const s = (window as unknown as { __hhScroller?: HTMLElement }).__hhScroller;
      if (s) s.scrollTop = y;
    }, top);
    await page.waitForTimeout(stepMs);
  }
}

/* Says which /api calls the scene left unanswered, without failing the render: the frames show whether it matters. */
export function reportUnmocked(errors: string[]): void {
  if (errors.length) console.log(`[media] unanswered or failed while recording:\n${errors.join('\n')}`);
}

const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const THEMES = ['cyberpunk', 'light'] as const;

/* Count the translated parts shown in each tracker view. A blank argument removes fixture data from a phrase. */
function trackerWords(t: Messages, view: 'tasks' | 'board' | 'turns'): string[] {
  const { side, where, views, filters, statuses, list, board } = t.tracker;
  const common = [...Object.values(side).filter((word): word is string => typeof word === 'string'), t.tracker.viewAs, t.tracker.viewAsSelf(''), t.tasks.search];
  if (view === 'turns') {
    const words = t.tasks.board;
    return [...common, where.turns, t.tasks.department, words.show, words.showReleases, words.showOutside, words.relsWhy, words.nextWhy,
      words.preparing(1, ''), words.goalsDone(1, 1), words.closedReleases, words.released(1, ''), words.relCount(1), t.tracker.wait.question];
  }
  const controls = [...Object.values(views), filters.group(), filters.executor, filters.responsible, filters.goal, ...Object.values(statuses)];
  return view === 'tasks'
    ? [...common, ...controls, filters.showSubtasks, list.task, list.executor, list.responsible, t.tracker.priority.label, list.goal, list.due, list.addTask]
    : [...common, ...controls, board.executor(''), board.responsible(''), board.subtasks(1, 1), board.empty, t.tracker.wait.question];
}

const RTL = new Set(['ar', 'fa', 'he', 'ur']);
async function frameLanguages(view: 'tasks' | 'board' | 'turns'): Promise<{ id: Language; t: Messages }[]> {
  const ranked = await Promise.all(LANGUAGES.map(async ({ id }) => {
    const dictionary = await import(`../../src/i18n/${id}.ts`) as Record<Language, Messages>;
    const t = dictionary[id];
    return { id, t, length: trackerWords(t, view).join('').length };
  }));
  ranked.sort((a, b) => a.length - b.length);
  const picked = [ranked[0]!, ranked.at(-1)!, ranked.find(({ id }) => RTL.has(id))];
  return [...new Map(picked.flatMap(item => item ? [[item.id, item] as const] : [])).values()];
}

/* Real geometry checks run alongside the still pictures in each browser engine. */
export async function trackerFrames(browser: Browser, info: TestInfo, view: 'tasks' | 'board' | 'turns'): Promise<void> {
  const paths = { tasks: '/tasks?department=dept-dev', board: '/tasks?department=dept-dev&view=board', turns: '/tasks?show=turns' };
  for (const { id, t } of await frameLanguages(view)) {
    for (const theme of THEMES) {
      for (const size of SIZES) {
        const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: size, timezoneId: 'UTC' });
        try {
          const frame = await context.newPage();
          const watcher = await prepareScenePage(frame, undefined, id, theme);
          await serveMoonfern(frame);
          await frame.goto(paths[view]);
          const region = frame.getByRole('region', { name: view === 'turns' ? t.tracker.side.turns : t.tracker.views[view === 'board' ? 'board' : 'list'], exact: true });
          await expect(region).toBeVisible();
          await expect(region.locator(view === 'board' ? '.tr-card' : view === 'turns' ? '.goal-row' : '.tr-row').first()).toBeVisible();
          await expect(frame.locator('html')).toHaveAttribute('lang', id);
          await expect(frame.locator('html')).toHaveAttribute('data-theme', theme);
          await frame.evaluate(() => document.fonts.ready);
          const wide = size.width === 1440;
          if (view === 'board') {
            const person = region.getByRole('region', { name: t.tracker.statuses.waits });
            await expect(person.locator('.tr-card .tr-wait.person').first()).toBeVisible();
            await assertBoard(region, wide);
          }
          const sidebar = frame.getByRole('navigation', { name: t.tracker.side.label });
          if (wide) {
            const box = (await sidebar.boundingBox())!;
            const body = (await frame.locator('.tracker-page').boundingBox())!;
            const nav = (await frame.locator('.topbar').boundingBox())!;
            expect(Math.abs(box.x - body.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(box.y - (nav.y + nav.height))).toBeLessThanOrEqual(1);
            expect(Math.abs(box.y + box.height - (body.y + body.height))).toBeLessThanOrEqual(1);
            const top = await frame.locator('.tr-top :is(.tr-where, .tr-view-as, .tr-search)').evaluateAll(items =>
              items.map(item => { const box = item.getBoundingClientRect(); return box.top + box.height / 2; }));
            expect(Math.max(...top) - Math.min(...top)).toBeLessThanOrEqual(1);
          }
          await assertTrackerFit(frame);
          await frame.screenshot({ path: info.outputPath(`${view}-${id}-${theme}-${size.width}.png`) });
          if (view === 'board') {
            if (!wide) {
              await region.getByRole('region', { name: t.tracker.statuses.waits }).locator('.tr-card').first().scrollIntoViewIfNeeded();
              await frame.screenshot({ path: info.outputPath(`board-person-${id}-${theme}-${size.width}.png`) });
            }
            await frame.goto('/tasks?department=dept-dev&pipeline=pl-beta&view=board');
            await expect(region.locator('.tr-col').nth(1)).toBeVisible();
            await expect(region.getByRole('region', { name: 'TestFlight smoke test' })).toBeVisible();
            await assertBoard(region, wide);
            await assertTrackerFit(frame);
            await frame.screenshot({ path: info.outputPath(`pipeline-${id}-${theme}-${size.width}.png`) });
          }
          reportUnmocked(watcher.errors);
        } finally {
          await context.close();
        }
      }
    }
  }
}

async function assertBoard(board: Locator, wide: boolean): Promise<void> {
  await expect(board.locator('.tr-columns')).toHaveAttribute('data-layout', wide ? 'row' : 'stack');
  const columns = await board.locator('.tr-col').evaluateAll(nodes => nodes.map(node => {
    const { x, y, bottom } = node.getBoundingClientRect();
    const heading = node.querySelector('h2')!;
    return { x, y, bottom, start: getComputedStyle(heading).justifyContent };
  }));
  expect(columns.length).toBeGreaterThan(1);
  expect(columns.every(column => column.start === 'flex-start')).toBe(true);
  for (const [index, column] of columns.slice(1).entries()) {
    const previous = columns[index]!;
    if (wide) expect(Math.abs(column.y - previous.y)).toBeLessThanOrEqual(1);
    else {
      expect(column.y).toBeGreaterThanOrEqual(previous.bottom);
      expect(Math.abs(column.x - previous.x)).toBeLessThanOrEqual(1);
    }
  }
}

async function assertTrackerFit(page: Page): Promise<void> {
  const failures = await page.locator('.tracker-page, .tr-side, .tr-main, .tr-top, .tr-row-line, .tr-card, .goal-row, .entry-actions').evaluateAll(nodes =>
    nodes.filter(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1).map(node => node.className));
  expect(failures).toEqual([]);
}
