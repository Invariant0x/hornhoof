import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Org } from '../../src/types';
import { installSceneCursor } from '../moonfern/cursor';
import { Film, installFilmClock, settle } from '../moonfern/film';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { MOONFERN_TURNS } from '../moonfern/tasks';
import { buildDevelopmentTreeSnapshots } from '../moonfern/tree';

/* The marketing cut of the company map, one continuous take of 10 to 30 s: Moonfern's map at rest with its lines
   running, the pointer coming to Development and Sam Rivera, who answers for it, and clicking it; Development open with
   its people at work or idle and its time in the Speed panel; the move to the tracker, held still. One take per post
   shape, at the pixel size the network shows, so nothing is scaled up or down afterwards: LinkedIn 4:5 at 1080x1350
   (540x675 at a device scale of 2, the phone layout) and X 16:9 at 1920x1080 (1280x720 at 1.5: from 761 to about 1000
   CSS px wide the department's name runs into the tabs, so 960x540 at 2 is no way). */
const ALL_SHAPES = [
  { name: 'marketing-map-linkedin', viewport: { width: 540, height: 675 }, scale: 2, zoomIn: 2 },
  { name: 'marketing-map-x', viewport: { width: 1280, height: 720 }, scale: 1.5, zoomIn: 0 },
] as const;
const SHAPES = ALL_SHAPES.filter(shape => !process.env.MEDIA_SHAPE || shape.name === process.env.MEDIA_SHAPE);

/* Development with some agents at work on named tasks and some plainly idle, so the map and the department show both. */
const IDLE = new Set(['dev-perf', 'dev-8', 'dev-2', 'dev-4', 'dev-test']);
function seeded(org: Org): Org {
  return withCounts({
    ...org,
    departments: org.departments.map(d => d.id !== 'dept-dev' ? d : {
      ...d,
      employees: d.employees.map(e => (IDLE.has(e.id) ? { ...e, status: 'idle' as const, state: 'sleeping' as const, task: null, program: null } : e)),
      workLines: d.workLines?.map(line => (IDLE.has(line.downstreamAgentId) ? { ...line, working: false } : line)),
    }),
  });
}

function withWorking(base: Org, ids: string[]): Org {
  const extra = new Set(ids);
  return withCounts({
    ...base,
    departments: base.departments.map(d => ({ ...d, employees: d.employees.map(e => (extra.has(e.id) ? { ...e, state: 'working' as const, status: 'working' as const } : e)) })),
  });
}

function withCounts(org: Org): Org {
  const departments = org.departments.map(d => ({ ...d, agents: { total: d.employees.length, working: d.employees.filter(e => e.status === 'working').length } }));
  return { ...org, departments, agents: { total: departments.reduce((s, d) => s + d.agents.total, 0), working: departments.reduce((s, d) => s + d.agents.working, 0) } };
}

type Box = { x: number; y: number; width: number; height: number };

/* The box around a few things on the page, on screen or not. */
async function around(locators: Locator[]): Promise<Box> {
  const boxes = await Promise.all(locators.map(async locator => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('a part of the camera move is not on the page');
    return box;
  }));
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
}

const middleOf = (box: Box) => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });

/* Stills of chosen moments for a person checking the cut by eye where no ffmpeg is at hand. */
async function still(page: Page, name: string, step: string) {
  const dir = process.env.MEDIA_STILLS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${step}.png` });
}

for (const shape of SHAPES) {
  /* Its own context: the size and scale of a take belong to the context, and the config's are the README's. */
  test(`${shape.name}: the map runs, a pointer opens Development and its Speed, then the tracker`, async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const context = await browser.newContext({
      baseURL, viewport: shape.viewport, deviceScaleFactor: shape.scale, locale: 'en', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    const snapshots = buildDevelopmentTreeSnapshots().map(snap => ({ ...snap, org: seeded(snap.org) }));
    const first = snapshots[0]!;
    await installFilmClock(page, first.now);
    const watcher = await prepareScenePage(page, first.now, 'en', 'cyberpunk');
    const api = await serveMoonfern(page, { initialOrg: first.org, initialTree: first.tree });
    const film = new Film(page, shape.name, { x: Math.round(shape.viewport.width * 0.82), y: Math.round(shape.viewport.height * 0.7) });
    await installSceneCursor(page, film.pointer);

    await page.goto('/');
    await expect(page.locator('.hub')).toBeVisible();
    const development = page.getByRole('button', { name: /^Development/ });
    await expect(development).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    /* The map fits itself to the screen on its clock, which waits for the film: let it settle before the take. */
    await settle(page, development);
    for (let i = 0; i < shape.zoomIn; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await settle(page, development);
    await page.mouse.move(film.pointer.x, film.pointer.y);

    /* 1. The map at rest, its lines running: work goes out to the departments and comes back, and one more agent starts. */
    film.mark('map at rest');
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dsn' }, to: { kind: 'orchestrator' } });
    await film.hold(1600);
    const busier = withWorking(first.org, ['ops-bugs']);
    api.setOrg(busier);
    api.setTurns(MOONFERN_TURNS.map(u => (u.number === 6 ? { ...u, tasks: { total: 40, done: 25 } } : u)));
    await pushStream(page, { type: 'working', working: busier.agents.working });
    await pushStream(page, { type: 'task', id: 't-235', spot: { departmentId: 'dept-dev' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-mkt' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'person', id: 'p-maya' }, to: { kind: 'orchestrator' } });
    await film.hold(1800);
    await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dev' }, to: { kind: 'orchestrator' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-ops' } });
    await film.hold(1600);
    await still(page, shape.name, '1-map');

    /* 2. The pointer comes to Development: it pulls the map until Development and Sam Rivera stand in the middle, zooms in
       on them until the name reads on a phone, and clicks. */
    film.mark('to Development');
    const responsible = page.getByRole('button', { name: /Sam Rivera/ }).first();
    const pair = await around([development, responsible]);
    const middle = { x: Math.round(shape.viewport.width / 2), y: Math.round(shape.viewport.height * 0.42) };
    const pairMiddle = middleOf(pair);
    await film.drag(middle.x - pairMiddle.x, middle.y - pairMiddle.y, 900);
    const zoom = Number((await page.locator('.zv').first().textContent())?.replace('%', '')) / 100;
    const factor = Math.min(0.88 * shape.viewport.width / pair.width, 0.5 * shape.viewport.height / pair.height, 1.6 / zoom);
    await film.glide(middle, 400);
    if (factor > 1.05) await film.wheelZoom(factor, 800);
    await film.hold(500);
    await still(page, shape.name, '2-close');
    await film.glide(middleOf(await around([development])), 600);
    film.mark('click on Development');
    await film.click();

    /* 3. Development open: its head in the middle, the people under it at work on named tasks or idle. */
    await film.until(async () => page.locator('.dview').isVisible());
    film.mark('Development open');
    await film.hold(500);
    const head = await around([page.locator('.dview').getByText('Dana', { exact: true }).first()]);
    const grab = { x: Math.round(shape.viewport.width * 0.5), y: Math.round(shape.viewport.height * 0.22) };
    const pull = { x: grab.x - middleOf(head).x, y: Math.round(shape.viewport.height * 0.3) - middleOf(head).y };
    if (Math.abs(pull.x) + Math.abs(pull.y) > 40) {
      await film.glide(grab, 500);
      await film.drag(pull.x, pull.y, 900);
    }
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } });
    await film.hold(1300);
    await still(page, shape.name, '3-department');

    /* Its time and progress: the Speed panel, where each agent's turn moves on as the clock does. */
    await film.glide(middleOf(await around([page.getByRole('button', { name: 'Speed', exact: true })])), 800);
    film.mark('Speed');
    await film.click();
    await film.until(async () => page.getByRole('complementary', { name: 'Speed', exact: true }).isVisible());
    await film.hold(800);
    for (const [index, taskId] of [[1, 't-226'], [2, 't-221']] as const) {
      const snap = snapshots[index]!;
      await page.clock.setSystemTime(new Date(snap.now));
      api.setOrg(snap.org);
      api.setTree(snap.tree);
      await pushStream(page, { type: 'task', id: taskId, spot: { departmentId: 'dept-dev' } });
      await pushStream(page, { type: 'org' });
      await film.hold(1100);
    }
    await still(page, shape.name, '4-speed');

    /* 4. The move to the tracker, where the same work stands as tasks. */
    film.mark('to the tracker');
    await film.glide(middleOf(await around([page.getByRole('button', { name: /^Tasks/ }).first()])), 900);
    await film.click();
    await film.until(async () => page.locator('.tracker').isVisible());
    film.mark('tracker');
    /* Park the pointer in the lower right margin before the tracker hold. */
    await film.glide({ x: shape.viewport.width - 32, y: Math.round(shape.viewport.height * 0.78) }, 400);

    /* 5. The tracker held still for 3 s. */
    film.mark('tracker held');
    await film.hold(3000);
    await still(page, shape.name, '5-tracker');

    watcher.assertClean();
    film.finish();
    await context.close();
  });
}
