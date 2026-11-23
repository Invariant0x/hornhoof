import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { PersonView } from '../src/types';
import { ASKED, FIVE, ONE, serveHubTurn, THREE, type Company } from './hub-turn-api';

test.use({ reducedMotion: 'reduce' });

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };

/* A department's card, by the start of its name; its strip, and the squares lit in it. */
const card = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
const bar = (page: Page, name: string) => card(page, name).locator('.dept-turn [role="progressbar"]');
const with_ = (company: Company, name: string, progress: [number, number]): Company => company.map(d => (d.name === name ? { ...d, progress } : d));

async function open(page: Page, lang: 'en' | 'ru', theme: string, width: number, start: Company = ONE, people: PersonView[] = []) {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  const failures: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  page.on('requestfailed', r => failures.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) failures.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const live = await serveHubTurn(page, start, people);
  await page.goto('/');
  await expect(page.locator('.hub')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { live, errors, failures };
}

/* Each strip and its counter fit their card on one line, every card holds what it shows, the tag on the hub stays inside its
   inner circle under the count, and the page never scrolls sideways. */
async function looksRight(page: Page) {
  const found = await page.evaluate(() => {
    const strips = [...document.querySelectorAll<HTMLElement>('.dept-turn')].map(s => {
      const card = s.closest<HTMLElement>('button.dept')!.getBoundingClientRect(), r = s.getBoundingClientRect();
      const head = s.querySelector<HTMLElement>('.dt-head')!;
      return {
        inside: r.left >= card.left && r.right <= card.right + 0.5 && r.top >= card.top && r.bottom <= card.bottom + 0.5,
        wide: s.scrollWidth <= s.clientWidth,
        oneLine: head.offsetHeight <= 16,
      };
    });
    const cards = [...document.querySelectorAll<HTMLElement>('button.dept .edge-in')].map(e => e.scrollHeight <= e.clientHeight && e.scrollWidth <= e.clientWidth);
    const hub = document.querySelector<HTMLElement>('.hub')!, tag = document.querySelector<HTMLElement>('.hub-focus-tag');
    let tagFits = true;
    if (tag) {
      const h = hub.getBoundingClientRect(), r = tag.getBoundingClientRect(), k = h.width / 240;
      const cx = h.left + h.width / 2, cy = h.top + h.height / 2;
      const corners = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];
      const num = document.querySelector<HTMLElement>('.hub-num')!.getBoundingClientRect();
      tagFits = corners.every(([x, y]) => Math.hypot(x! - cx, y! - cy) / k <= 88) && r.top >= num.bottom - 0.5;
    }
    return { strips, cards, tagFits, scroll: document.documentElement.scrollWidth <= innerWidth };
  });
  expect(found.strips.every(s => s.inside && s.wide && s.oneLine), JSON.stringify(found.strips)).toBe(true);
  expect(found.cards.every(Boolean), JSON.stringify(found.cards)).toBe(true);
  expect(found.tagFits).toBe(true);
  expect(found.scroll).toBe(true);
}

/* The hub's sectors, by the department each belongs to, with their classes. */
const sectors = (page: Page) => page.locator('.hub .turn-sec').evaluateAll(gs => gs.map(g => [g.getAttribute('data-dept'), g.getAttribute('class')]));

/* What a lit square, the strip's edge and a lit sector are painted with. */
const paints = (page: Page) =>
  page.evaluate(() => ({
    square: getComputedStyle(document.querySelector('.dept-sq i.on')!).backgroundColor,
    edge: getComputedStyle(document.querySelector('.dept-turn')!).borderLeftColor,
    arc: getComputedStyle(document.querySelector('.turn-sec-fill')!).stroke,
  }));

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375, 360]) {
      test(`each department working in the turn shows it in its card and on the hub in ${lang} ${theme} ${width}`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const label = (done: number) => t.map.readyForRelease(done);
        const shot = (name: string) => page.screenshot({ path: info.outputPath(`hub-${name}-${lang}-${theme}-${width}.png`), animations: 'disabled' });
        const { live, errors, failures } = await open(page, lang, theme, width);
        const initialDocument = await page.evaluateHandle(() => document);
        const hub = page.locator('.hub');
        const tag = hub.locator('.hub-focus-tag');

        /* One department works in the turn; Operations works all the time. */
        await expect(page.locator('.hub-turn')).toHaveCount(0);
        await expect(page.locator('.hub-lbl')).toHaveCount(0);
        const dev = bar(page, 'Development');
        await expect(dev).toHaveAttribute('aria-label', label(3));
        await expect(dev).toHaveAttribute('aria-valuenow', '18');
        await expect(dev.locator('i')).toHaveCount(20);
        await expect(dev.locator('i.on')).toHaveCount(4);
        await expect(card(page, 'Development').locator('.dt-turn')).toHaveText(t.tasks.turn(3));
        await expect(card(page, 'Development').locator('.dt-cnt')).toHaveText(label(3));
        await expect(card(page, 'Operations').locator('.dept-turn')).toHaveCount(0);
        await expect(hub.locator('.hub-hz')).toHaveAttribute('d', 'M 64 120 L 176 120');
        await expect(hub.locator('.hub-eq')).toHaveCount(1);
        await expect(hub.locator('.turn-sec')).toHaveCount(1);
        await expect(hub.locator('.turn-sec-bg')).toHaveAttribute('pathLength', '19.72');
        await expect(hub.locator('.turn-sec-fill')).toHaveAttribute('pathLength', '3.72');
        await expect(tag).toHaveText(t.tasks.turn(3));
        /* A card that works all the time keeps its task line right under its squares, as its neighbour does, with the room for
           a strip below it. */
        const underSquares = (name: string) => card(page, name).locator('.edge-in').evaluate(e => e.querySelector('.now')!.getBoundingClientRect().top - e.querySelector('.cells')!.getBoundingClientRect().bottom);
        expect(await underSquares('Operations')).toBeCloseTo(await underSquares('Development'), 1);
        const paint = await paints(page);
        expect(paint.square).toBe(paint.edge);
        expect(paint.arc).toBe(paint.edge);
        await looksRight(page);
        await shot('one');

        await expect(dev).toHaveAttribute('aria-valuenow', '18');

        /* Tasks close while the map is open. */
        await live.show(with_(ONE, 'Development', [4, 17]));
        await expect(dev).toHaveAttribute('aria-valuenow', '24');
        await expect(dev.locator('i.on')).toHaveCount(5);
        await live.show(with_(ONE, 'Development', [1000, 1000]));
        await expect(dev).toHaveAttribute('aria-label', label(1000));
        await expect(dev).toHaveAttribute('aria-valuenow', '100');
        await expect(dev.locator('i.on')).toHaveCount(20);
        await expect(hub.locator('.turn-sec-fill')).toHaveAttribute('pathLength', '19.72');
        await looksRight(page);

        /* Three departments work: three sectors in the order of the cards, and no sum of them at rest. */
        await live.show(THREE);
        await expect(hub.locator('.turn-sec')).toHaveCount(3);
        await expect(hub.locator('.turn-sec-sep')).toHaveCount(2);
        expect(await sectors(page)).toEqual([['d1', 'turn-sec'], ['d3', 'turn-sec'], ['d4', 'turn-sec']]);
        await expect(tag).toHaveCount(0);
        await expect(hub).not.toContainText('%');
        await looksRight(page);
        await shot('three');
        await card(page, 'Marketing').hover();
        await expect(tag).toHaveText(`CMO · ${t.tasks.turn(3)}`);
        expect(await sectors(page)).toEqual([['d1', 'turn-sec dim'], ['d3', 'turn-sec active'], ['d4', 'turn-sec dim']]);
        await looksRight(page);
        await page.mouse.move(0, 0);
        await expect(tag).toHaveCount(0);

        /* Five departments work; a card focused from the keyboard names its turn on the hub. */
        await live.show(FIVE);
        await expect(hub.locator('.turn-sec')).toHaveCount(5);
        await expect(hub.locator('.turn-sec-sep')).toHaveCount(4);
        await expect(page.locator('.dept-turn')).toHaveCount(5);
        await card(page, 'Development').focus();
        await expect(tag).toHaveText(`CTO · ${t.tasks.turn(3)}`);
        await looksRight(page);
        await shot('five');
        await card(page, 'Development').blur();
        await expect(tag).toHaveCount(0);

        /* The turn closes: the cards and the hub go back to how they were. */
        await live.closeTurn();
        await expect(page.locator('.dept-turn')).toHaveCount(0);
        await expect(hub.locator('.turn-sec, .hub-eq, .hub-focus-tag')).toHaveCount(0);
        /* All cards return to their resting height, including Development's card with 24 staff squares. A card is 160 px or, where
           the words of the card that needs the most are taller, as tall as they need (#1917): Development's two lines of squares
           and its two-line task need 161.08 px, a fresh page of the closed company needs the same, so all six stand at 161. Each
           card is left to its words for a moment and measured in whole pixels, as the layout does, with no strip of the turn in
           any of them; a card kept at the turn's height or grown by anything else is not this height. */
        await expect(card(page, 'Development').locator('.cells .cell')).toHaveCount(24);
        const rest = await page.locator('button.dept').evaluateAll(cards => {
          const boxes = cards as HTMLElement[];
          const set = boxes.map(c => c.style.height);
          for (const c of boxes) c.style.height = 'auto';
          const need = Math.max(...boxes.map(c => c.offsetHeight));
          boxes.forEach((c, i) => (c.style.height = set[i]!));
          return { set, need };
        });
        expect(rest.set).toEqual(Array(6).fill(`${Math.max(160, rest.need)}px`));
        await looksRight(page);
        await shot('closed');
        expect(await page.evaluate(initial => document === initial, initialDocument)).toBe(true);
        expect(errors).toEqual([]);
        expect(failures).toEqual([]);
      });
    }
  }
}

/* The tag that names the turn keeps the skin's own glow and accent ink, held to 4.5:1 on the inner circle it stands on and
   whole inside its box, in every built-in skin: while decisions wait for a whole-company person and the hub breathes amber,
   and while nothing waits. */
const STATES: [state: string, people: PersonView[]][] = [['while decisions wait', [ASKED]], ['while nothing waits', []]];

test.describe('the turn tag on the hub', () => {
  test.use({ reducedMotion: 'no-preference' });
  for (const [state, people] of STATES) {
    for (const skin of ['cyberpunk', 'light', 'matrix', 'pixel']) {
      test(`stays in the skin's colours and reads clearly in ${skin} ${state}`, async ({ page, browserName }, info) => {
        const waiting = people.length > 0;
        const { errors, failures } = await open(page, 'en', skin, 1440, ONE, people);
        const hub = page.locator('.hub');
        if (waiting) await expect(hub).toHaveClass(/\battn\b/);
        else await expect(hub).not.toHaveClass(/\battn\b/);
        await expect(hub.locator('.hub-focus-tag')).toHaveText(en.tasks.turn(3));
        await page.evaluate(async () => { await document.fonts.ready; });
        await hub.screenshot({ path: info.outputPath(`hub-tag-${waiting ? 'waiting' : 'calm'}-${skin}-${browserName}.png`), animations: 'disabled' });
        const found = await hub.evaluate(hub => {
          /* A token as the engine paints it, read off an element outside the hub. */
          const token = (property: 'color' | 'backgroundColor', value: string) => {
            const probe = document.body.appendChild(document.createElement('i'));
            probe.style[property] = value;
            const painted = getComputedStyle(probe)[property];
            probe.remove();
            return painted;
          };
          const parse = (value: string): number[] => {
            const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
            return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : [0, 0, 0, 0];
          };
          const over = (top: number[], under: number[]) => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!)).concat(1);
          const luminance = (c: number[]) => [0, 1, 2].map(i => c[i]! / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
          const box = hub.querySelector<HTMLElement>('.hub-focus-tag')!;
          const tag = getComputedStyle(box);
          const glow = getComputedStyle(hub, '::before');
          const ground = over(parse(tag.backgroundColor), parse(getComputedStyle(hub.querySelector('.hub-in')!).fill));
          const [a, b] = [luminance(over(parse(tag.color), ground)), luminance(ground)].sort((x, y) => y - x);
          return {
            background: tag.backgroundColor, skinGlow: token('backgroundColor', 'var(--glow)'), amber: token('backgroundColor', 'var(--amber)'),
            color: tag.color, ink: token('color', 'var(--cyan-ink)'),
            contrast: Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100,
            whole: box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight,
            /* The amber breath itself: its own layer, which animates only its opacity, and the ring around the hub. */
            breath: { glow: token('backgroundColor', glow.getPropertyValue('--glow')), animation: glow.animationName, ring: getComputedStyle(hub.querySelector('.hub-ring')!).stroke, amberStroke: token('color', 'var(--amber)') },
          };
        });
        expect(found.background, JSON.stringify(found)).toBe(found.skinGlow);
        expect(found.background).not.toBe(found.amber);
        expect(found.color).toBe(found.ink);
        expect(found.contrast, JSON.stringify(found)).toBeGreaterThanOrEqual(4.5);
        expect(found.whole).toBe(true);
        if (waiting) {
          expect(found.breath.glow).toBe(found.amber);
          expect(found.breath.animation).toBe('dglow');
          expect(found.breath.ring).toBe(found.breath.amberStroke);
        }
        await looksRight(page);
        expect(errors).toEqual([]);
        expect(failures).toEqual([]);
      });
    }
  }
});
