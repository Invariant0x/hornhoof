import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { serveApi } from './api';
import { wholeTurn } from './whole-turn';

test.use({ video: { mode: 'on', size: { width: 1440, height: 1000 } } });

async function serveMotion(page: Page) {
  const { org, department, tree } = wholeTurn(true);
  org.orchestrator = { id: 'orchestrator', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null };
  org.workLines = [{ upstreamAgentId: 'orchestrator', downstreamAgentId: 'a0', working: true, workEpoch: 1, returnedEpoch: null, returnedAt: null }];
  department.workLines = [{ upstreamAgentId: 'a0', downstreamAgentId: 'a7', working: true, workEpoch: 1, returnedEpoch: null, returnedAt: null }];
  await serveApi(page);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const routes: Record<string, unknown> = {
      '/api/org': org, '/api/departments/d2/tree': { tree },
      '/api/version': { version: '0.5.0', commit: 'motion-check' },
      '/api/updates': { current: { version: '0.5.0', commit: 'motion-check' }, available: false, latest: null, updater: { status: null, waiting: null } },
    };
    return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
  });
  return () => { department.name = 'Development refreshed'; };
}

async function sample(page: Page, selector: string) {
  return page.locator(selector).evaluate(svg => {
    const el = svg as SVGSVGElement, dot = [...el.querySelectorAll<SVGCircleElement>('circle.pt')].at(-1)!;
    const matrix = dot.getCTM()!, motion = dot.querySelector<SVGAnimationElement>('animateMotion')!;
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    track.setAttribute('d', motion.getAttribute('path')!);
    return {
      time: el.getCurrentTime(), start: motion.getStartTime(), x: matrix.e, y: matrix.f,
      speed: track.getTotalLength() / motion.getSimpleDuration(), dots: el.querySelectorAll('circle.pt').length,
      dashes: [...el.querySelectorAll('.tr.live')].map(path => getComputedStyle(path).animationName),
      animations: document.getAnimations().filter(a => (a.effect as KeyframeEffect)?.target?.matches('.wires .tr.live'))
        .map(a => ({ time: a.currentTime as number, state: a.playState })),
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });
}

/* The dashes' animations on the live ways. */
const DASHES = '.wires .tr.live';

/* Holds the SVG's own clock and the dashes' animations, so only the test moves them and no check waits for time to pass. */
async function hold(page: Page, selector: string) {
  await page.locator(selector).evaluate((svg, dashes) => {
    (svg as SVGSVGElement).pauseAnimations();
    for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect)?.target?.matches(dashes)) a.pause();
  }, DASHES);
}

/* Moves the held clocks on by the given seconds. */
async function run(page: Page, selector: string, seconds: number) {
  await page.locator(selector).evaluate((svg, [dashes, s]) => {
    const el = svg as SVGSVGElement;
    el.setCurrentTime(el.getCurrentTime() + (s as number));
    for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect)?.target?.matches(dashes as string)) a.currentTime = (a.currentTime as number) + (s as number) * 1000;
  }, [DASHES, seconds] as const);
}

const looks = [
  { lang: 'en', theme: 'light', width: 1440 }, { lang: 'en', theme: 'dark', width: 375 },
  { lang: 'ru', theme: 'light', width: 375 }, { lang: 'ru', theme: 'dark', width: 1440 },
] as const;

for (const look of looks) {
  for (const reduce of [false, true]) {
    for (const view of ['map', 'department', 'tree'] as const) {
      test(`${view} signals, reduced ${reduce}, ${look.lang}, ${look.theme}, ${look.width}px`, async ({ page }, info) => {
        await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
        await page.setViewportSize({ width: look.width, height: 1000 });
        await page.addInitScript(look => {
          localStorage.setItem('hh-lang', look.lang);
          localStorage.setItem('hh-theme', look.theme);
        }, look);
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        const change = await serveMotion(page);
        await page.goto('/');
        if (view !== 'map') await page.getByRole('button', { name: look.lang === 'en' ? /^Development/ : /^Разработка/ }).click();
        if (view === 'tree') {
          await page.getByRole('button', { name: look.lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
          await page.locator('.tv-scroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
        }
        const selector = view === 'map' ? '.map svg.wires' : view === 'department' ? '.dcanvas svg.wires' : '.tv-in > svg';
        await expect(page.locator(`${selector} circle.pt`).first()).toBeAttached();
        const original = await page.locator(selector).evaluateHandle(svg => ({ svg, dot: [...svg.querySelectorAll('circle.pt')].at(-1), path: svg.querySelector('.tr.live, .seg.w') }));
        await hold(page, selector);
        const starting = await sample(page, selector);
        await run(page, selector, 0.5);
        const first = await sample(page, selector);
        expect([first.x, first.y], 'The signal must move as its clock goes before the redraw check').not.toEqual([starting.x, starting.y]);
        change();
        const refresh = page.waitForResponse(r => r.url().endsWith('/api/org'));
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await refresh;
        await expect(page.getByText('Development refreshed', { exact: true }).last()).toBeVisible();
        /* The held clocks go one second on past the redraw; screenshots can alter SMIL's timeline. Video records both samples. */
        await run(page, selector, 1);
        const second = await sample(page, selector);
        const evidence = info.outputPath('motion-clocks.json');
        await writeFile(evidence, JSON.stringify({ view, ...look, first, second, expectedSpeed: { map: 100, department: 160, tree: 60 }[view] / (reduce ? 4 : 1) }, null, 2));
        await info.attach('motion-clocks.json', { path: evidence, contentType: 'application/json' });
        expect(await original.evaluate(({ svg, dot, path }) => svg.isConnected && dot === [...svg.querySelectorAll('circle.pt')].at(-1) && path === svg.querySelector('.tr.live, .seg.w'))).toBe(true);
        expect(second.time - first.time).toBeGreaterThan(0.9);
        expect(second.start).toBe(first.start);
        expect([second.x, second.y]).not.toEqual([first.x, first.y]);
        expect(second.reduced).toBe(reduce);
        const speed = { map: 100, department: 160, tree: 60 }[view] / (reduce ? 4 : 1);
        expect(Math.abs(second.speed - speed) / speed).toBeLessThan(0.03);
        if (reduce) {
          expect(second.dashes.every(name => name === 'none')).toBe(true);
          expect(second.animations).toEqual([]);
        } else if (view !== 'tree') {
          expect(second.animations.length).toBeGreaterThan(0);
          /* The same held animations, one second on: the redraw started none of them over. */
          expect(second.animations).toEqual(first.animations.map(a => ({ ...a, time: a.time + 1000 })));
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }
}


test('starts a late message on arrival instead of at the SVG document start', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => { localStorage.setItem('hh-lang', 'en'); });
  await serveMotion(page);
  /* The page's timer that takes the message away after its trip waits for the test's clock. */
  const start = Date.parse('2026-11-09T10:00:00Z');
  await page.clock.install({ time: start });
  let sentAt = 0;
  await page.route('**/api/stream', async route => {
    const svg = page.locator('.map svg.wires');
    await expect(svg).toBeAttached();
    await page.clock.pauseAt(start + 60_000);
    /* The SVG's held clock goes past the message's 3.81-second trip before the message comes. */
    await hold(page, '.map svg.wires');
    await run(page, '.map svg.wires', 4.5);
    sentAt = await svg.evaluate(el => (el as SVGSVGElement).getCurrentTime());
    expect(sentAt).toBeGreaterThan(4.5);
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'd2' } }) + '\n\n' });
  });
  await page.goto('/');
  const motion = page.locator('.map svg.wires animateMotion[repeatCount="1"]');
  await expect(motion).toBeAttached();
  const read = () => page.locator('.map svg.wires').evaluate(svg => {
    const animation = svg.querySelector<SVGAnimationElement>('animateMotion[repeatCount="1"]');
    if (!animation) return null;
    let start: number;
    try { start = animation.getStartTime(); } catch { return null; }
    const matrix = (animation.parentElement as unknown as SVGCircleElement).getCTM()!;
    return { start, now: animation.getCurrentTime(), x: matrix.e, y: matrix.f };
  });
  await expect.poll(read, { message: 'A newly arrived message must have an active SVG interval' }).not.toBeNull();
  const first = (await read())!;
  expect(first.start).toBeGreaterThanOrEqual(sentAt - 0.05);
  await run(page, '.map svg.wires', 1);
  const second = await motion.evaluate(m => {
    const matrix = (m.parentElement as unknown as SVGCircleElement).getCTM()!;
    return { now: (m as SVGAnimationElement).getCurrentTime(), x: matrix.e, y: matrix.f };
  });
  expect([second.x, second.y]).not.toEqual([first.x, first.y]);
  const evidence = info.outputPath('late-message.json');
  await writeFile(evidence, JSON.stringify({ sentAt, first, second }, null, 2));
  await info.attach('late-message.json', { path: evidence, contentType: 'application/json' });
});
