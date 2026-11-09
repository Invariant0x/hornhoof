import { expect, type Page } from '@playwright/test';
import { box } from './api';
import { fullDepartment, type Tree } from './full-department';
import { serveTree } from './tree-api';
import { taskRoute } from '../test/task-route';

type TraceData = {
  functionName?: string;
  url?: string;
  scriptName?: string;
  lineNumber?: number;
  columnNumber?: number;
  type?: string;
};
export type TraceEvent = {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { data?: TraceData };
};
export type Measurement = { events: TraceEvent[]; frames: number[]; chipRenders: number; movements: number };

export async function instrumentChipRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __chipRenders: string[] }).__chipRenders = [];
  });
  await page.route('**/src/ui/Chip.tsx*', async route => {
    const response = await route.fetch();
    const needle = '\tconst t = useT();\n\treturn';
    const source = await response.text();
    if (!source.includes(needle)) throw new Error('The Chip render instrumentation did not find its insertion point');
    const body = source.replace(needle, '\tconst t = useT();\n\t(globalThis.__chipRenders ??= []).push(e.name);\n\treturn');
    await route.fulfill({ response, body });
  });
}

export async function resetChipRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __chipRenders: string[] }).__chipRenders.length = 0;
  });
}

export async function chipRenderNames(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __chipRenders: string[] }).__chipRenders]);
}

export async function chipRenders(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __chipRenders: string[] }).__chipRenders.length);
}

export async function serveFullDepartment(page: Page): Promise<{ full: Tree; renameBrunoTask: (title: string) => void }> {
  const full = fullDepartment();
  let shown: Tree = full;
  await serveTree(page, { during: true });
  await page.route('**/api/org', route => route.fulfill({ json: shown.org }));
  await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: shown.tree } }));
  return {
    full,
    renameBrunoTask(title: string) {
      const departments = full.org.departments.map((department, index) => index ? department : {
        ...department,
        /* Bruno has no current task: he gets his own task #62, whole as the server sends it, with the route the chip reads. */
        employees: department.employees.map(employee => employee.name === 'Bruno'
          ? { ...employee, task: { id: 't62', number: 62, title, echelons: taskRoute('development', employee.id) } }
          : employee),
      });
      shown = { ...full, org: { ...full.org, departments } };
    },
  };
}

export async function openDepartment(page: Page, tree = true): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /Development/ }).click();
  if (tree) {
    await page.getByRole('button', { name: 'Tree', exact: true }).click();
    await expect(page.locator('.tv-labs .dept-chip')).toHaveCount(12);
  } else {
    await expect(page.locator('.dcanvas .dept-chip')).toHaveCount(12);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __frames: number[]; __frameRequest: number };
    state.__frames = [];
    const frame = (at: number) => {
      state.__frames.push(at);
      state.__frameRequest = requestAnimationFrame(frame);
    };
    state.__frameRequest = requestAnimationFrame(frame);
  });
}

export async function stopFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const state = window as unknown as { __frames: number[]; __frameRequest: number };
    cancelAnimationFrame(state.__frameRequest);
    return state.__frames;
  });
}

export async function panAndZoom(page: Page, selector: string): Promise<number> {
  const bounds = await box(page.locator(selector)), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  const started = Date.now();
  let movements = 0;
  await page.mouse.move(x, y);
  await page.mouse.down();
  while (Date.now() - started < 10_000) {
    await page.mouse.move(x + Math.sin(movements / 8) * 180, y + Math.cos(movements / 11) * 100);
    movements++;
    if (movements % 15 === 0) await page.mouse.wheel(0, movements % 30 ? -25 : 25);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  return movements;
}

export async function measure(page: Page, selector: string): Promise<Measurement> {
  const session = await page.context().newCDPSession(page), events: TraceEvent[] = [];
  session.on('Tracing.dataCollected', event => events.push(...(event.value as unknown as TraceEvent[])));
  const complete = new Promise<void>(resolve => session.once('Tracing.tracingComplete', () => resolve()));
  await session.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing',
    transferMode: 'ReportEvents',
  });
  await resetChipRenders(page);
  await startFrames(page);
  const movements = await panAndZoom(page, selector), frames = await stopFrames(page), renders = await chipRenders(page);
  await session.send('Tracing.end');
  await complete;
  await session.detach();
  return { events, frames, chipRenders: renders, movements };
}

type FrameSummary = { fps: number; frames: number; mainTasks: TraceEvent[]; otherTasks: TraceEvent[]; chipRenders: number; movements: number };

export function summarizeFrames(measurement: Measurement): FrameSummary {
  const { frames, events } = measurement;
  const fps = frames.length > 1 ? (frames.length - 1) * 1000 / (frames.at(-1)! - frames[0]!) : 0;
  const main = events.find(event => event.name === 'EventDispatch');
  const tasks = events.filter(isLongTask);
  return {
    fps, frames: frames.length,
    mainTasks: tasks.filter(event => onThread(event, main)),
    otherTasks: tasks.filter(event => !onThread(event, main)),
    chipRenders: measurement.chipRenders, movements: measurement.movements,
  };
}

export const taskTiming = (event: TraceEvent): { at: number; durationMs: number; pid: number; tid: number } => ({ at: event.ts, durationMs: event.dur! / 1000, pid: event.pid, tid: event.tid });

const isLongTask = (event: TraceEvent) => event.ph === 'X'
  && ['RunTask', 'ThreadControllerImpl::RunTask'].includes(event.name) && (event.dur ?? 0) > 50_000;
const onThread = (event: TraceEvent, main: TraceEvent | undefined) => event.pid === main?.pid && event.tid === main?.tid;
