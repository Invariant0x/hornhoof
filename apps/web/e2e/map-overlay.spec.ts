import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { BARS, BOTTOM_BLOCKS, CANVAS, CONTENT, HEIGHT, LOOKS, MESSAGES, named, open, SHELL_BARS, still, TOP_BLOCKS, VIEWS, WIDTHS } from './map-overlay-view';

/* Glass blocks over the map and open department (#1635, #1639) under Ivan's HUD overlay rule (#1874, #1882). The world
   always fills the viewport from top to bottom under the glass blocks (--hud .94, 1 px --line, no blur, no shadow, no band
   between blocks) and NEVER shifts or resizes when a shell bar appears or goes. Only department UI chrome (.crumbs) slides
   by transform in 200 ms ease-out (one step for reduced motion) so Back stays clear of bars. On a phone every bar after the
   first folds to one line with More. */
test.describe.configure({ timeout: 0 });

/* Each glass block that is not as Design draws it, and why: what it is, then what it has. */
const notGlass = (page: Page) => page.evaluate(bars => {
  const shell = document.querySelector('.shell')!;
  const probe = shell.appendChild(document.createElement('i'));
  probe.style.cssText = 'position: absolute; background-color: var(--hud); color: var(--line); border-top: 1px solid var(--surface);';
  const [hud, line] = [getComputedStyle(probe).backgroundColor, getComputedStyle(probe).color];
  probe.remove();
  const blocks = [...document.querySelectorAll<HTMLElement>(`.topbar .glass, ${bars}, .map > .glass, .map > .zoom, .dview .glass`)]
    .filter(e => e.getBoundingClientRect().width > 0);
  const wrong: string[] = [];
  for (const e of blocks) {
    /* A cell of a strip that is one glass block itself, as the department's tools on a phone: the strip is the block. */
    const strip = e.parentElement?.closest('.glass');
    if (strip && getComputedStyle(strip).display !== 'contents') continue;
    const s = getComputedStyle(e), name = `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
    const frame = (parseFloat(s.borderTopWidth) === 1 && s.borderTopStyle !== 'none' && s.borderTopColor === line)
      || (parseFloat(s.outlineWidth) === 1 && s.outlineStyle !== 'none' && s.outlineColor === line);
    const blur = s.backdropFilter && s.backdropFilter !== 'none' ? s.backdropFilter : (s as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
    if (s.backgroundColor !== hud) wrong.push(`${name}: background ${s.backgroundColor}, not --hud ${hud}`);
    if (s.boxShadow !== 'none') wrong.push(`${name}: shadow ${s.boxShadow}`);
    if (blur && blur !== 'none') wrong.push(`${name}: blur ${blur}`);
    if (!frame) wrong.push(`${name}: no 1 px --line frame`);
  }
  return { count: blocks.length, wrong };
}, SHELL_BARS);

/* Whether anything paints a band behind the blocks at the top: the header's own box and the page's room under it are clear,
   and in the gap between two blocks of the menu a click reaches the canvas. */
const bandAtTop = (page: Page, canvas: string) => page.evaluate(canvas => {
  const clear = (c: string) => c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
  const header = getComputedStyle(document.querySelector('.topbar')!), room = getComputedStyle(document.querySelector('main.body')!, '::before');
  const brand = document.querySelector('.tb-brand')!.getBoundingClientRect(), tabs = document.querySelector('.tabs')!.getBoundingClientRect();
  const [from, to] = brand.right < tabs.left ? [brand.right, tabs.left] : [tabs.right, brand.left];
  const hit = document.elementFromPoint((from + to) / 2, brand.top + brand.height / 2);
  return [
    ...(clear(header.backgroundColor) && header.backgroundImage === 'none' ? [] : [`the header paints ${header.backgroundColor} ${header.backgroundImage}`]),
    ...(clear(room.backgroundColor) && room.backgroundImage === 'none' ? [] : [`the room under the header paints ${room.backgroundColor}`]),
    ...(hit?.closest(canvas) ? [] : [`between the menu's blocks a click reaches ${hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : 'nothing'}, not the canvas`]),
  ];
}, canvas);

/* Where the last block at the top ends, and where the first along the bottom starts. */
const blockEdges = (page: Page) => page.evaluate(({ top, bottom }) => {
  const shown = (sel: string) => [...document.querySelectorAll(sel)].map(e => e.getBoundingClientRect()).filter(r => r.width && r.height);
  return { top: Math.max(...shown(top).map(r => r.bottom)), bottom: Math.min(innerHeight, ...shown(bottom).map(r => r.top)) };
}, { top: TOP_BLOCKS, bottom: BOTTOM_BLOCKS });

/* Every part of what the selector finds that shows in the window, clipped as the boxes around it clip it, and stands under a
   block or less than 8 px from one, at the top or along the bottom. */
const underBlocks = (page: Page, selector: string, includeShellBars = true) => page.evaluate(({ sel, blocks }) => {
  const over = [...document.querySelectorAll(blocks)].map(el => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width && r.height);
  const seen: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect();
    let [left, top, right, bottom] = [Math.max(r.left, 0), Math.max(r.top, 0), Math.min(r.right, innerWidth), Math.min(r.bottom, innerHeight)];
    for (let up = el.parentElement; up; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const c = up.getBoundingClientRect();
      [left, top, right, bottom] = [Math.max(left, c.left), Math.max(top, c.top), Math.min(right, c.right), Math.min(bottom, c.bottom)];
    }
    if (right - left < 1 || bottom - top < 1) continue;
    for (const { el: block, r: b } of over) {
      if (left < b.right - 0.5 && right > b.left + 0.5 && top < b.bottom + 7.5 && bottom > b.top - 7.5)
        seen.push(`${el.className.toString().split(' ')[0]} "${(el.textContent ?? '').trim().slice(0, 24)}" at ${Math.round(top)}–${Math.round(bottom)} near ${block.className.toString().split(' ')[0]} at ${Math.round(b.top)}–${Math.round(b.bottom)}`);
    }
  }
  return seen;
}, { sel: selector, blocks: `${includeShellBars ? TOP_BLOCKS : '.topbar > *'}, ${BOTTOM_BLOCKS}` });

/* Whether what starts at y starts 8 px under a block that ends at edge: rounded up to the whole pixel where a bar ends between
   two, as the shell measures it. */
const eightUnder = (y: number, edge: number, what: string) => {
  expect(y - (edge + 8), what).toBeGreaterThanOrEqual(-0.5);
  expect(y - (edge + 8), what).toBeLessThan(1);
};

const boxOf = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, `${selector} takes room on the page`).not.toBeNull();
  return found!;
};

for (const view of VIEWS) for (const bars of BARS) for (const width of WIDTHS) for (const look of LOOKS) {
  test(`the ${view} lies under glass blocks and opens 8 px clear of them with ${bars.name}, ${width}px ${named(look)}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await open(page, look, width, bars, view);

    /* The canvas, its dots and lines, runs from the top of the window to its bottom, under the blocks. */
    const canvas = await boxOf(page, CANVAS[view]);
    expect(canvas.y, `the ${view}'s canvas starts at the top of the window, not at ${canvas.y}`).toBeLessThanOrEqual(0.5);
    expect(canvas.y + canvas.height, `the ${view}'s canvas reaches the bottom of the window`).toBeGreaterThanOrEqual(HEIGHT - 0.5);
    expect(await bandAtTop(page, CANVAS[view]), 'nothing paints a band behind the blocks at the top').toEqual([]);

    /* Each block is glass: --hud, a 1 px --line frame, no shadow, no blur. */
    const glass = await notGlass(page);
    expect(glass.count, 'the menu, the bars and the bottom bar show as blocks').toBeGreaterThanOrEqual(4 + bars.count);
    expect(glass.wrong, 'every block is glass as Design draws it').toEqual([]);

    /* The chosen tab stands on an opaque backing: --glow over --surface. */
    const tab = await page.locator('.tabs button.on').evaluate(e => {
      const probe = document.querySelector('.shell')!.appendChild(document.createElement('i'));
      probe.style.backgroundColor = 'var(--surface)';
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const s = getComputedStyle(e);
      return { color: s.backgroundColor, image: s.backgroundImage, surface };
    });
    expect(tab.color, 'the chosen tab stands on --surface').toBe(tab.surface);
    expect(tab.image, 'with --glow laid over it').toContain('gradient');

    /* On a department its name plate starts 8 px under the last top block (so Back stays clickable). On both the map and
       a department, transient shell bars overlay the world as HUD without pushing or resizing the world (#1874). */
    const edges = await blockEdges(page);
    if (view === 'department') {
      const plate = await boxOf(page, '.dview .crumbs'), head = await boxOf(page, '.dview .shead');
      eightUnder(plate.y, edges.top, `the name plate starts 8 px under the last block's bottom at ${edges.top}, not at ${plate.y}`);
      if (bars.count === 0) expect(head.y, `the head card starts 8 px or more under the plate's bottom at ${plate.y + plate.height}, not at ${head.y}`).toBeGreaterThanOrEqual(plate.y + plate.height + 8 - 0.5);
    }
    expect(await underBlocks(page, CONTENT[view], false), `nothing the ${view} shows stands under the menu or bottom blocks as it opens`).toEqual([]);
    expect(errors).toEqual([]);
  });
}

/* When the update bar closes on OK: the bar disappears at once, the world (.map .hub or .dview .shead) stays completely
   stationary to the pixel (#1874, #1882), and only the department's UI chrome (.crumbs) slides up by transform in 200 ms
   ease-out (one step for reduced motion). */
for (const view of VIEWS) for (const width of WIDTHS) for (const motion of ['no-preference', 'reduce'] as const) {
  test(`closing the update bar leaves the world stationary while department chrome slides by transform${motion === 'reduce' ? ', in one step for less motion' : ''}: the ${view}, ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    const look = LOOKS[0]!;
    await open(page, look, width, BARS[1]!, view);
    const worldNode = view === 'map' ? '.map:not([inert]) .hub' : '.dview .shead';
    const watched = view === 'map' ? [worldNode] : ['.dview .crumbs', worldNode];
    if (view === 'department') {
      const plate = await page.locator('.dview .crumbs').evaluate(e => {
        const s = getComputedStyle(e);
        return { property: s.transitionProperty, duration: s.transitionDuration, timing: s.transitionTimingFunction };
      });
      if (motion === 'reduce') expect(plate.duration, 'the name plate takes its place in one step').toMatch(/^0s(, 0s)*$/);
      else {
        expect(plate.property, 'the name plate moves by transform').toContain('transform');
        expect(plate.property, 'and by nothing that lays the page out again').not.toMatch(/\b(?:top|inset|margin|all)\b/);
        expect(plate.duration).toBe('0.2s');
        expect(plate.timing).toBe('ease-out');
      }
    }

    type Frame = { at: number; tops: number[]; styled: string[]; moves: string[] };
    await page.evaluate(sel => {
      const w = window as unknown as { frames_: Frame[]; pressed_: number | null; done_: boolean };
      w.frames_ = [];
      w.pressed_ = null;
      w.done_ = false;
      document.addEventListener('click', () => { w.pressed_ ??= performance.now(); }, { capture: true, once: true });
      const look = () => {
        const now = performance.now(), els = sel.map(s => document.querySelector(s)!);
        const moves = document.getAnimations().filter((a): a is CSSTransition => a instanceof CSSTransition).flatMap(a => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          if (!target || !els.some(e => target === e || target.contains(e))) return [];
          const timing = a.effect!.getTiming();
          return [`${a.transitionProperty} ${Number(timing.duration)}ms ${getComputedStyle(target).transitionTimingFunction}`];
        });
        w.frames_.push({ at: now, tops: els.map(e => e.getBoundingClientRect().top), styled: els.map(e => getComputedStyle(e).top), moves });
        if (w.pressed_ === null || now - w.pressed_ < 600) requestAnimationFrame(look);
        else w.done_ = true;
      };
      requestAnimationFrame(look);
    }, watched);
    await page.locator(SHELL_BARS).getByRole('button', { name: en.updates.ok, exact: true }).click();
    await expect(page.locator(SHELL_BARS), 'the bar goes at once').toHaveCount(0);
    await page.waitForFunction(() => (window as unknown as { done_: boolean }).done_);
    const [all, pressed] = await page.evaluate(() => {
      const w = window as unknown as { frames_: Frame[]; pressed_: number };
      return [w.frames_, w.pressed_] as const;
    });
    await still(page);
    const frames = all.slice(Math.max(0, all.findIndex(f => f.at > pressed) - 1));
    const moves = [...new Set(frames.flatMap(f => f.moves))];

    /* The world node stays stationary to the pixel across every frame. */
    const worldIdx = watched.indexOf(worldNode);
    const worldTops = frames.map(f => f.tops[worldIdx]!);
    expect(Math.max(...worldTops) - Math.min(...worldTops), `${worldNode} stays stationary when the bar closes`).toBeLessThanOrEqual(0.5);

    if (view === 'map') {
      expect(moves, 'nothing on the map glides when the bar closes').toEqual([]);
    } else {
      if (motion === 'reduce') expect(moves, 'nothing glides for less motion').toEqual([]);
      else expect(moves, 'only the name plate moves by transform in 200 ms ease-out').toEqual(['transform 200ms ease-out']);
      const plateTops = frames.map(f => f.tops[0]!), first = plateTops[0]!, last = plateTops[plateTops.length - 1]!;
      expect(last, '.dview .crumbs moves up as the bar goes').toBeLessThan(first - 8);
      expect(new Set(frames.map(f => f.styled[0])).size, '.dview .crumbs keeps its top: it moves by transform').toBe(1);
      expect(plateTops.every((top, k) => k === 0 || top <= plateTops[k - 1]! + 0.5), '.dview .crumbs only moves up').toBe(true);
      const edges = await blockEdges(page), plate = await boxOf(page, '.dview .crumbs');
      eightUnder(plate.y, edges.top, `the plate ends 8 px under the menu at ${edges.top}, not at ${plate.y}`);
    }
  });
}

/* With two bars on a phone the second folds to one line with More, which opens it whole; on a wide screen each shows whole. */
for (const width of WIDTHS) for (const look of LOOKS) {
  test(`every bar after the first folds to one line with More on a phone, and More opens it: ${width}px ${named(look)}`, async ({ page }) => {
    const t = MESSAGES[look.lang];
    await open(page, look, width, BARS[3]!, 'department');
    const [first, second] = [page.locator(SHELL_BARS).nth(0), page.locator(SHELL_BARS).nth(1)];
    const more = (bar: typeof first) => bar.getByRole('button', { name: t.shell.barMore, exact: true });
    const lines = (bar: typeof first) => bar.evaluate(e => {
      const text = e.querySelector(':scope > span')!;
      return Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight));
    });
    /* Counted as they stand once still: with no time limit on a check (#59), a wait for none would never end. */
    expect(await more(first).count(), 'the first bar shows whole').toBe(0);
    if (width > 760) {
      expect(await more(second).count(), 'a wide screen folds no bar').toBe(0);
      return;
    }
    await expect(more(second)).toBeVisible();
    expect(await lines(second), 'the second bar takes one line').toBe(1);
    expect((await boxOf(page, `${SHELL_BARS} >> nth=1`)).height, 'one line and its button, no more').toBeLessThanOrEqual(64);
    await more(second).click();
    await expect(second.getByRole('button', { name: t.shell.barMore, exact: true })).toHaveCount(0);
    await expect.poll(() => lines(second), 'More shows the whole bar').toBeGreaterThan(1);
    await still(page);
    const edges = await blockEdges(page), plate = await boxOf(page, '.dview .crumbs');
    eightUnder(plate.y, edges.top, `the plate follows to 8 px under the opened bar at ${edges.top}, not ${plate.y}`);
  });
}
