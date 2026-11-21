import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { BARS, BOTTOM_BLOCKS, CANVAS, CONTENT, HEIGHT, LOOKS, MESSAGES, named, open, SHELL_BARS, still, TOP_BLOCKS, VIEWS, WIDTHS } from './map-overlay-view';

/* Design's #1635, variant A, on the map and an open department (#1639). They lie under everything, from the top of the window
   to its bottom, and the menu, the bars of the shell and the bottom bar lie over them as separate glass blocks: the skin's
   --hud (.94), a 1 px --line frame, no blur, no shadow and no band between the blocks, so the map shows there. The chosen tab
   stands on an opaque backing. What the map and the department show starts 8 px under the last block at the top, and the
   department's name plate is one; it ends over the bottom bar, and as they open nothing stands under a block. A bar that comes
   or goes moves what stands under it in 200 ms ease-out, by transform only, and in one step for less motion. On a phone every
   bar after the first folds to one line with More. Design's check.js measures the same rules on its mockup. */
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
const underBlocks = (page: Page, selector: string) => page.evaluate(({ sel, blocks }) => {
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
}, { sel: selector, blocks: `${TOP_BLOCKS}, ${BOTTOM_BLOCKS}` });

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

    /* What it shows starts 8 px under the last block at the top: on a department its name plate, and its head card at least
       8 px under the plate (#1610). As it opens nothing stands under a block or nearer than 8 px to one. */
    const edges = await blockEdges(page);
    if (view === 'department') {
      const plate = await boxOf(page, '.dview .crumbs'), head = await boxOf(page, '.dview .shead');
      eightUnder(plate.y, edges.top, `the name plate starts 8 px under the last block's bottom at ${edges.top}, not at ${plate.y}`);
      expect(head.y, `the head card starts 8 px or more under the plate's bottom at ${plate.y + plate.height}, not at ${head.y}`).toBeGreaterThanOrEqual(plate.y + plate.height + 8 - 0.5);
    }
    expect(await underBlocks(page, CONTENT[view]), `nothing the ${view} shows stands under a block or nearer than 8 px as it opens`).toEqual([]);
    expect(errors).toEqual([]);
  });
}

/* The update's bar goes as its OK is pressed: it goes at once, and what stood under it slides up to 8 px under the menu in
   200 ms ease-out, the name plate and the department or the map by transform only. For less motion it takes its place in
   one step. */
for (const view of VIEWS) for (const width of WIDTHS) for (const motion of ['no-preference', 'reduce'] as const) {
  test(`what stands under a bar that goes slides up by transform in 200 ms ease-out${motion === 'reduce' ? ', in one step for less motion' : ''}: the ${view}, ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    const look = LOOKS[0]!;
    await open(page, look, width, BARS[1]!, view);
    const moved = view === 'map' ? '.map:not([inert]) .hub' : '.dview .shead';
    const watched = view === 'map' ? [moved] : ['.dview .crumbs', moved];
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

    /* Every frame until 1200 ms after the press: where each watched box stands, the top its style gives it, and each
       transition that moves it or what holds it, as property, length in ms and timing. A slow machine may take long to
       press, so the frames count from the press. */
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
        if (w.pressed_ === null || now - w.pressed_ < 1200) requestAnimationFrame(look);
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
    /* From the last frame before the press on. */
    const frames = all.slice(Math.max(0, all.findIndex(f => f.at > pressed) - 1));
    const moves = [...new Set(frames.flatMap(f => f.moves))];
    if (motion === 'reduce') expect(moves, 'nothing glides for less motion').toEqual([]);
    else expect(moves, 'what stands under the bar moves by transform in 200 ms ease-out, and by nothing else').toEqual(['transform 200ms ease-out']);

    for (const [i, sel] of watched.entries()) {
      const tops = frames.map(f => f.tops[i]!), first = tops[0]!, last = tops[tops.length - 1]!;
      expect(last, `${sel} moves up as the bar goes`).toBeLessThan(first - 8);
      expect(new Set(frames.map(f => f.styled[i])).size, `${sel} keeps its top: it moves by transform`).toBe(1);
      expect(tops.every((top, k) => k === 0 || top <= tops[k - 1]! + 0.5), `${sel} only moves up: ${tops.map(Math.round).join(' ')}`).toBe(true);
      const moving = frames.filter(f => Math.abs(f.tops[i]! - first) > 0.5 && Math.abs(f.tops[i]! - last) > 0.5);
      if (motion === 'reduce') {
        expect(moving.map(f => Math.round(f.tops[i]!)), `${sel} takes its place in one step`).toEqual([]);
        continue;
      }
      expect(moving.length, `${sel} slides through frames between its places`).toBeGreaterThan(0);
    }
    if (view === 'department') {
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
