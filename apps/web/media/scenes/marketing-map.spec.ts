import { expect, test, type Page } from '@playwright/test';
import type { Org } from '../../src/types';
import { clickHere, glideTo, installSceneCursor } from '../moonfern/cursor';
import { createSceneRecorder } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { MOONFERN_TURNS } from '../moonfern/tasks';
import { buildDevelopmentTreeSnapshots } from '../moonfern/tree';

/* The marketing cut of the company map, 10 to 30 s: Moonfern's map with its lines running, a pointer that opens
   Development, its time in the Speed panel moving on, then the tracker. One recording per post shape, each at the pixel
   size the network shows, so nothing is scaled down afterwards: LinkedIn 4:5 at 1080x1350 and X 16:9 at 1920x1080. The
   device scale brings the words up to a size a phone still reads; the narrow shape takes the phone layout, where the
   department's name has a row of its own, and zooms the map in to the departments before the cut starts. */
const ALL_SHAPES = [
  { name: 'marketing-map-linkedin', viewport: { width: 600, height: 750 }, scale: 1.8, zoomIn: 2 },
  { name: 'marketing-map-x', viewport: { width: 1280, height: 720 }, scale: 1.5, zoomIn: 0 },
] as const;
const SHAPES = ALL_SHAPES.filter(shape => !process.env.MEDIA_SHAPE || shape.name === process.env.MEDIA_SHAPE);

function withWorking(base: Org, ids: string[]): Org {
  const extra = new Set(ids);
  const departments = base.departments.map(d => {
    const employees = d.employees.map(e => (extra.has(e.id) ? { ...e, state: 'working' as const, status: 'working' as const } : e));
    return { ...d, employees, agents: { total: employees.length, working: employees.filter(e => e.status === 'working').length } };
  });
  return {
    ...base,
    departments,
    agents: { total: departments.reduce((s, d) => s + d.agents.total, 0), working: departments.reduce((s, d) => s + d.agents.working, 0) },
  };
}

/* Stills for a person checking the cut by eye on a machine without ffmpeg; the workflow takes its frames from the video. */
async function still(page: Page, name: string, step: string) {
  const dir = process.env.MEDIA_STILLS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${step}.png` });
}

for (const shape of SHAPES) {
  const size = { width: Math.round(shape.viewport.width * shape.scale), height: Math.round(shape.viewport.height * shape.scale) };

  /* Its own context: the size and scale of a recording belong to the context, and the config's are the README's. */
  test(`${shape.name}: the map runs, a pointer opens Development and its Speed, then the tracker`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL, viewport: shape.viewport, deviceScaleFactor: shape.scale, locale: 'en', timezoneId: 'UTC', colorScheme: 'dark',
      reducedMotion: 'no-preference', recordVideo: { dir: test.info().outputPath('video'), size },
    });
    const page = await context.newPage();
    const snapshots = buildDevelopmentTreeSnapshots();
    const first = snapshots[0]!;
    const recorder = createSceneRecorder(page);
    const watcher = await prepareScenePage(page, first.now, 'en', 'cyberpunk');
    const api = await serveMoonfern(page, { initialOrg: first.org, initialTree: first.tree });
    let at = { x: Math.round(shape.viewport.width * 0.82), y: Math.round(shape.viewport.height * 0.7) };
    await installSceneCursor(page, at);

    await page.goto('/');
    await expect(page.locator('.hub')).toBeVisible();
    const development = page.getByRole('button', { name: /^Development/ });
    await expect(development).toBeVisible();
    for (let i = 0; i < shape.zoomIn; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(850);
    await recorder.markReady();
    await still(page, shape.name, '1-map');

    /* The lines run: work goes out to the departments and comes back, and more agents get to work. */
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dsn' }, to: { kind: 'orchestrator' } });
    await page.waitForTimeout(1300);
    const busier = withWorking(first.org, ['dev-8', 'ops-bugs']);
    api.setOrg(busier);
    api.setTurns(MOONFERN_TURNS.map(u => (u.number === 6 ? { ...u, tasks: { total: 40, done: 25 } } : u)));
    await pushStream(page, { type: 'working', working: busier.agents.working });
    await pushStream(page, { type: 'task', id: 't-235', spot: { departmentId: 'dept-dev' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-mkt' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'person', id: 'p-maya' }, to: { kind: 'orchestrator' } });
    await page.waitForTimeout(1500);
    await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dev' }, to: { kind: 'orchestrator' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-ops' } });
    await page.waitForTimeout(1300);
    await still(page, shape.name, '2-running');

    /* The pointer opens Development: its people at work and their tasks moving through the gates. */
    at = await glideTo(page, at, development, 1100);
    await page.waitForTimeout(250);
    await clickHere(page);
    await expect(page.locator('.dview')).toBeVisible();
    await page.waitForTimeout(1500);
    await still(page, shape.name, '3-department');
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } });
    await page.waitForTimeout(900);

    /* Its time: the Speed panel, where each agent's turn moves on as the clock does. */
    const speed = page.getByRole('button', { name: 'Speed', exact: true });
    at = await glideTo(page, at, speed, 900);
    await page.waitForTimeout(200);
    await clickHere(page);
    await expect(page.getByRole('complementary', { name: 'Speed', exact: true })).toBeVisible();
    await page.waitForTimeout(1100);
    for (const [index, taskId] of [[1, 't-226'], [2, 't-221']] as const) {
      const snap = snapshots[index]!;
      await page.clock.setSystemTime(new Date(snap.now));
      api.setOrg(snap.org);
      api.setTree(snap.tree);
      await pushStream(page, { type: 'task', id: taskId, spot: { departmentId: 'dept-dev' } });
      await pushStream(page, { type: 'org' });
      await page.waitForTimeout(1300);
    }
    await still(page, shape.name, '4-speed');

    /* Then the tracker, where the same work stands as tasks. */
    const tasksTab = page.getByRole('button', { name: /^Tasks/ }).first();
    at = await glideTo(page, at, tasksTab, 1000);
    await page.waitForTimeout(200);
    await clickHere(page);
    await expect(page.locator('.tracker')).toBeVisible();
    await page.waitForTimeout(1500);
    await still(page, shape.name, '5-tracker');
    await page.waitForTimeout(2300);
    await still(page, shape.name, '6-tracker-later');

    watcher.assertClean();
    await recorder.finishGif(shape.name);
    await context.close();
  });
}
