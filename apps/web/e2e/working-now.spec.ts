import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Employee, Org } from '../src/types';
import { taskRoute } from '../test/task-route';
import { ME, serveApi } from './api';

/* 20.11, Ivan's word (#1629): in the tracker one sees at once what is being worked on right now. Design's #1628, variant A
   (style book 1.6, section 4 "Working now"): the status dot of a task in work that an employee works on at this moment has
   a filled 6 px core in its ring's colour. With motion allowed only the core's top layer breathes, on the product's
   dbreathe (2.6 s), every dot in one phase taken from the wall clock; for a person who asked for less motion the core is
   full and still. Only that dot says "In work, working now" to a screen reader, and no dot has a title. The company's word
   of who works on what comes through a stand-in for the stream. */
test.describe.configure({ timeout: 0 });
const SHOTS = 'e2e/results/working-now-shots';
mkdirSync(SHOTS, { recursive: true });

/* dbreathe's period, and the core's weakest opacity per skin (spec sections 3 and 5). */
const PULSE_MS = 2600;
const LOW: Record<string, number> = { cyberpunk: 0.55, matrix: 0.55, pixel: 0.55, light: 0.8 };

type Lang = 'en' | 'ru';
type Look = { lang: Lang; theme: string; width: number };
const words = (lang: Lang) => (lang === 'en' ? en : ru);
const pathOf = (url: URL | string) => new URL(url.toString()).pathname;

/* An employee at work on task tN of the stand-in's turn, whose tasks are all in work. */
const worker = (n: number): Employee => ({
  id: `e${n}`, name: `Worker ${n}`, roleId: null, title: null, kind: 'worker', model: 'claude-opus-5-5', modelName: null, provider: null, effort: null,
  state: 'working', status: 'working', on: true, timer: null, task: { echelons: taskRoute(), id: `t${n}`, number: n, title: `Checkout step ${n}` },
  context: null, program: null, alarm: null, retry: null, failure: null,
});
/* The company with employees at work on the n newest tasks, which the list shows first: t30, t29 and on. */
const orgOf = (n: number): Org => ({
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: n, working: n },
  people: [],
  departments: [{
    id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: n, working: n }, products: [], teams: [], people: [], roles: [],
    employees: Array.from({ length: n }, (_, i) => worker(30 - i)),
  }],
});

type Opened = { set(n: number): Promise<void> };

/* The tracker's list of the department, with employees at work on the n newest tasks; set says the company changed, as the
   stream would, and the page reads the company again. */
async function openList(page: Page, look: Look, n: number): Promise<Opened> {
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    const streams: EventTarget[] = [];
    class Stream extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      constructor() { super(); streams.push(this); }
      close() { this.readyState = 2; }
    }
    Object.assign(window, { EventSource: Stream, hhSay: (data: string) => { for (const s of streams) s.dispatchEvent(new MessageEvent('message', { data })); } });
  }, look);
  await serveApi(page);
  let org = orgOf(n);
  await page.route(url => pathOf(url) === '/api/org', route => route.fulfill({ json: org }));
  await page.goto('/tasks?department=d2', { waitUntil: 'domcontentloaded' });
  await expect(dotOf(page, 1)).toBeAttached();
  await expect(page.locator('.tr-status-dot.now')).toHaveCount(n);
  /* The list's rows fade in as they come (#1613): what is measured and pictured is the list once that ended. */
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
  return {
    async set(next: number) {
      org = orgOf(next);
      await page.evaluate(data => (window as unknown as { hhSay(data: string): void }).hhSay(data), JSON.stringify({ type: 'reconnected' }));
      await expect(page.locator('.tr-status-dot.now')).toHaveCount(next);
    },
  };
}

const dotOf = (page: Page, n: number) => page.locator(`.tr-row[data-task="t${n}"] .tr-status-dot`).first();
const titleOf = (page: Page, n: number) => page.locator(`.tr-row[data-task="t${n}"] .tr-title`).first();

/* The breath of every dot held at one moment of its 2.6 s: 0 is the core at its weakest, 1300 at its strongest. */
const holdBreath = (page: Page, at: number) => page.evaluate(at => {
  for (const a of document.getAnimations()) if ((a as CSSAnimation).animationName === 'dbreathe') { a.pause(); a.currentTime = at; }
}, at);

/* What a layer of the dot draws. */
const layer = (dot: Locator, pseudo: '::before' | '::after') => dot.evaluate((el, pseudo) => {
  const s = getComputedStyle(el, pseudo);
  return { content: s.content, width: s.width, height: s.height, background: s.backgroundColor, opacity: s.opacity, animation: s.animationName, time: s.animationDuration };
}, pseudo);

const LOOKS: Look[] = [{ lang: 'en', theme: 'cyberpunk', width: 1440 }, { lang: 'ru', theme: 'light', width: 375 }];

test.describe('the status dot of a task an employee works on now', () => {
  for (const look of LOOKS) {
    test(`has a filled core in its ring's colour that breathes, and says so in one phrase with no title, ${look.theme} ${look.lang}`, async ({ page }) => {
      const t = words(look.lang);
      await openList(page, look, 1);
      const now = dotOf(page, 30), still = dotOf(page, 29);
      await expect(now).toHaveClass(/\bworking\b.*\bnow\b/);
      await expect(still).not.toHaveClass(/\bnow\b/);
      await expect(now).toHaveAttribute('aria-label', t.tracker.dot.workingNow);
      await expect(still).toHaveAttribute('aria-label', t.tracker.groups.working);
      await expect(page.locator('.tr-status-dot[title]')).toHaveCount(0);
      const ring = await now.evaluate(el => getComputedStyle(el).borderTopColor);
      expect(await layer(now, '::before')).toMatchObject({ width: '6px', height: '6px', background: ring, opacity: String(LOW[look.theme]) });
      expect(await layer(now, '::after')).toMatchObject({ width: '6px', height: '6px', background: ring, animation: 'dbreathe', time: '2.6s' });
      expect((await layer(still, '::before')).content).toBe('none');
    });
  }

  test('starts and stops breathing as the company says who works on what, with no reload', async ({ page }) => {
    const opened = await openList(page, LOOKS[0]!, 0);
    await page.evaluate(() => { (window as unknown as { kept: boolean }).kept = true; });
    await opened.set(1);
    await expect(dotOf(page, 30)).toHaveClass(/\bnow\b/);
    expect((await layer(dotOf(page, 30), '::after')).animation).toBe('dbreathe');
    await opened.set(0);
    await expect(dotOf(page, 30)).not.toHaveClass(/\bnow\b/);
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  });

  /* Spec section 6: a ripple down the list pulls the eye from the text; one shared phase reads as one quiet beat. */
  test('breathes every working-now dot in one phase on the wall clock, a dot that comes later too', async ({ page }) => {
    const opened = await openList(page, LOOKS[0]!, 15);
    const phases = () => page.evaluate(period => {
      const pulses = [...document.querySelectorAll('.tr-status-dot.now')].flatMap(dot => dot.getAnimations({ subtree: true }))
        .filter(a => (a as CSSAnimation).animationName === 'dbreathe');
      return { count: pulses.length, off: pulses.map(a => Math.abs((a.startTime as number) + (performance.timeOrigin % period))) };
    }, PULSE_MS);
    await expect.poll(async () => (await phases()).count).toBe(15);
    expect(Math.max(...(await phases()).off)).toBeLessThan(1);
    await opened.set(16);
    await expect.poll(async () => (await phases()).count).toBe(16);
    expect(Math.max(...(await phases()).off)).toBeLessThan(1);
  });

  test('holds still with a full core for a person who asked for less motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openList(page, LOOKS[0]!, 1);
    const now = dotOf(page, 30);
    expect(await now.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await layer(now, '::after')).toMatchObject({ width: '6px', opacity: '1', animation: 'none' });
    expect((await layer(now, '::before')).width).toBe('6px');
  });

  test('never moves the row: the dot and the title keep their boxes at the strongest, the weakest and for less motion', async ({ page }) => {
    await openList(page, LOOKS[0]!, 1);
    const boxes = async () => Promise.all([dotOf(page, 30), titleOf(page, 30), dotOf(page, 29)].map(async l => (await l.boundingBox())!));
    await holdBreath(page, PULSE_MS / 2);
    const peak = await boxes();
    await holdBreath(page, 0);
    const low = await boxes();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await boxes();
    for (const other of [low, still]) other.forEach((b, i) => {
      for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(b[side] - peak[i]![side])).toBeLessThanOrEqual(0.5);
    });
  });

  /* Spec section 9: the core at its weakest keeps 3:1 against the row, the row under the pointer and the open row. */
  for (const theme of Object.keys(LOW)) {
    test(`keeps 3:1 at its weakest against each ground it stands on, ${theme}`, async ({ page }) => {
      await openList(page, { lang: 'en', theme, width: 1440 }, 1);
      const seen = await dotOf(page, 30).evaluate(el => {
        const probe = document.createElement('i');
        document.body.append(probe);
        const colour = (value: string) => { probe.style.backgroundColor = value; return getComputedStyle(probe).backgroundColor; };
        const core = getComputedStyle(el, '::before');
        const found = { core: core.backgroundColor, low: Number(core.opacity), bg: colour('var(--bg)'), surface: colour('var(--surface)'), glow: colour('var(--glow)') };
        probe.remove();
        return found;
      });
      const rgba = (text: string) => { const [r, g, b, a = 1] = text.match(/[\d.]+/g)!.map(Number); return { r: r!, g: g!, b: b!, a }; };
      const over = (top: ReturnType<typeof rgba>, alpha: number, under: ReturnType<typeof rgba>) => ({ r: top.r * alpha + under.r * (1 - alpha), g: top.g * alpha + under.g * (1 - alpha), b: top.b * alpha + under.b * (1 - alpha), a: 1 });
      const light = (c: ReturnType<typeof rgba>) => [c.r, c.g, c.b].map(v => v / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const contrast = (a: ReturnType<typeof rgba>, b: ReturnType<typeof rgba>) => { const [x, y] = [light(a), light(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
      const bg = rgba(seen.bg), glow = rgba(seen.glow);
      const grounds = { bg, surface: rgba(seen.surface), selected: over(glow, glow.a, bg) };
      expect(seen.low).toBe(LOW[theme]);
      for (const [name, ground] of Object.entries(grounds)) expect(contrast(over(rgba(seen.core), seen.low, ground), ground), name).toBeGreaterThanOrEqual(3);
    });
  }
});

/* The pictures for Design (#1628): the list on a phone and a desktop in Cyberpunk, Light and Matrix, with one and with
   fifteen tasks worked on now, the breath held at its strongest and its weakest, and the still look for less motion. */
for (const theme of ['cyberpunk', 'light', 'matrix']) for (const width of [375, 1440]) for (const count of [1, 15]) {
  const name = `${theme}-${width}-${count}`;
  test(`pictures of the working-now dots ${name}`, async ({ page, browserName }) => {
    await openList(page, { lang: 'en', theme, width }, count);
    const shot = (state: string) => page.screenshot({ path: `${SHOTS}/${browserName}-${name}-${state}.png` });
    await holdBreath(page, PULSE_MS / 2);
    await shot('peak');
    await holdBreath(page, 0);
    await shot('low');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => (a as CSSAnimation).animationName === 'dbreathe').length)).toBe(0);
    await shot('reduced');
  });
}
