import { expect, test, type Page, type Request } from '@playwright/test';
import type { AgentCardView, EventView } from '../src/types';
import { chooseTerminal, serveApi } from './api';
import { bigCompany } from './big-company-api';
import { growth, installRenderProbe, listenersGrown, readListeners, readProbe, sendLiveApart, settled, type RenderProbe } from './render-probe';

const AT = '2026-11-14T18:00:00.000Z';
const COMPANY = bigCompany();
const ACTIVE_COMPANY = {
  ...COMPANY,
  workLines: COMPANY.departments.map(d => ({
    upstreamAgentId: 'a1',
    downstreamAgentId: d.employees[0]!.id,
    working: true,
    workEpoch: 1,
    returnedEpoch: null,
    returnedAt: null,
  })),
};
const DEPT = COMPANY.departments[0]!;
const HEAD = DEPT.employees[0]!;
const AGENT_IDS = COMPANY.departments.flatMap(d => d.employees.map(e => e.id));
const CYCLES = 10;

const HEAD_CARD: AgentCardView = {
  id: HEAD.id, currentTask: null, kind: 'head', name: HEAD.name,
  role: { id: HEAD.roleId ?? 'r0-head', title: { en: 'Head', ru: 'Глава' }, description: { en: '', ru: '' } },
  department: { id: DEPT.id, name: DEPT.name ?? 'Department 1' }, product: null, team: null, teams: [],
  model: 'claude-opus-5-5', effort: null, subscription: null, machine: null, state: 'working', retry: null, failure: null,
  skills: [], parts: [], raw: '', runsOn: [], changes: [], interrupted: [], timer: null,
  canEdit: true, canRemove: false,
};
const HEAD_EVENTS: EventView[] = [{ seq: 1, kind: 'text', data: { text: 'Working on it.' }, jobId: 'j1', person: null, at: AT }];
const HEAD_STATE = { ready: true, reason: null, busy: true, runningJobId: 'j1', queued: 0, terminal: true, canType: true, turnRefused: null };

/* The company of 120 agents, its head's window with a live terminal, and every request it makes counted by path. */
async function bigCompanyServer(page: Page, terminal = true): Promise<Map<string, number>> {
  const asked = new Map<string, number>();
  page.on('request', r => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/')) asked.set(path, (asked.get(path) ?? 0) + 1);
  });
  if (terminal) await chooseTerminal(page);
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: COMPANY }));
  await page.route('**/api/link', route => route.fulfill({ json: { domain: 'hornhoof.app', link: null } }));
  await page.route(`**/api/agents/${HEAD.id}`, route => route.fulfill({ json: HEAD_CARD }));
  await page.route(`**/api/agents/${HEAD.id}/events*`, route => route.fulfill({ json: { events: HEAD_EVENTS, state: HEAD_STATE } }));
  await page.routeWebSocket(`**/api/agents/${HEAD.id}/terminal*`, ws => {
    ws.onMessage(() => {});
    /* The session's lines come before word that the program runs, so a terminal with no loader has them. */
    ws.send(JSON.stringify({ type: 'ready', write: true, message: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'READY\r\n> ' }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
  });
  return asked;
}

const T0 = Date.parse(AT);

/* The page runs on the test's clock, paused from the start: its timers and frames, the guard's frame watch among them,
   move only when a step of this test moves them, by the same virtual milliseconds in every run and engine. */
async function onTestClock(page: Page) {
  await page.clock.install({ time: T0 });
  /* A minute on, past whatever real time went by since the clock was put in, so every run starts at the same moment. */
  await page.clock.pauseAt(T0 + 60_000);
}

/* How many requests of the page are on their way, the stream that never answers left aside. */
function requestsOnTheirWay(page: Page): () => number {
  const open = new Set<Request>();
  page.on('request', r => {
    if (!r.url().endsWith('/api/stream')) open.add(r);
  });
  page.on('requestfinished', r => open.delete(r));
  page.on('requestfailed', r => open.delete(r));
  return () => open.size;
}

/* The head's window opens from its department with its terminal, as the person last chose, and closes, back to the map. */
async function windowCycle(page: Page) {
  await page.locator('.map .dept').first().click();
  await page.locator('button.shead').click();
  const window = page.locator('aside.orch');
  await expect(window).toBeVisible();
  await expect(window.locator('.t-load')).toHaveCount(0);
  /* xterm writes and draws on timers and frames: six frames of the test's clock. */
  await page.clock.runFor(100);
  await expect(window.locator('.xterm-rows')).toContainText('READY');
  await window.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(window).toHaveCount(0);
  /* The closed terminal goes on the next frame and a timer after it. */
  await page.clock.runFor(50);
  await page.getByRole('button', { name: 'Back to the map' }).click();
  await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
}

/* Settings open from the account menu and close. */
async function formCycle(page: Page) {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

/* The map goes away for the tasks and comes back with all 12 departments. */
async function mapCycle(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.locator('.map')).toHaveCount(0);
  await nav.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
}

/* Nothing is left to happen: what the page waits for within two seconds of its clock ran, and no request is on its way. */
async function quiet(page: Page, onTheirWay: () => number) {
  for (let i = 0; i < 2; i++) {
    await expect.poll(onTheirWay).toBe(0);
    await page.clock.runFor(1000);
  }
  await expect.poll(onTheirWay).toBe(0);
}

/* A burst of the stream as 120 working agents make it in a moment: context bars, states, tasks, questions, the company. */
const burst = (): unknown[] => [
  ...AGENT_IDS.map((agentId, i) => ({ type: 'context', agentId, used: (i % 10) / 10 + 0.05 })),
  ...Array.from({ length: 60 }, (_, i) => ({ type: 'working', working: 40 + (i % 20) })),
  ...Array.from({ length: 40 }, () => ({ type: 'task' })),
  ...Array.from({ length: 40 }, () => ({ type: 'requests' })),
  ...Array.from({ length: 20 }, () => ({ type: 'org' })),
];

const report = (label: string, values: unknown) => {
  test.info().annotations.push({ type: label, description: JSON.stringify(values) });
};

test.describe('a 120-agent company in the browser', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('leaves nothing alive behind its windows, forms and map after ten rounds', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await onTestClock(page);
    await page.addInitScript(installRenderProbe);
    const onTheirWay = requestsOnTheirWay(page);
    await bigCompanyServer(page);
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
    /* One round first: what loads once, the code of a screen or a cache it fills, is no leak. */
    await windowCycle(page);
    await formCycle(page);
    await mapCycle(page);
    await quiet(page, onTheirWay);
    const before = await readProbe(page);
    const listenersBefore = await readListeners(page);
    for (let i = 0; i < CYCLES; i++) {
      await windowCycle(page);
      await formCycle(page);
      await mapCycle(page);
    }
    await quiet(page, onTheirWay);
    const after = await readProbe(page);
    const grew = growth(before, after);
    report('baseline', before);
    report('after-10', after);
    report('growth', grew);
    report('listeners-grown', listenersGrown(listenersBefore, await readListeners(page)));
    expect(errors).toEqual([]);
    const held: Partial<RenderProbe> = {
      timeouts: grew.timeouts,
      frames: grew.frames,
      intervals: grew.intervals,
      resizeTargets: grew.resizeTargets,
      mutationObservers: grew.mutationObservers,
      globalListeners: grew.globalListeners,
      streams: grew.streams,
      sockets: grew.sockets,
      xterms: grew.xterms,
    };
    expect(held).toEqual({ timeouts: 0, frames: 0, intervals: 0, resizeTargets: 0, mutationObservers: 0, globalListeners: 0, streams: 0, sockets: 0, xterms: 0 });
    expect(grew.nodes).toBeLessThanOrEqual(0);
  });

  test('rides out a storm of the stream in a fraction of the renders and a few fetches of the company', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await onTestClock(page);
    await page.addInitScript(installRenderProbe);
    const onTheirWay = requestsOnTheirWay(page);
    const asked = await bigCompanyServer(page);
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
    await quiet(page, onTheirWay);
    const before = await readProbe(page);
    const orgBefore = asked.get('/api/org') ?? 0;
    const requestsBefore = asked.get('/api/requests') ?? 0;
    const messages = burst();
    await sendLiveApart(page, messages);
    await quiet(page, onTheirWay);
    const after = await readProbe(page);
    const storm = {
      messages: messages.length,
      commits: after.commits - before.commits,
      orgFetches: (asked.get('/api/org') ?? 0) - orgBefore,
      requestFetches: (asked.get('/api/requests') ?? 0) - requestsBefore,
    };
    report('storm', storm);
    expect(errors).toEqual([]);
    /* On the paused clock the first 30 messages come one by one and the rest at the stream's next hand-on, all at once:
       two requests of each go out at once and the rest of the burst is in their answers. */
    expect(storm.orgFetches).toBe(2);
    expect(storm.requestFetches).toBe(2);
    expect(storm.commits).toBeLessThanOrEqual(100);
  });

  test('animates the 120-agent map on composited layers only and pauses all of it behind a department', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await onTestClock(page);
    await page.addInitScript(installRenderProbe);
    const onTheirWay = requestsOnTheirWay(page);
    await bigCompanyServer(page);
    await page.route('**/api/org', route => route.fulfill({ json: ACTIVE_COMPANY }));
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(ACTIVE_COMPANY.departments.length);
    await quiet(page, onTheirWay);

    /* Every running animation on the map: SMIL clocks, CSS or Web Animations that paint or filter on the main thread,
       transforms on internal SVG children that have no compositor layer in WebKit, and composited opacity/transform layers. */
    const readMapMotion = () => page.evaluate(() => {
      const map = document.querySelector<HTMLElement>('.map')!;
      const meta = new Set(['offset', 'computedOffset', 'easing', 'composite']);
      const composited = new Set(['opacity', 'transform']);
      const running = map.getAnimations({ subtree: true }).filter(a => a.playState === 'running');
      let paint = 0;
      let svgChildTransform = 0;
      let compositedCount = 0;
      for (const anim of running) {
        const effect = anim.effect as KeyframeEffect | null;
        const target = effect?.target;
        const props = new Set(
          (effect?.getKeyframes() ?? []).flatMap(frame => Object.keys(frame).filter(k => !meta.has(k))),
        );
        if ([...props].some(p => !composited.has(p))) paint++;
        else if (props.has('transform') && target instanceof SVGElement && !(target instanceof SVGSVGElement)) svgChildTransform++;
        else compositedCount++;
      }
      const svgs = [...map.querySelectorAll('svg')];
      return {
        smil: map.querySelectorAll('animateMotion').length,
        paint,
        svgChildTransform,
        composited: compositedCount,
        running: running.length,
        dots: map.querySelectorAll('circle.pt').length,
        svgsPaused: svgs.length > 0 && svgs.every(s => s.animationsPaused?.() ?? true),
      };
    });

    const probeBefore = await readProbe(page);
    await page.clock.runFor(2000);
    const probeAfter = await readProbe(page);
    await page.evaluate(() => {
      for (const a of document.querySelector('.map')!.getAnimations({ subtree: true })) {
        if ('transitionProperty' in a) a.finish();
      }
    });
    const openMap = await readMapMotion();

    /* Stepping the map's running Web Animations by half a second moves the dots on the world without real-clock waits. */
    const movedDots = await page.evaluate(() => {
      const map = document.querySelector<HTMLElement>('.map')!;
      const world = map.querySelector<HTMLElement>('.world')!;
      const dots = [...map.querySelectorAll<SVGCircleElement>('circle.pt')];
      const anims = map.getAnimations({ subtree: true });
      for (const a of anims) a.pause();
      const at = () => {
        const w = world.getBoundingClientRect();
        return dots.map(d => {
          const r = d.getBoundingClientRect();
          return `${(r.left - w.left).toFixed(1)}:${(r.top - w.top).toFixed(1)}`;
        });
      };
      const before = at();
      for (const a of anims) a.currentTime = ((a.currentTime as number | null) ?? 0) + 500;
      const after = at();
      for (const a of anims) a.play();
      return dots.filter((_, i) => before[i] !== after[i]).length;
    });

    /* Opening a department flies into its card for 600 ms on the test's clock and covers the map, pausing all of it. */
    await page.locator('.map .dept').first().click();
    await page.clock.runFor(650);
    await expect(page.getByRole('region', { name: 'Department schema' })).toBeVisible();
    await page.evaluate(() => {
      for (const a of document.querySelector('.map')!.getAnimations({ subtree: true })) {
        if ('transitionProperty' in a) a.finish();
      }
    });
    const hiddenMap = await readMapMotion();

    await page.getByRole('button', { name: 'Back to the map' }).click();
    await quiet(page, onTheirWay);
    await page.evaluate(() => {
      for (const a of document.querySelector('.map')!.getAnimations({ subtree: true })) {
        if ('transitionProperty' in a) a.finish();
      }
    });
    const backOnMap = await readMapMotion();

    const summary = {
      openMap,
      idleCommits: probeAfter.commits - probeBefore.commits,
      movedDots,
      hiddenRunning: hiddenMap.running,
      hiddenSvgsPaused: hiddenMap.svgsPaused,
      resumedRunning: backOnMap.running,
    };
    report('map-motion', summary);

    expect(errors).toEqual([]);
    expect(openMap.dots).toBe(31);
    expect(openMap.smil).toBe(0);
    expect(openMap.paint).toBe(0);
    expect(openMap.svgChildTransform).toBe(0);
    expect(openMap.composited).toBeGreaterThanOrEqual(80);
    expect(summary.idleCommits).toBe(0);
    expect(movedDots).toBe(31);
    expect(hiddenMap.running).toBe(0);
    expect(hiddenMap.svgsPaused).toBe(true);
    expect(backOnMap.running).toBe(openMap.running);
  });

  /* Glass over the moving canvas has no blur under it, only the dense --hud of the skin. */
  for (const skin of ['cyberpunk', 'light', 'matrix', 'pixel']) {
    test(`draws the map and a department in ${skin} with glass that has no blur under it`, async ({ page }, info) => {
      await page.addInitScript(id => localStorage.setItem('hh-theme', id), skin);
      await bigCompanyServer(page);
      await page.goto('/');
      await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
      const blurred = () => page.evaluate(() => [...document.querySelectorAll('*')]
        .filter(el => [null, '::before', '::after'].some(pseudo => {
          const style = getComputedStyle(el, pseudo) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
          return (style.backdropFilter || style.webkitBackdropFilter || 'none') !== 'none';
        }))
        .map(el => el.className.toString()));
      expect(await blurred()).toEqual([]);
      await settled(page);
      await page.screenshot({ path: info.outputPath(`${skin}-map.png`) });
      await page.locator('.map .dept').first().click();
      await expect(page.getByRole('region', { name: 'Department schema' })).toBeVisible();
      expect(await blurred()).toEqual([]);
      await settled(page);
      await page.screenshot({ path: info.outputPath(`${skin}-department.png`) });
    });
  }

  /* The plate of a stopped block and the plate of the light mode, in Russian on Cyberpunk at 1440 px. On the
     paused clock 400 keys typed into the head's chat are 400 drawings of its window at one moment, past the guard's bar of
     300 in two seconds: the window stops behind its boundary and the page goes light. */
  test('shows the plates of a stopped block and of the light mode with their roles, words and 44 px buttons', async ({ page }, info) => {
    await onTestClock(page);
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'ru');
      localStorage.setItem('hh-theme', 'cyberpunk');
    });
    await bigCompanyServer(page, false);
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
    await page.locator('.map .dept').first().click();
    await page.locator('button.shead').click();
    const input = page.locator(`#input-${HEAD.id}`);
    await expect(input).toBeEnabled();
    await input.focus();
    await page.keyboard.type('x'.repeat(400));
    const stopped = page.getByRole('alert').filter({ hasText: 'Этот блок остановлен' });
    const light = page.getByRole('status').filter({ hasText: 'Эффекты выключены' });
    await expect(stopped).toHaveText('Этот блок остановлен: он мешал работе экрана.Перезапустить блок');
    await expect(light).toHaveText('Эффекты выключены, чтобы экран не тормозил.Вернуть эффекты');
    const restart = stopped.getByRole('button', { name: 'Перезапустить блок' });
    const effects = light.getByRole('button', { name: 'Вернуть эффекты' });
    for (const button of [restart, effects]) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    /* The second choice keeps its frame while the light mode takes every shadow away. */
    await expect(effects).toHaveCSS('border-top-width', '1px');
    await expect(effects).toHaveCSS('border-top-style', 'solid');
    await page.screenshot({ path: info.outputPath('cyberpunk-ru-stopped-block.png') });
    await restart.click();
    await expect(stopped).toHaveCount(0);
    await expect(page.locator('aside.orch')).toBeVisible();
    await expect(light).toBeVisible();
    await page.screenshot({ path: info.outputPath('cyberpunk-ru-light-mode.png') });
    await effects.click();
    await expect(light).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-light');
  });
});

