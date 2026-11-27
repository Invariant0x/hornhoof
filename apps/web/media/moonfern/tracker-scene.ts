import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

import type { Messages } from '../../src/i18n';
import { BASE_ISO, isoMinutes } from './clock';
import { FRAME_SIZES, FRAME_THEMES, frameLanguages } from './frame-languages';
import { MOONFERN_PIPELINE } from './pipelines';
import { expectBetaBoard } from './scene-locators';
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

const LIST_PARENT = 'Plant identification camera flow with an indoor lighting guide, a preview that explains what the camera found, and care tips for the three plants that look most like the photo';
const LIST_NOTE = 'Check the camera preview with the new lighting guide before it goes to the beta testers.';

const listTasks = MOONFERN_TASKS.map(task => task.number === 221 ? {
  ...task, title: LIST_PARENT, priority: 'urgent' as const, externalWait: {
    since: BASE_ISO, until: isoMinutes(60), reason: LIST_NOTE, on: { kind: 'employee' as const, employee: 'dev-head', name: 'Dana' },
  },
} : task.number === 224 ? { ...task, priority: 'high' as const, goal: null } : task);

/* Count the translated parts shown in each tracker view. A blank argument removes fixture data from a phrase. */
function trackerWords(t: Messages, view: 'tasks' | 'board' | 'turns'): string[] {
  const { side, where, views, filters, statuses, list, board } = t.tracker;
  const common = [...Object.values(side).filter((word): word is string => typeof word === 'string'), t.tasks.search];
  if (view === 'turns') {
    const words = t.tasks.board;
    return [...common, where.turns, t.tasks.department, words.show, words.showReleases, words.showOutside, words.relsWhy, words.nextWhy,
      words.preparing(1, ''), words.goalsDone(1, 1), words.closedReleases, words.released(1, ''), words.relCount(1), t.tracker.wait.question,
      t.tracker.groups.waitingYou, t.tracker.wait.person('', t.tracker.time.minutes(40)), t.tracker.time.minutes(49)];
  }
  const controls = [...Object.values(views), filters.group(), filters.executor, filters.responsible, ...Object.values(statuses)];
  return view === 'tasks'
    ? [...common, ...controls, filters.showSubtasks, list.task, list.executor, list.responsible, list.due,
      list.subtasks(1, 3), ...Object.values(t.tracker.priority), t.tracker.nobody, t.tracker.noGoal, t.tracker.wait.employee(''), t.tracker.wait.detail('', ''),
      t.tracker.card.executor, t.tracker.card.responsible, t.tracker.card.due, t.tasks.taskActions, t.tasks.log]
    : [...common, ...controls, board.subtasks(1, 1), board.empty, t.tracker.wait.question,
      t.tracker.groups.waitingYou, t.tracker.time.minutes(49), t.tracker.wait.failedRun('17', false)];
}

export async function expectTaskCard(page: Page, t: Messages, title: string): Promise<Locator> {
  const card = page.getByRole('complementary', { name: `#221 ${title}`, exact: true });
  await expect(card.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const facts = card.getByRole('group', { name: t.tracker.card.facts });
  await expect(facts).toContainText('Sam Rivera');
  await expect(facts.getByRole('link', { name: '#244 Frame guide overlay for the leaf', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: t.tasks.taskActions, exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(card.locator('.tp-brief')).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Done when', exact: true })).toBeVisible();
  await expect(card.getByRole('region', { name: t.tasks.log })).toBeVisible();
  return card;
}

/* Real geometry checks run alongside the still pictures in each browser engine. */
export async function trackerFrames(browser: Browser, info: TestInfo, view: 'tasks' | 'board' | 'turns'): Promise<void> {
  const paths = { tasks: '/tasks?department=dept-dev', board: '/tasks?department=dept-dev&view=board', turns: '/tasks?show=turns' };
  for (const { id, t } of await frameLanguages(t => trackerWords(t, view))) {
    for (const theme of FRAME_THEMES) {
      for (const size of FRAME_SIZES) {
        const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: size, timezoneId: 'UTC' });
        try {
          const frame = await context.newPage();
          const watcher = await prepareScenePage(frame, undefined, id, theme);
          await frame.clock.setFixedTime(new Date(BASE_ISO));
          const fixture = await serveMoonfern(frame);
          if (view === 'tasks') fixture.setTasks(listTasks);
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
            await assertBoard(region, wide, t);
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
          if (view === 'tasks') {
            const group = region.getByRole('region', { name: new RegExp(`^${t.tracker.groups.working}:`) });
            const parent = group.getByRole('listitem', { name: `#221 ${LIST_PARENT}`, exact: true });
            const leaf = group.getByRole('listitem', { name: '#224 Sunlight meter calibration on iPhone', exact: true });
            await assertListRows(region, parent, leaf, wide);
            await parent.getByRole('button', { name: t.tracker.list.subtasks(1, 3) }).click();
            await expect(parent.getByRole('listitem', { name: '#244 Frame guide overlay for the leaf' })).toBeVisible();
            await assertTrackerFit(frame);
            await parent.locator('.tr-row-line').first().evaluate(row => row.scrollIntoView({ block: 'start', inline: 'nearest' }));
            await frame.screenshot({ path: info.outputPath(`tasks-expanded-${id}-${theme}-${size.width}.png`) });
          }
          if (view === 'board') {
            const last = region.getByRole('region', { name: t.tracker.statuses.done, exact: true }).locator('.tr-card').last();
            await last.evaluate(card => card.scrollIntoView({ block: 'end', inline: 'nearest' }));
            await assertTrackerEdges(frame, size.width, last);
            await frame.screenshot({ path: info.outputPath(`board-bottom-${id}-${theme}-${size.width}.png`) });
            await frame.locator('.tracker-page').evaluate(element => { element.scrollTop = 0; });
          }
          if (view !== 'turns') {
            if (!wide) await frame.getByRole('button', { name: t.tracker.side.open }).click();
            await assertSelectedDepartment(sidebar, t);
            if (view === 'board') await expect(sidebar.getByRole('button', { name: `${t.tracker.side.failures} 0` })).toBeVisible();
            await assertTrackerFit(frame);
            if (!wide) await sidebar.getByRole('button', { name: t.tracker.side.close }).click();
          }
          if (view === 'tasks') {
            const parent = region.getByRole('listitem', { name: `#221 ${LIST_PARENT}`, exact: true });
            await parent.getByRole('button', { name: LIST_PARENT, exact: true }).click();
            const card = await expectTaskCard(frame, t, LIST_PARENT);
            await expect(card.getByRole('region', { name: t.tasks.log })).toContainText(LIST_NOTE);
            const body = card.locator('.ac-body');
            expect(await body.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            await frame.screenshot({ path: info.outputPath(`task-card-${id}-${theme}-${size.width}.png`) });
          }
          if (view === 'board') {
            if (!wide) {
              await region.getByRole('region', { name: t.tracker.statuses.waits }).locator('.tr-card').first().scrollIntoViewIfNeeded();
              await frame.screenshot({ path: info.outputPath(`board-person-${id}-${theme}-${size.width}.png`) });
            }
            await frame.goto(`/tasks?department=dept-dev&pipeline=${MOONFERN_PIPELINE.id}&view=board`);
            const smoke = await expectBetaBoard(region, t);
            await assertBoard(region, wide, t);
            await assertTrackerFit(frame);
            await frame.screenshot({ path: info.outputPath(`pipeline-${id}-${theme}-${size.width}.png`) });
            if (!wide) {
              await smoke.scrollIntoViewIfNeeded();
              await frame.screenshot({ path: info.outputPath(`pipeline-smoke-${id}-${theme}-${size.width}.png`) });
            }

            fixture.setTasks(MOONFERN_TASKS.map(task => task.number === 224 ? {
              ...task, time: { ...task.time!, waitsOn: [{ kind: 'run', who: null, since: BASE_ISO, reason: '17', failure: 'run' }] },
            } : task));
            await frame.goto(paths.board);
            const failures = region.getByRole('region', { name: t.tracker.statuses.failure });
            const failed = failures.getByRole('article', { name: '#224 Sunlight meter calibration on iPhone' });
            await expect(failed).toBeVisible();
            await expect(failed.locator('.tr-wait.failure')).toHaveText(t.tracker.wait.failedRun('17', false));
            await assertBoard(region, wide, t);
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

async function assertSelectedDepartment(sidebar: Locator, t: Messages): Promise<void> {
  const head = sidebar.locator('.tr-dept-head.on');
  await expect(head.getByRole('button', { name: 'Development', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(head.getByRole('button', { expanded: true })).toBeVisible();
  await expectOneLine(head.getByText('Development', { exact: true }));
  const pipeline = sidebar.getByText(t.tracker.side.defaultPipeline(MOONFERN_PIPELINE.name), { exact: true });
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

async function listRowGeometry(row: Locator) {
  return row.evaluate(element => {
    const line = element.querySelector(':scope > .tr-row-line')!;
    const name = line.querySelector('.tr-name')!;
    const [caret, dot, title] = [...name.children] as [Element, Element, Element];
    const meta = line.querySelector('.tr-meta')!;
    const rtl = getComputedStyle(line).direction === 'rtl';
    const start = (node: Element) => {
      const box = node.getBoundingClientRect();
      return rtl ? box.right : box.left;
    };
    const center = (node: Element) => {
      const box = node.getBoundingClientRect();
      return box.y + box.height / 2;
    };
    const firstLineCenter = (node: Element) => {
      const style = getComputedStyle(node);
      return node.getBoundingClientRect().top + parseFloat(style.paddingBlockStart) + parseFloat(style.lineHeight) / 2;
    };
    const range = document.createRange();
    range.selectNodeContents(title);
    return {
      titleStart: start(title), titleCenter: firstLineCenter(title), titleLines: range.getClientRects().length,
      caretCenter: center(caret), caretWidth: caret.getBoundingClientRect().width, dotCenter: center(dot),
      nameWidth: name.getBoundingClientRect().width, metaStart: start(meta), metaBottom: meta.getBoundingClientRect().bottom,
      facts: [...line.querySelectorAll(':scope > .tr-cell')].filter(cell => cell.getClientRects().length > 0).map(cell => {
        const value = cell.querySelector('.tr-v')!;
        const mark = value.querySelector('.tr-mark');
        return {
          start: start(cell), width: cell.getBoundingClientRect().width, top: cell.getBoundingClientRect().top,
          center: mark ? center(mark) : firstLineCenter(value),
        };
      }),
    };
  });
}

async function assertListRows(list: Locator, parent: Locator, leaf: Locator, wide: boolean): Promise<void> {
  await expect(parent.locator('.tr-wait')).toContainText(LIST_NOTE);
  const [long, short] = await Promise.all([listRowGeometry(parent), listRowGeometry(leaf)]);
  const aligns = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  expect(long.titleLines).toBeGreaterThan(1);
  aligns(long.caretCenter, long.titleCenter);
  aligns(long.dotCenter, long.titleCenter);
  aligns(short.dotCenter, short.titleCenter);
  aligns(long.caretWidth, short.caretWidth);
  aligns(long.titleStart, short.titleStart);
  aligns(long.titleStart, long.metaStart);
  aligns(short.titleStart, short.metaStart);
  if (wide) {
    expect(short.titleLines).toBe(1);
    const headings = await list.locator('.tr-head > span').evaluateAll(nodes => nodes.map(node => {
      const heading = node.firstElementChild ?? node;
      const box = heading.getBoundingClientRect();
      return getComputedStyle(node).direction === 'rtl' ? box.right : box.left;
    }));
    aligns(long.titleStart, headings[0]!);
    for (const [index, fact] of long.facts.entries()) {
      aligns(fact.start, headings[index + 1]!);
      aligns(fact.start, short.facts[index]!.start);
      aligns(fact.center, long.titleCenter);
    }
    /* The task takes two thirds of the line at least, its three facts the rest. */
    expect(long.nameWidth).toBeGreaterThanOrEqual(2 * long.facts.reduce((width, fact) => width + fact.width, 0) - 1);
  } else {
    await expect(list.locator('.tr-head')).toBeHidden();
    for (const row of [long, short]) {
      for (const fact of row.facts) {
        aligns(fact.start, row.titleStart);
        expect(fact.top).toBeGreaterThanOrEqual(row.metaBottom);
      }
    }
  }
}

async function assertBoard(board: Locator, wide: boolean, t: Messages): Promise<void> {
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
  await expectOneLine(board.getByRole('button', { name: t.tracker.wait.question, exact: true }).first());
}

async function assertTrackerFit(page: Page): Promise<void> {
  const failures = await page.locator('.tracker-page, .tr-side, .tr-main, .tr-top, .tr-row-line, .tr-card, .goal-row, .entry-actions').evaluateAll(nodes =>
    nodes.filter(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1).map(node => node.className));
  expect(failures).toEqual([]);
}
