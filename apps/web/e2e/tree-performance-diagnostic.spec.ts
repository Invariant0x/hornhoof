import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { box } from './api';
import { fullDepartment } from './full-department';
import { serveTree } from './tree-api';

type TraceData = {
  functionName?: string;
  url?: string;
  scriptName?: string;
  lineNumber?: number;
  columnNumber?: number;
  type?: string;
};
type TraceEvent = {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { data?: TraceData };
};
type Measurement = { events: TraceEvent[]; frames: number[]; chipRenders: number; movements: number };

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

async function instrumentChipRenders(page: Page) {
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

async function resetChipRenders(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __chipRenders: string[] }).__chipRenders.length = 0;
  });
}

async function chipRenders(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __chipRenders: string[] }).__chipRenders.length);
}

async function serveFullDepartment(page: Page) {
  const full = fullDepartment();
  await serveTree(page, { during: true });
  await page.route('**/api/org', route => route.fulfill({ json: full.org }));
  await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: full.tree } }));
  return full;
}

async function openDepartment(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Development/ }).click();
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  await expect(page.locator('.tv-labs .dept-chip')).toHaveCount(12);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function startFrames(page: Page) {
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

async function stopFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const state = window as unknown as { __frames: number[]; __frameRequest: number };
    cancelAnimationFrame(state.__frameRequest);
    return state.__frames;
  });
}

async function panAndZoom(page: Page, selector: string): Promise<number> {
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

async function measure(page: Page, selector: string): Promise<Measurement> {
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

function eventDetail(event: TraceEvent) {
  const data = event.args?.data;
  return {
    name: event.name,
    durationMs: (event.dur ?? 0) / 1000,
    eventType: data?.type ?? null,
    functionName: data?.functionName ?? null,
    script: data?.url ?? data?.scriptName ?? null,
    line: data?.lineNumber ?? null,
    column: data?.columnNumber ?? null,
  };
}

const stageNames = new Set([
  'EventDispatch', 'FireAnimationFrame', 'TimerFire', 'RequestAnimationFrame', 'FunctionCall', 'EvaluateScript',
  'UpdateLayoutTree', 'Layout', 'Paint', 'CompositeLayers', 'UpdateLayerTree', 'HitTest', 'ScrollLayer', 'Rasterize',
]);

function longTaskDetail(task: TraceEvent, events: TraceEvent[]) {
  const end = task.ts + task.dur!;
  const children = events.filter(event => event !== task && event.ph === 'X' && event.dur
    && event.pid === task.pid && event.tid === task.tid && event.ts >= task.ts && event.ts + event.dur <= end);
  const byDuration = (left: TraceEvent, right: TraceEvent) => right.dur! - left.dur!;
  return {
    at: task.ts,
    durationMs: task.dur! / 1000,
    pid: task.pid,
    tid: task.tid,
    stages: children.filter(event => stageNames.has(event.name)).sort(byDuration).slice(0, 10).map(eventDetail),
    functions: children.filter(event => ['FunctionCall', 'EvaluateScript'].includes(event.name))
      .sort(byDuration).slice(0, 10).map(eventDetail),
  };
}

function summarize(measurement: Measurement) {
  const { frames, events } = measurement;
  const fps = frames.length > 1 ? (frames.length - 1) * 1000 / (frames.at(-1)! - frames[0]!) : 0;
  const main = events.find(event => event.name === 'EventDispatch');
  const tasks = events.filter(event => event.ph === 'X'
    && ['RunTask', 'ThreadControllerImpl::RunTask'].includes(event.name) && (event.dur ?? 0) > 50_000);
  const mainTasks = tasks.filter(event => event.pid === main?.pid && event.tid === main?.tid);
  const otherThreadLongTasks = tasks.filter(event => event.pid !== main?.pid || event.tid !== main?.tid)
    .map(event => ({ at: event.ts, durationMs: event.dur! / 1000, pid: event.pid, tid: event.tid }));
  return {
    fps,
    frames: frames.length,
    longTasks: mainTasks.map(event => longTaskDetail(event, events)),
    otherThreadLongTasks,
    chipRenders: measurement.chipRenders,
    movements: measurement.movements,
  };
}

test('diagnose ten seconds of tree and department pan/zoom', async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  await instrumentChipRenders(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const full = await serveFullDepartment(page);
  await openDepartment(page);
  const tree = await measure(page, '.tv-scroll');
  await page.locator('.dview').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.dcanvas .dept-chip')).toHaveCount(12);
  const map = await measure(page, '.dcanvas');
  const summary = {
    label: process.env.TREE_PERF_LABEL ?? 'unlabelled',
    sha: process.env.TREE_PERF_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    browser: browser.version(),
    viewport: { width: 1440, height: 900 },
    mode: 'vite --mode browser-test (development), reduced motion',
    thresholds: { longTaskMs: 50, minimumTreeToMapFpsRatio: 0.95 },
    load: { tasks: full.tree.lines.length, chips: full.org.departments[0]!.employees.length, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, loadavg: loadavg() },
    tree: summarize(tree),
    map: summarize(map),
  };
  for (const [name, measurement] of [['tree', tree], ['map', map]] as const) {
    const path = info.outputPath(`performance-${name}.json`);
    await writeFile(path, JSON.stringify({ traceEvents: measurement.events }));
    await info.attach(`performance-${name}.json`, { path, contentType: 'application/json' });
  }
  const summaryPath = info.outputPath('performance-summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  await info.attach('performance-summary.json', { path: summaryPath, contentType: 'application/json' });
  console.log(`::tree-perf-diagnostic::${JSON.stringify(summary)}`);
  expect(tree.movements).toBeGreaterThan(20);
  expect(map.movements).toBeGreaterThan(20);
  expect(summary.tree.longTasks.map(task => task.durationMs), 'the recorded tree interaction has no task over 50 ms').toEqual([]);
  expect(summary.map.longTasks.map(task => task.durationMs), 'the recorded department interaction has no task over 50 ms').toEqual([]);
  expect(summary.tree.fps, 'tree fps is within 5% of department fps').toBeGreaterThanOrEqual(summary.map.fps * .95);
});
