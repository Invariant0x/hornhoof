import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

import { LANGUAGES, type Language, type Messages } from '../../src/i18n';
import { BASE_ISO } from './clock';
import { serveMoonfern } from './serve';
import { prepareScenePage } from './stream';
import { MOONFERN_TASKS } from './tasks';

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
      words.preparing(1, ''), words.goalsDone(1, 1), words.closedReleases, words.released(1, ''), words.relCount(1), t.tracker.wait.question,
      t.tracker.groups.waitingYou, t.tracker.wait.person('', t.tracker.time.minutes(40)), t.tracker.time.minutes(49)];
  }
  const controls = [...Object.values(views), filters.group(), filters.executor, filters.responsible, filters.goal, ...Object.values(statuses)];
  return view === 'tasks'
    ? [...common, ...controls, filters.showSubtasks, list.task, list.executor, list.responsible, t.tracker.priority.label, list.goal, list.due, list.addTask]
    : [...common, ...controls, board.executor, board.responsible, board.subtasks(1, 1), board.empty, t.tracker.wait.question,
      t.tracker.groups.waitingYou, t.tracker.time.minutes(49), t.tracker.wait.failedRun('17', false)];
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
          await frame.clock.setFixedTime(new Date(BASE_ISO));
          const fixture = await serveMoonfern(frame);
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
            await expect(person.locator('.tr-card .tr-wait.person').first()).toHaveText(t.tracker.time.minutes(49));
            await expect(region.getByRole('region', { name: t.tracker.statuses.failure })).toHaveCount(0);
            await assertBoard(region, wide);
            await expectOneLine(region.locator('bdi').filter({ hasText: /^Sam Rivera$/ }).first());
          }
          if (view === 'turns') await assertTurnQuestion(region, t);
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
          await assertTrackerEdges(frame, size.width);
          await frame.screenshot({ path: info.outputPath(`${view}-${id}-${theme}-${size.width}.png`) });
          if (view === 'board') {
            const last = region.getByRole('region', { name: t.tracker.statuses.done, exact: true }).locator('.tr-card').last();
            await last.evaluate(card => card.scrollIntoView({ block: 'end', inline: 'nearest' }));
            await assertTrackerEdges(frame, size.width, last);
            await frame.screenshot({ path: info.outputPath(`board-bottom-${id}-${theme}-${size.width}.png`) });
            await frame.locator('.tracker-page').evaluate(element => { element.scrollTop = 0; });
          }
          if (view !== 'turns') {
            if (!wide) await frame.getByRole('button', { name: t.tracker.side.open }).click();
            await assertSelectedDepartment(sidebar);
            if (view === 'board') await expect(sidebar.getByRole('button', { name: `${t.tracker.side.failures} 0` })).toBeVisible();
            await assertTrackerFit(frame);
            if (!wide) await sidebar.getByRole('button', { name: t.tracker.side.close }).click();
          }
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

            fixture.setTasks(MOONFERN_TASKS.map(task => task.number === 224 ? {
              ...task, time: { ...task.time!, waitsOn: [{ kind: 'run', who: null, since: BASE_ISO, reason: '17', failure: 'run' }] },
            } : task));
            await frame.goto(paths.board);
            const failures = region.getByRole('region', { name: t.tracker.statuses.failure });
            const failed = failures.getByRole('article', { name: '#224 Sunlight meter calibration on iPhone' });
            await expect(failed).toBeVisible();
            await expect(failed.locator('.tr-wait.failure')).toHaveText(t.tracker.wait.failedRun('17', false));
            await assertBoard(region, wide);
            await assertTrackerFit(frame);
            if (!wide) await failures.scrollIntoViewIfNeeded();
            await frame.screenshot({ path: info.outputPath(`board-failure-${id}-${theme}-${size.width}.png`) });
          }
          reportUnmocked(watcher.errors);
        } finally {
          await context.close();
        }
      }
    }
  }
}

export async function assertTrackerEdges(page: Pick<Page, 'locator'>, width: number, last?: Locator): Promise<void> {
  const tracker = page.locator('.tracker-page');
  if (width <= 760) {
    const covering = await tracker.evaluate(body => {
      const area = body.getBoundingClientRect();
      return Array.from(document.body.querySelectorAll('*')).filter(element => {
        const style = getComputedStyle(element);
        if (style.position !== 'fixed' || style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return false;
        const box = element.getBoundingClientRect();
        return Math.max(box.left, area.left) < Math.min(box.right, area.right)
          && Math.max(box.top, area.top) < Math.min(box.bottom, area.bottom);
      }).map(element => element.id ? `#${element.id}` : element.getAttribute('class') || element.localName);
    });
    expect(covering, 'fixed elements overlapping the tracker').toEqual([]);
    return;
  }
  const version = page.locator('.version-mark');
  if (!last) {
    await expect(version).toBeVisible();
    return;
  }
  const [card, body, footer] = await Promise.all([last.boundingBox(), tracker.boundingBox(), version.boundingBox()]);
  expect(card!.y).toBeGreaterThanOrEqual(body!.y);
  expect(Math.abs(card!.y + card!.height - (body!.y + body!.height))).toBeLessThanOrEqual(1);
  expect(card!.y + card!.height).toBeLessThanOrEqual(footer!.y + 1);
}

async function expectOneLine(label: Locator): Promise<void> {
  await expect(label).toBeVisible();
  const lines = await label.evaluate(element => {
    const text = document.createRange();
    text.selectNodeContents(element);
    return new Set(Array.from(text.getClientRects(), rect => rect.top)).size;
  });
  expect(lines).toBe(1);
}

async function assertSelectedDepartment(sidebar: Locator): Promise<void> {
  const head = sidebar.locator('.tr-dept-head.on');
  await expect(head.getByRole('button', { name: 'Development', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(head.getByRole('button', { expanded: true })).toBeVisible();
  await expectOneLine(head.getByText('Development', { exact: true }));
  const pipeline = sidebar.getByText('Beta build way', { exact: true });
  await expect(pipeline).toHaveCSS('overflow-wrap', 'break-word');
  const widths = await head.evaluate(row => [row.getBoundingClientRect().width, row.parentElement!.getBoundingClientRect().width]);
  expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(1);
}

async function assertTurnQuestion(region: Locator, t: Messages): Promise<void> {
  const record = region.getByRole('listitem', { name: '#225 Import plants from CSV and Apple Notes' });
  const title = record.getByRole('button', { name: 'Import plants from CSV and Apple Notes' });
  const wait = record.locator('.tr-wait');
  const question = record.getByRole('button', { name: t.tracker.wait.question });
  await expect(wait).toHaveText(t.tracker.time.minutes(49));
  await expect(question).toBeVisible();
  const [label, duration, button] = await Promise.all([title.boundingBox(), wait.boundingBox(), question.boundingBox()]);
  const rtl = await region.evaluate(element => getComputedStyle(element).direction === 'rtl');
  const start = (box: NonNullable<typeof label>) => rtl ? box.x + box.width : box.x;
  expect(Math.abs(start(label!) - start(button!))).toBeLessThanOrEqual(1);
  expect(button!.y).toBeGreaterThanOrEqual(duration!.y + duration!.height - 1);
  const other = region.getByRole('listitem', { name: '#230 Onboarding plant card layout' });
  await expect(other.locator('.tr-wait')).toHaveText(t.tracker.wait.person('Leo Park', t.tracker.time.minutes(40)));
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
