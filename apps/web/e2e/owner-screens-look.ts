import type { Locator, Page } from '@playwright/test';

/* Design's rules for the screens a person who runs a department keeps (#989, #996), as what breaks them in a part as
   drawn: an empty list when all hold. danger: the names of the buttons that remove or turn off, which the part shows in
   pink at rest, last of their group; groups: the selector of the button groups that end at the end edge of their line. */
export type Words = { danger: string[]; groups: string };

export async function fieldsetFrameOffences(part: Locator): Promise<string[]> {
  return part.evaluate(root =>
    [...root.querySelectorAll('fieldset')].flatMap(set => {
      const box = set.getBoundingClientRect();
      const s = getComputedStyle(set);
      if (box.width * box.height === 0 || s.visibility === 'hidden') return [];
      const label = `fieldset "${set.textContent.trim().slice(0, 40)}"`;
      const framed = [s.borderTopWidth, s.paddingInlineStart, s.paddingInlineEnd].some(v => parseFloat(v) > 0);
      const host = set.parentElement!.getBoundingClientRect();
      const inset = Math.max(Math.abs(box.left - host.left), Math.abs(box.right - host.right)) > 1;
      return [...(framed ? [`6: ${label} keeps the browser's frame`] : []), ...(inset ? [`6: ${label} leaves its parent's edge`] : [])];
    }),
  );
}

export async function fieldsetHeadingOffences(part: Locator): Promise<string[]> {
  return part.evaluate(root =>
    [...root.querySelectorAll('fieldset > legend')].flatMap(legend => {
      const set = legend.parentElement!;
      const box = set.getBoundingClientRect();
      if (box.width * box.height === 0 || getComputedStyle(set).visibility === 'hidden') return [];
      const next = set.querySelector(':scope > legend ~ * > :first-child, :scope > legend + :not(div)');
      const gap = next ? next.getBoundingClientRect().top - legend.getBoundingClientRect().bottom : NaN;
      return !(Math.abs(gap - 4) <= 1) ? [`6: fieldset "${legend.textContent.trim().slice(0, 40)}" has ${Math.round(gap)}px under its heading`] : [];
    }),
  );
}

export async function offences(part: Locator, words: Words): Promise<string[]> {
  const base = await part.evaluate((root, words) => {
    const out: string[] = [];
    const css = (el: Element) => getComputedStyle(el) as CSSStyleDeclaration & { webkitAppearance?: string; MozAppearance?: string };
    const rect = (el: Element) => el.getBoundingClientRect();
    /* Whole pixels: Firefox lays out in sixtieths of a pixel, so 44 px can come as 43.99997. */
    const tall = (el: Element) => Math.round(rect(el).height);
    const shown = (el: Element) => rect(el).width > 0 && rect(el).height > 0 && css(el).visibility !== 'hidden';
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`;
    const look = (el: Element) => css(el).appearance || css(el).webkitAppearance || css(el).MozAppearance || '';
    const ink = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      root.append(probe);
      const color = css(probe).color;
      probe.remove();
      return color;
    };
    const rtl = css(root).direction === 'rtl';

    /* 1. Every control is a target of 44px: a button from 44 by 44, a field or a list exactly 44 high, a box's whole
       line from 44. A field in a frame with its button (a key, a search) is that frame. */
    const framed = '.keybox, .search';
    const wide = (el: Element) => Math.round(rect(el).width);
    for (const b of root.querySelectorAll('button'))
      if (shown(b) && !b.closest(framed) && (tall(b) < 44 || wide(b) < 44)) out.push(`1: ${name(b)} is ${wide(b)}x${tall(b)}px`);
    for (const f of root.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select'))
      if (shown(f) && !f.closest(framed) && tall(f) !== 44) out.push(`1: ${name(f)} is ${tall(f)}px high`);
    for (const frame of root.querySelectorAll(framed)) if (shown(frame) && (tall(frame) < 44 || tall(frame) > 46)) out.push(`1: ${name(frame)} is ${tall(frame)}px high`);
    for (const box of root.querySelectorAll('input[type=checkbox]')) {
      const line = box.closest('label');
      if (shown(box) && (!line || tall(line) < 44)) out.push(`1: the line of ${name(line ?? box)} is ${line ? tall(line) : 0}px high`);
    }

    /* 2. A group of buttons ends at the end edge of its line. */
    for (const group of root.querySelectorAll(words.groups)) {
      const buttons = [...group.children].filter(c => c.tagName === 'BUTTON' && shown(c)).map(rect);
      if (!buttons.length) continue;
      const short = rtl ? Math.min(...buttons.map(b => b.left)) - rect(group).left : rect(group).right - Math.max(...buttons.map(b => b.right));
      if (Math.abs(short) > 1) out.push(`2: ${name(group)} ends ${Math.round(short)}px before its end`);
    }

    /* 3. A button that removes or turns off says so at rest: pink words, no fill, the last of its group. */
    const pink = ink('var(--pink-ink)');
    const danger = [...root.querySelectorAll('button')].filter(b => words.danger.includes((b.textContent ?? '').trim()));
    if (words.danger.length && !danger.length) out.push('3: no button that removes');
    for (const b of danger) {
      if (css(b).color !== pink) out.push(`3: ${name(b)} is ${css(b).color}, not ${pink}`);
      if (css(b).backgroundColor !== 'rgba(0, 0, 0, 0)') out.push(`3: ${name(b)} is filled with ${css(b).backgroundColor}`);
      if (b.nextElementSibling?.tagName === 'BUTTON') out.push(`3: ${name(b)} is not the last of its group`);
    }

    /* 4. A box is drawn by us, the same in every browser: no look of the browser's, 16px square, a 1px frame, and ticked
       it takes the ink of a link. */
    const cyan = ink('var(--cyan-ink)');
    for (const box of root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      const s = css(box);
      if (look(box) !== 'none' || Math.round(rect(box).width) !== 16 || Math.round(rect(box).height) !== 16) out.push(`4: ${name(box)} is ${look(box)} ${rect(box).width}x${rect(box).height}`);
      if (s.borderTopStyle !== 'solid' || s.borderTopWidth !== '1px' || s.borderTopLeftRadius !== '0px') out.push(`4: ${name(box)} has the frame ${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopLeftRadius}`);
      if (box.checked && s.backgroundColor !== cyan) out.push(`4: ${name(box)} is ticked in ${s.backgroundColor}, not ${cyan}`);
    }

    /* 5. A number is typed as text: no arrows of the browser. */
    for (const field of root.querySelectorAll('input[type=number]')) if (look(field) !== 'textfield') out.push(`5: ${name(field)} keeps the look ${look(field)}`);
    return out;
  }, words);
  return [...base, ...(await fieldsetFrameOffences(part)), ...(await fieldsetHeadingOffences(part))];
}

/* The heights and widths of a part's pieces in whole pixels, to compare one browser with another. Each piece found by
   its selector; one found more than once is numbered. */
export async function sizes(part: Locator, pieces: Record<string, string>): Promise<Record<string, number>> {
  return part.evaluate((root, pieces) => {
    const out: Record<string, number> = {};
    const measure = (key: string, el: Element) => {
      const box = el.getBoundingClientRect();
      out[`${key} height`] = Math.round(box.height);
      out[`${key} width`] = Math.round(box.width);
    };
    measure('part', root);
    for (const [key, selector] of Object.entries(pieces)) {
      const found = [...root.querySelectorAll(selector)];
      found.forEach((el, i) => measure(found.length > 1 ? `${key} ${i + 1}` : key, el));
    }
    return out;
  }, pieces);
}

/* The focused control draws its ring of focus: the outline of the page, 2px of the ink of a link. */
export async function focusRing(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'nothing has focus';
    const s = getComputedStyle(el);
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--cyan-ink)';
    const cyan = getComputedStyle(probe).color;
    probe.remove();
    const got = `${s.outlineStyle} ${s.outlineWidth} ${s.outlineOffset} ${s.outlineColor}`;
    return got === `solid 2px 2px ${cyan}` ? 'ring' : `${el.tagName.toLowerCase()} has the outline ${got}`;
  });
}

/* Nothing of the page's own lies over a button: the mark of the version stands clear of every button it could cover. */
export async function markClear(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const mark = document.querySelector('.version-mark');
    if (!mark || getComputedStyle(mark).display === 'none') return [];
    const m = mark.getBoundingClientRect();
    return [...document.querySelectorAll('button')].flatMap(b => {
      const r = b.getBoundingClientRect();
      const over = r.width > 0 && r.left < m.right && m.left < r.right && r.top < m.bottom && m.top < r.bottom;
      return over ? [`the version mark lies over "${(b.textContent ?? '').trim()}"`] : [];
    });
  });
}

/* The section tabs on top: each whole inside the strip, no word cut by its edge, each a target of 44px. */
export async function tabsWhole(page: Page): Promise<string[]> {
  return page.locator('nav.tabs').evaluate(nav => {
    const strip = nav.getBoundingClientRect();
    return [...nav.querySelectorAll('button')].flatMap(b => {
      const r = b.getBoundingClientRect();
      const out: string[] = [];
      const word = (b.textContent ?? '').trim();
      if (r.left < strip.left - 1 || r.right > strip.right + 1) out.push(`"${word}" stands ${Math.round(r.left - strip.left)}…${Math.round(r.right - strip.left)} in a strip of ${Math.round(strip.width)}`);
      if (b.scrollWidth > b.clientWidth + 1) out.push(`"${word}" is wider than its tab`);
      if (Math.round(r.height) < 44) out.push(`"${word}" is ${Math.round(r.height)}px high`);
      return out;
    });
  });
}

/* A picture of the whole page for Design, in a window as tall as the page's longest scrolling part, so none of it scrolls
   away inside the page and no empty window lies below it, at the width it was laid out in; the window is given back as
   it was. */
export async function wholePage(page: Page, path: string): Promise<void> {
  const size = page.viewportSize()!;
  const tall = await page.evaluate(() => Math.max(innerHeight, ...[...document.querySelectorAll('*')].map(el => el.getBoundingClientRect().top + el.scrollHeight)));
  await page.setViewportSize({ width: size.width, height: Math.min(6000, Math.ceil(tall)) });
  await page.screenshot({ path, fullPage: true });
  await page.setViewportSize(size);
}

/* A picture of a piece with room around it, so a ring of focus drawn outside the piece shows whole. */
export async function around(page: Page, piece: Locator, path: string): Promise<void> {
  const box = (await piece.boundingBox())!;
  const width = page.viewportSize()!.width;
  const x = Math.max(0, box.x - 12);
  await page.screenshot({ path, clip: { x, y: Math.max(0, box.y - 12), width: Math.min(width, box.x + box.width + 12) - x, height: box.height + 24 } });
}
