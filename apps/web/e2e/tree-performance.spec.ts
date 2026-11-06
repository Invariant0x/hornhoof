import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { expect, test } from '@playwright/test';
import { box } from './api';
import { instrumentChipRenders, resetChipRenders, chipRenderNames, chipRenders, serveFullDepartment, openDepartment, measure, summarizeFrames, taskTiming, type Measurement } from './tree-performance-helpers';

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

test('100 pan movements move the scene without rendering its chips', async ({ page }, info) => {
  await instrumentChipRenders(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  await serveFullDepartment(page);
  await openDepartment(page, true);
  const scene = page.locator('.tv-in'), before = await scene.getAttribute('style');
  await resetChipRenders(page);
  const bounds = await box(page.locator('.tv-scroll')), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 0; i < 100; i++) await page.mouse.move(x + (i % 20) * 3, y + (i % 10) * 2);
  await page.mouse.up();
  const after = await scene.getAttribute('style'), renders = await chipRenders(page);
  const countPath = info.outputPath('pan-render-count.json');
  await writeFile(countPath, JSON.stringify({ movements: 100, before, after, renders }, null, 2));
  await info.attach('pan-render-count.json', { path: countPath, contentType: 'application/json' });
  expect(after, 'the pointer drag really moved the scene').not.toBe(before);
  expect(renders, 'no chip rendered after its initial mount').toBe(0);
});

test('a real employee update renders only the changed chip', async ({ page }, info) => {
  await instrumentChipRenders(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const served = await serveFullDepartment(page);
  await openDepartment(page, true);
  const title = 'A genuinely refreshed task title';
  const hana = page.locator('.tv-labs .dept-chip').filter({ has: page.locator('.mn', { hasText: /^Hana$/ }) }).locator('.schip');
  const originalHana = await hana.elementHandle();
  await resetChipRenders(page);
  served.renameBrunoTask(title);
  const response = page.waitForResponse(r => r.url().endsWith('/api/org'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response;
  await expect(page.locator('.tv-labs .dept-chip').filter({ has: page.locator('.mn', { hasText: /^Bruno$/ }) })).toContainText(title);
  expect(await originalHana!.evaluate(el => el.isConnected), 'an unchanged chip is not remounted').toBe(true);
  const renders = await chipRenderNames(page);
  const updatePath = info.outputPath('update-render-count.json');
  await writeFile(updatePath, JSON.stringify({ title, renders }, null, 2));
  await info.attach('update-render-count.json', { path: updatePath, contentType: 'application/json' });
  expect(renders.length, 'the changed employee really rendered').toBeGreaterThan(0);
  expect([...new Set(renders)], 'only Bruno has new employee data').toEqual(['Bruno']);
});

function summarize(measurement: Measurement) {
  const { mainTasks, otherTasks, ...summary } = summarizeFrames(measurement);
  return { fps: summary.fps, frames: summary.frames, longTasks: mainTasks.map(taskTiming), otherThreadLongTasks: otherTasks.map(taskTiming), chipRenders: summary.chipRenders, movements: summary.movements };
}

test('record ten seconds of tree and department pan/zoom', async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  await instrumentChipRenders(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const { full } = await serveFullDepartment(page);
  await openDepartment(page, true);
  const tree = await measure(page, '.tv-scroll');
  await page.locator('.dview').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.dcanvas .dept-chip')).toHaveCount(12);
  const map = await measure(page, '.dcanvas');
  const summary = {
    label: process.env.TREE_PERF_LABEL ?? 'unlabelled',
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    browser: browser.version(),
    viewport: { width: 1440, height: 900 },
    mode: 'vite --mode browser-test (development), reduced motion',
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
  expect(tree.movements).toBeGreaterThan(20);
  expect(map.movements).toBeGreaterThan(20);
  expect(summary.tree.longTasks, 'the recorded tree interaction has no task over 50 ms').toEqual([]);
  expect(summary.map.longTasks, 'the recorded department interaction has no task over 50 ms').toEqual([]);
  expect(summary.tree.fps, 'tree fps is within 5% of department fps').toBeGreaterThanOrEqual(summary.map.fps * .95);
});
