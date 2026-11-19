import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CallMark, Org } from '../../src/types';
import { installSceneCursor, wordsUnderPointer } from '../moonfern/cursor';
import { Film, installFilmClock, settle, wheelZoomTo } from '../moonfern/film';
import { MOONFERN_PIPELINE } from '../moonfern/pipelines';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { MOONFERN_TURNS } from '../moonfern/tasks';
import { buildDevelopmentTreeSnapshots } from '../moonfern/tree';

/* The marketing cut of the company map, one continuous take of 10 to 30 s: Moonfern's map with its lines of work
   running; the pointer resting on Sam Rivera, who answers for Development, and clicking Development; its time in the Speed
   panel; its whole structure, stages with a square for each agent and a diamond for each one-shot call; back to the map,
   which ends in full motion. One take per post shape, at the pixel size the network shows, so nothing is scaled up or
   down afterwards: LinkedIn 4:5 at 1080x1350 (540x675 at a device scale of 2, the phone layout) and X 16:9 at 1920x1080
   (1280x720 at 1.5: from 761 to about 1000 CSS px wide the department's name runs into the tabs).

   The map is never smaller than 80%, so cards, names and task lines read on a phone: the take shows the part of the map
   that matters instead of all of it. overview is the map's size where it shows the orchestrator with Development and
   Marketing whole (on the phone layout 100% has no room for both), CLOSE its size at Development and Sam Rivera. */
const ALL_SHAPES = [
  { name: 'marketing-map-linkedin', viewport: { width: 540, height: 675 }, scale: 2, overview: 80 },
  { name: 'marketing-map-x', viewport: { width: 1280, height: 720 }, scale: 1.5, overview: 100 },
] as const;
const SHAPES = ALL_SHAPES.filter(shape => !process.env.MEDIA_SHAPE || shape.name === process.env.MEDIA_SHAPE);
const CLOSE = 100;

/* The build in the corner of the map: the 0.34.2 release whose screens the cut shows (main at c42c502b), not the older
   build the README scenes name. */
const RELEASE = { version: '0.34.2', commit: 'c42c502' };

/* Development with some agents at work on named tasks and some plainly idle, so the map and the department show both. */
const IDLE = new Set(['dev-perf', 'dev-8', 'dev-2', 'dev-4', 'dev-test']);

/* Its review is done by three one-shot calls and a judge call, the diamonds of its structure. */
const BETA_WAY = {
  ...MOONFERN_PIPELINE,
  stages: MOONFERN_PIPELINE.stages.map(stage => (stage.id === 's-review' ? { ...stage, oneShot: { fanOut: 3, judge: true } } : stage)),
};
type CallState = 'running' | 'waiting';
function reviewCalls(now: string, states: CallState[], judge?: CallState): CallMark[] {
  const startedAt = new Date(Date.parse(now) - 90_000).toISOString();
  const call = (number: number, isJudge: boolean, state: CallState): CallMark => ({
    id: `call-review-${isJudge ? 'judge' : number}`, number, judge: isJudge, task: 226, by: 'rev-codex', pipelineId: BETA_WAY.id, stage: 'review',
    startedAt: state === 'running' ? startedAt : null,
  });
  return [...states.map((state, i) => call(i + 1, false, state)), ...(judge ? [call(states.length + 1, true, judge)] : [])];
}

function seeded(org: Org, calls: CallMark[]): Org {
  return withCounts({
    ...org,
    departments: org.departments.map(d => d.id !== 'dept-dev' ? d : {
      ...d,
      pipelines: [BETA_WAY],
      calls,
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

function withCalls(base: Org, calls: CallMark[]): Org {
  return { ...base, departments: base.departments.map(d => (d.id === 'dept-dev' ? { ...d, calls } : d)) };
}

function withCounts(org: Org): Org {
  const departments = org.departments.map(d => ({ ...d, agents: { total: d.employees.length, working: d.employees.filter(e => e.status === 'working').length } }));
  return { ...org, departments, agents: { total: departments.reduce((s, d) => s + d.agents.total, 0), working: departments.reduce((s, d) => s + d.agents.working, 0) } };
}

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('a part of the take is not on the page');
  return box;
}

/* The box around a few things on the page, on screen or not. */
async function around(locators: Locator[]): Promise<Box> {
  const boxes = await Promise.all(locators.map(boxOf));
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
}

const middleOf = (box: Box): Point => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });

/* The part of the screen the map shows between the tabs above it and the orchestrator's line and the zoom below it. */
async function mapWindow(page: Page, viewport: { width: number; height: number }): Promise<Box> {
  const top = (await boxOf(page.locator('nav.tabs'))).y + (await boxOf(page.locator('nav.tabs'))).height;
  const bottom = Math.min((await boxOf(page.locator('.map .ticker'))).y, (await boxOf(page.locator('.map .zoom'))).y);
  return { x: 0, y: top, width: viewport.width, height: bottom - top };
}

/* A spot of bare map or bare department schema, where a press pulls the canvas and opens nothing, nearest the wanted one. */
async function bareSpot(page: Page, near: Point): Promise<Point> {
  const spot = await page.evaluate(({ x, y }) => {
    const bare = (px: number, py: number) => {
      const el = document.elementFromPoint(px, py);
      return !!el && ['map', 'dcanvas', 'world'].some(name => el.classList.contains(name));
    };
    for (let r = 0; r < 300; r += 6) {
      for (let a = 0; a < 360; a += 15) {
        const px = Math.round(x + r * Math.cos((a * Math.PI) / 180)), py = Math.round(y + r * Math.sin((a * Math.PI) / 180));
        if (bare(px, py) && bare(px + 20, py + 20) && bare(px - 20, py - 20) && bare(px + 20, py - 20) && bare(px - 20, py + 20)) return { x: px, y: py };
      }
    }
    return null;
  }, near);
  if (!spot) throw new Error('no bare map near the spot');
  return spot;
}

/* Before the take: the map at percent, zoomed with the wheel over bare map, and pulled by hand by `by`. */
async function zoomMap(page: Page, development: Locator, percent: number, at: Point) {
  const spot = await bareSpot(page, at);
  await page.mouse.move(spot.x, spot.y);
  await wheelZoomTo(page, percent, page.locator('.zv').first());
  await settle(page, development);
}

async function pullMap(page: Page, development: Locator, by: Point) {
  const from = await bareSpot(page, { x: 40, y: 200 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (by.x * i) / 10, from.y + (by.y * i) / 10);
  await page.mouse.up();
  await settle(page, development);
}

/* Stills of chosen moments for a person checking the cut by eye where no ffmpeg is at hand. */
async function still(page: Page, name: string, step: string) {
  const dir = process.env.MEDIA_STILLS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${step}.png` });
}

for (const shape of SHAPES) {
  /* Its own context: the size and scale of a take belong to the context, and the config's are the README's. */
  test(`${shape.name}: the map runs, the pointer rests on Sam Rivera and opens Development, its Speed and structure, then the map runs on`, async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const { viewport } = shape;
    const context = await browser.newContext({
      baseURL, viewport, deviceScaleFactor: shape.scale, locale: 'en', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    const tree = buildDevelopmentTreeSnapshots();
    const first = tree[0]!;
    const firstCalls = reviewCalls(first.now, ['running', 'running', 'waiting']);
    const snapshots = tree.map(snap => ({ ...snap, org: seeded(snap.org, firstCalls) }));
    await installFilmClock(page, first.now);
    const watcher = await prepareScenePage(page, first.now, 'en', 'cyberpunk');
    const api = await serveMoonfern(page, { initialOrg: snapshots[0]!.org, initialTree: first.tree });
    await page.route('**/api/version', route => route.fulfill({ json: RELEASE }));
    const film = new Film(page, shape.name, { x: Math.round(viewport.width * 0.82), y: Math.round(viewport.height * 0.7) });
    await installSceneCursor(page, film.pointer);

    /* A pause of the take: the pointer at rest covers no counter or name. */
    const rest = async (ms: number) => {
      const covered = await wordsUnderPointer(page, film.pointer);
      if (covered.length) throw new Error(`${shape.name}: the resting pointer at ${film.pointer.x},${film.pointer.y} covers ${JSON.stringify(covered)}`);
      await film.hold(ms);
    };

    await page.goto('/');
    await expect(page.locator('.hub')).toBeVisible();
    const development = page.getByRole('button', { name: /^Development/ });
    const sam = page.getByRole('button', { name: /Sam Rivera/ }).first();
    await expect(development).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    /* The map fits itself to the screen on its clock, which waits for the film: let it settle before the take. */
    await settle(page, development);
    await expect(page.getByText('Worker kinds')).toHaveCount(0);

    /* The map standing on the orchestrator with its lines of work going out to the departments on both sides where they
       fit whole, else to Development and Marketing. */
    const zoom = page.locator('.zv').first();
    const hub = page.locator('.hub');
    const marketing = page.getByRole('button', { name: /^Marketing/ });
    const maya = page.getByRole('button', { name: /Maya Chen/ }).first();
    const sides = [page.getByRole('button', { name: /^Operations/ }), page.getByRole('button', { name: /^Design/ }), development, marketing, sam];
    await zoomMap(page, development, shape.overview, { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) });
    const seen = await mapWindow(page, viewport);
    const middle = { x: Math.round(seen.x + seen.width / 2), y: Math.round(seen.y + seen.height / 2) };
    const overview = async (): Promise<Point> => {
      const all = await around([hub, maya, ...sides]);
      const at = middleOf(all.width <= seen.width - 24 ? all : await around([hub, maya, development, marketing]));
      return { x: middle.x - at.x, y: middle.y - at.y };
    };
    await pullMap(page, development, await overview());
    expect(Number((await zoom.textContent())?.replace('%', ''))).toBe(shape.overview);
    const corner = { x: Math.round(viewport.width * 0.8), y: Math.round(seen.y + seen.height * 0.9) };
    film.pointer = await bareSpot(page, corner);
    await page.mouse.move(film.pointer.x, film.pointer.y);

    /* 1. The map at rest, its lines running: work goes out to Development and comes back, and one more agent starts. */
    film.mark('map running');
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dsn' }, to: { kind: 'orchestrator' } });
    await rest(1000);
    const busier = withWorking(snapshots[0]!.org, ['ops-bugs', 'dev-8']);
    api.setOrg(busier);
    api.setTurns(MOONFERN_TURNS.map(u => (u.number === 6 ? { ...u, tasks: { total: 40, done: 25 } } : u)));
    await pushStream(page, { type: 'working', working: busier.agents.working });
    await pushStream(page, { type: 'task', id: 't-235', spot: { departmentId: 'dept-dev' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'person', id: 'p-maya' }, to: { kind: 'orchestrator' } });
    await pushStream(page, { type: 'org' });
    await rest(1200);
    await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dev' }, to: { kind: 'orchestrator' } });
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-mkt' } });
    await rest(1200);
    await still(page, shape.name, '1-map');

    /* 2. The pointer comes to Sam Rivera, who answers for Development: the map moves so he is in view, the pointer rests
       on his card below his name and title, then clicks Development. */
    film.mark('Sam Rivera');
    if (shape.overview !== CLOSE) {
      const near = await boxOf(development);
      await film.glide({ x: Math.round(near.x + near.width - 16), y: Math.round(near.y + near.height / 2) }, 500);
      await film.wheelZoomTo(CLOSE, zoom, 800);
    }
    const team = await around([development, sam]);
    const inView = team.x >= seen.x + 12 && team.x + team.width <= seen.x + seen.width - 12 && team.y >= seen.y + 12 && team.y + team.height <= seen.y + seen.height - 12;
    if (!inView) {
      const to = { x: middle.x - middleOf(team).x, y: Math.round(seen.y + seen.height * 0.42) - middleOf(team).y };
      await film.glide(await bareSpot(page, { x: middle.x, y: Math.round(seen.y + seen.height * 0.75) }), 400);
      await film.drag(to.x, to.y, 800);
    }
    await pushStream(page, { type: 'pulse', from: { kind: 'person', id: 'p-sam' }, to: { kind: 'department', id: 'dept-dev' } });
    const card = await boxOf(sam);
    await film.glide({ x: Math.round(card.x + 10), y: Math.round(card.y + card.height - 6) }, 600);
    await rest(900);
    await still(page, shape.name, '2-sam');
    film.mark('click on Development');
    const dev = await boxOf(development);
    await film.glide({ x: Math.round(dev.x + dev.width * 0.62), y: Math.round(dev.y + dev.height * 0.86) }, 600);
    await film.click();

    /* 3. Development open, and its time: the Speed panel, where each agent's turn moves on as the clock does. */
    await film.until(async () => page.locator('.dview').isVisible());
    film.mark('Development open');
    const speed = page.getByRole('button', { name: 'Speed', exact: true });
    await film.glide(middleOf(await boxOf(speed)), 1000);
    film.mark('Speed');
    await film.click();
    const panel = page.getByRole('complementary', { name: 'Speed', exact: true });
    await film.until(async () => panel.isVisible());
    const turnLine = await boxOf(panel.getByText(/^Turn 6, from/));
    await film.glide({ x: Math.round(Math.min(viewport.width - 40, turnLine.x + turnLine.width + 24)), y: Math.round(turnLine.y) }, 500);
    for (const [index, taskId] of [[1, 't-226'], [2, 't-221']] as const) {
      const snap = snapshots[index]!;
      await page.clock.setSystemTime(new Date(snap.now));
      api.setOrg(snap.org);
      api.setTree(snap.tree);
      await pushStream(page, { type: 'task', id: taskId, spot: { departmentId: 'dept-dev' } });
      await pushStream(page, { type: 'org' });
      await rest(1100);
    }
    await still(page, shape.name, '3-speed');

    /* 4. Its whole structure on the staff schema: the way every change goes, stage by stage, a square for each agent and a
       diamond for each one-shot call, the calls starting one after another. The hand pulls the schema along the way. */
    film.mark('structure');
    await film.glide(middleOf(await boxOf(panel.getByRole('button', { name: 'Close', exact: true }))), 500);
    await film.click();
    await film.until(async () => !(await panel.isVisible()));
    const schema = page.getByRole('region', { name: 'Department schema', exact: true });
    await expect(schema).toBeVisible();
    const area = await boxOf(schema);
    await film.glide(await bareSpot(page, { x: Math.round(area.x + area.width * 0.75), y: Math.round(area.y + area.height * 0.85) }), 500);
    await rest(400);
    const latest = snapshots[2]!;
    const review = schema.getByRole('group', { name: 'Review', exact: true });
    const call = middleOf(await boxOf(review));
    await film.drag(Math.round(area.x + area.width / 2 - call.x), Math.round(area.y + area.height * 0.4 - call.y), 1400);
    api.setOrg(withCalls(latest.org, reviewCalls(latest.now, ['running', 'running', 'running'])));
    await pushStream(page, { type: 'org' });
    await rest(800);
    api.setOrg(withCalls(latest.org, reviewCalls(latest.now, ['running', 'running', 'running'], 'waiting')));
    await pushStream(page, { type: 'org' });
    await rest(700);
    await expect(review.locator('.worker-mark[data-worker-kind="ghost"]')).toHaveCount(4);
    /* Whole on screen. The take's clock stands between frames, so the page's own visibility checks never run. */
    const shown = await boxOf(review);
    expect(shown.x >= area.x && shown.y >= area.y && shown.x + shown.width <= area.x + area.width && shown.y + shown.height <= area.y + area.height).toBe(true);
    await still(page, shape.name, '4-structure');
    /* On towards the end of the way, the later stages and the report to the head, as far as one pull from the right edge
       goes while the hand stays on the screen. It takes the schema just under the stage frames, clear of the header above
       and the zoom and buttons below, which stay where they are. */
    const right = await schema.locator('.frame').evaluateAll(frames => Math.max(...frames.map(f => f.getBoundingClientRect().right)));
    const grip = await bareSpot(page, { x: Math.round(area.x + area.width * 0.85), y: Math.round(shown.y + shown.height + 48) });
    await film.glide(grip, 400);
    await film.drag(Math.min(0, Math.max(Math.round(area.x + area.width - 24 - right), Math.round(area.x + 24 - grip.x))), 0, 1200);
    await rest(400);
    await still(page, shape.name, '5-structure-end');

    /* 5. Back to the map, which stands where it was and runs on: work goes out and comes back on every line in view. */
    film.mark('back to the map');
    await film.glide(middleOf(await boxOf(page.getByRole('button', { name: 'Back to the map', exact: true }))), 600);
    await film.click();
    await film.until(async () => !(await page.locator('.dview').isVisible()));
    /* The map stands again where it was, moving back on its own for 0.8 s, while the hand goes down to bare map; then it
       pulls the map back to the orchestrator and the departments around it. */
    await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } });
    await film.glide({ x: middle.x, y: Math.round(seen.y + seen.height * 0.75) }, 820);
    await film.glide(await bareSpot(page, film.pointer), 200);
    if (shape.overview !== CLOSE) await film.wheelZoomTo(shape.overview, zoom, 700);
    const pull = await overview();
    await film.glide(await bareSpot(page, film.pointer), 120);
    await film.drag(pull.x, pull.y, 900);
    await film.glide(await bareSpot(page, corner), 360);
    film.mark('map in motion');
    const busiest = withWorking(latest.org, ['ops-bugs', 'dev-8', 'dev-2', 'dev-4']);
    for (const [i, pulses] of [
      [{ from: { kind: 'department', id: 'dept-dev' }, to: { kind: 'orchestrator' } }, { from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-ops' } }],
      [{ from: { kind: 'person', id: 'p-maya' }, to: { kind: 'orchestrator' } }, { from: { kind: 'department', id: 'dept-dev' }, to: { kind: 'person', id: 'p-sam' } }],
      [{ from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } }, { from: { kind: 'department', id: 'dept-mkt' }, to: { kind: 'orchestrator' } }],
      [{ from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dsn' } }, { from: { kind: 'person', id: 'p-sam' }, to: { kind: 'department', id: 'dept-dev' } }],
      [{ from: { kind: 'department', id: 'dept-dev' }, to: { kind: 'orchestrator' } }, { from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } }],
    ].entries()) {
      for (const pulse of pulses) await pushStream(page, { type: 'pulse', ...pulse } as Parameters<typeof pushStream>[1]);
      if (i === 1) {
        api.setOrg(busiest);
        api.setTurns(MOONFERN_TURNS.map(u => (u.number === 6 ? { ...u, tasks: { total: 40, done: 26 } } : u)));
        await pushStream(page, { type: 'working', working: busiest.agents.working });
        await pushStream(page, { type: 'task', id: 't-221', spot: { departmentId: 'dept-dev' } });
        await pushStream(page, { type: 'org' });
      }
      await rest(900);
    }
    await still(page, shape.name, '6-map-end');

    watcher.assertClean();
    film.finish();
    await context.close();
  });
}
