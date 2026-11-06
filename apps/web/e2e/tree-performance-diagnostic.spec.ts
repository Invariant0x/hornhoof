import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { expect, test } from '@playwright/test';
import { instrumentChipRenders, serveFullDepartment, openDepartment, measure, summarizeFrames, taskTiming, type Measurement, type TraceEvent } from './tree-performance-helpers';

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

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
  const { mainTasks, otherTasks, ...summary } = summarizeFrames(measurement);
  return {
    fps: summary.fps,
    frames: summary.frames,
    longTasks: mainTasks.map(event => longTaskDetail(event, measurement.events)),
    otherThreadLongTasks: otherTasks.map(taskTiming),
    chipRenders: summary.chipRenders,
    movements: summary.movements,
  };
}

test('diagnose ten seconds of tree and department pan/zoom', async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  await instrumentChipRenders(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const { full } = await serveFullDepartment(page);
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
