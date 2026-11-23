import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { Org } from '../src/types';
import { serveApi } from './api';
import { captureWith } from './capture';
import { LONG_HINT, wholeTextOrg, type Script } from './whole-text-data';

/* The department cards and people chips of the map, the head card, role frames and member chips of a department's screen,
   and the hint at its foot show every word: no ellipsis, no line clamp and no text cut off or standing out of its frame, in
   a long pseudo translation, Japanese and right to left as in English and Russian, on a wide screen and on a phone. Where
   the words fit the old boxes, the boxes keep their old sizes. Each check is soft, so a look goes through the map, the department and
   far zoom, takes every picture and fails at its end with every cut it found. The run that takes the pictures names its
   phase and folder in WHOLE_TEXT_PHASE and WHOLE_TEXT_SHOTS. */
test.describe.configure({ timeout: 0 });

type Look = { script: Script; lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; width: 1440 | 375 };
const LOOKS: Look[] = (['en', 'ru', 'pseudo', 'rtl', 'cjk'] as const).flatMap(script =>
  ([1440, 375] as const).map(width => ({ script, lang: script === 'ru' ? 'ru' : 'en', dir: script === 'rtl' ? 'rtl' : 'ltr', width })),
);
const shoot = captureWith(process.env.WHOLE_TEXT_PHASE ?? 'run', process.env.WHOLE_TEXT_SHOTS);

/* Where a text loses words: what cuts it and the start of the text. */
type Cut = { text: string; why: string };

/* Every text in each frame, checked against the frame and against every box on the way to it that clips: none may end
   in an ellipsis or be clamped, and every line of it stands inside them, within 1 px. */
async function cutTexts(page: Page, frames: string, texts: string): Promise<Cut[]> {
  return page.evaluate(({ frames, texts }) => {
    const cuts: Cut[] = [];
    const inside = (r: DOMRect, b: DOMRect) => r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    for (const frame of document.querySelectorAll<HTMLElement>(frames)) {
      for (const el of frame.querySelectorAll<HTMLElement>(texts)) {
        const text = (el.textContent ?? '').trim();
        /* What far zoom hides on purpose, the colours of a chip standing for it, is not text that was cut. */
        if (!text || getComputedStyle(el).visibility === 'hidden' || !el.getClientRects().length) continue;
        const cut = (why: string) => cuts.push({ text: `${el.className}: ${text.slice(0, 32)}`, why });
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        if (!lines.length) cut('no line of it is drawn');
        for (let box: HTMLElement | null = el; box; box = box === frame ? null : box.parentElement) {
          const style = getComputedStyle(box);
          if (style.textOverflow === 'ellipsis') cut(`text-overflow: ellipsis on ${box.className}`);
          const clamp = style.getPropertyValue('-webkit-line-clamp');
          if (clamp && clamp !== 'none') cut(`line clamp ${clamp} on ${box.className}`);
          const hides = style.overflowX !== 'visible' || style.overflowY !== 'visible';
          if (hides && (box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1)) cut(`${box.className} hides ${box.scrollWidth} by ${box.scrollHeight} in ${box.clientWidth} by ${box.clientHeight}`);
          if ((hides || box === frame) && lines.some(r => !inside(r, box!.getBoundingClientRect()))) cut(`a line stands out of ${box.className}`);
        }
      }
    }
    return cuts;
  }, { frames, texts });
}

/* The place of each element in the world of its canvas, as the layout set it, and its size as it is drawn there, in the
   layout's own pixels, so a zoom changes nothing. */
async function placed(page: Page, selector: string): Promise<{ x: number; y: number; w: number; h: number }[]> {
  return page.locator(selector).evaluateAll(all => all.map(el => {
    const box = el as HTMLElement;
    return { x: parseFloat(box.style.left), y: parseFloat(box.style.top), w: box.offsetWidth, h: box.offsetHeight };
  }));
}

/* The slot each card stands in, the head card's or a chip's, and how tall its words need it: its height and least height
   are left to its content for a moment, read in the layout's own pixels and given back before anything is drawn. */
async function wordsNeed(page: Page, cards: string): Promise<{ h: number; need: number }[]> {
  return page.locator(cards).evaluateAll(all => {
    const slots = all.map(card => (card.closest('.sslot') as HTMLElement | null) ?? (card as HTMLElement));
    const set = slots.map(slot => [slot.style.height, slot.style.minHeight] as const);
    const h = slots.map(slot => slot.offsetHeight);
    for (const slot of slots) Object.assign(slot.style, { height: 'auto', minHeight: '0' });
    const need = slots.map(slot => parseFloat(getComputedStyle(slot).height));
    slots.forEach((slot, i) => Object.assign(slot.style, { height: set[i]![0], minHeight: set[i]![1] }));
    return slots.map((_, i) => ({ h: h[i]!, need: need[i]! }));
  });
}

/* Boxes that hold words grow from their old height only as far as the words need: each holds all of its words, none is
   shorter than it always was, and the tallest is no taller than the most words need, within 1 px. */
async function grownOnlyForWords(page: Page, what: string, cards: string, old: number) {
  const boxes = await wordsNeed(page, cards);
  const most = Math.max(old, ...boxes.map(b => b.need));
  for (const b of boxes) expect.soft(b.h, `${what} holds all of its words`).toBeGreaterThanOrEqual(b.need - 1);
  for (const b of boxes) expect.soft(b.h, `${what} keeps at least its old height`).toBeGreaterThanOrEqual(old);
  expect.soft(Math.max(...boxes.map(b => b.h)), `${what} grows no taller than its words need`).toBeLessThanOrEqual(most + 1);
}

/* In each frame of a role, the next chip starts 12 px under the one above it, as in the mockup. */
async function chipGaps(page: Page): Promise<number[]> {
  return page.locator('.dview .frame').evaluateAll(frames => frames.flatMap(f => {
    const chips = [...f.querySelectorAll<HTMLElement>('.dept-chip')].map(c => ({ y: parseFloat(c.style.top), h: c.offsetHeight })).sort((a, b) => a.y - b.y);
    return chips.slice(1).map((c, i) => c.y - (chips[i]!.y + chips[i]!.h));
  }));
}

/* In each column of cards, the next card starts at least this far under the one above it. */
async function columnGaps(page: Page): Promise<number[]> {
  const cards = await placed(page, '.map .dept');
  const columns = new Map<number, typeof cards>();
  for (const c of cards) columns.set(c.x, [...(columns.get(c.x) ?? []), c]);
  return [...columns.values()].flatMap(col => col.sort((a, b) => a.y - b.y).slice(1).map((c, i) => c.y - (col[i]!.y + col[i]!.h)));
}

const overlap = (a: DOMRect | null, b: DOMRect | null) => !!a && !!b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

/* Zoomed all the way out by the zoom's button, then in by the wheel to the scale asked for, both about the middle of the
   canvas: the schema stays where Show everything put it, and the picture of far zoom shows it. */
async function zoomTo(page: Page, k: number) {
  await page.evaluate(k => {
    const out = document.querySelector<HTMLButtonElement>('.dview .zoom .zbtn')!;
    for (let i = 0; i < 20; i++) out.click();
    const canvas = document.querySelector<HTMLElement>('.dview .dcanvas')!;
    const at = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -Math.log(k / 0.15) / 0.0015, clientX: at.left + canvas.clientWidth / 2, clientY: at.top + canvas.clientHeight / 2, bubbles: true, cancelable: true,
    }));
  }, k);
  await expect(page.locator('.dview .zoom .zv')).toHaveText(`${Math.round(k * 100)}%`);
}

/* How tall a chip's name is drawn on the screen, its font by the scale of the view, and which lines of a chip that have
   words do not show. */
async function chipWords(page: Page): Promise<{ name: number; hidden: string[] }[]> {
  return page.locator('.dview .frame .schip').evaluateAll(chips => {
    const k = parseFloat(document.querySelector('.dview .zoom .zv')?.textContent ?? '') / 100;
    return chips.map(chip => {
      const name = chip.querySelector<HTMLElement>('.mn')!;
      const hidden = ['.mn', '.st', '.r2', '.r3'].filter(line => {
        const el = chip.querySelector<HTMLElement>(line);
        return !!el && !!(el.textContent ?? '').trim() && (getComputedStyle(el).visibility !== 'visible' || !el.getClientRects().length);
      });
      return { name: parseFloat(getComputedStyle(name).fontSize) * k, hidden: hidden.map(line => `${(name.textContent ?? '').slice(0, 16)}: ${line}`) };
    });
  });
}

/* The parts of the schema's boxes the hint stands over, where the canvas shows them. */
async function underHint(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hint = document.querySelector('.dview .ticker')?.getBoundingClientRect();
    const canvas = document.querySelector('.dview .dcanvas')!.getBoundingClientRect();
    if (!hint) return [];
    return [...document.querySelectorAll<HTMLElement>('.dview .shead, .dview .frame, .dview .dept-chip')].flatMap(box => {
      const r = box.getBoundingClientRect();
      const w = Math.min(r.right, canvas.right, hint.right) - Math.max(r.left, canvas.left, hint.left);
      const h = Math.min(r.bottom, canvas.bottom, hint.bottom) - Math.max(r.top, canvas.top, hint.top);
      return w > 1 && h > 1 ? [`${box.className.split(' ')[0]} ${(box.textContent ?? '').trim().slice(0, 24)}: ${Math.round(w)} by ${Math.round(h)} px`] : [];
    });
  });
}

/* How many lines of the hint show: those its boxes up to the hint itself do not clip. */
async function hintLines(page: Page): Promise<number> {
  return page.locator('.dview .ticker .tx').evaluate(el => {
    let bottom = Infinity;
    for (let box: HTMLElement | null = el as HTMLElement; box; box = box.classList.contains('ticker') ? null : box.parentElement) {
      if (getComputedStyle(box).overflowY !== 'visible') bottom = Math.min(bottom, box.getBoundingClientRect().bottom);
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0 && r.bottom <= bottom + 1).map(r => r.top);
    return tops.filter((top, i) => tops.findIndex(other => Math.abs(other - top) < 2) === i).length;
  });
}

/* Texts that would break a word with no hyphen: each breaks by the syllables of the page's language, with a hyphen, and a
   text with spaces never breaks anywhere in a word, which only a text with none, such as a key or an address, may. */
async function bareBreaks(page: Page, frames: string, texts: string): Promise<string[]> {
  return page.evaluate(({ frames, texts }) => [...document.querySelectorAll<HTMLElement>(frames)].flatMap(frame =>
    [...frame.querySelectorAll<HTMLElement>(texts)].flatMap(el => {
      const text = (el.textContent ?? '').trim();
      if (!text || !el.getClientRects().length) return [];
      const style = getComputedStyle(el);
      const hyphens = style.hyphens || style.getPropertyValue('-webkit-hyphens');
      const at = `${el.className}: ${text.slice(0, 24)}`;
      return [
        ...(hyphens === 'auto' ? [] : [`${at}: hyphens ${hyphens}`]),
        ...(/\s/.test(text) && (style.overflowWrap === 'anywhere' || ['break-all', 'break-word'].includes(style.wordBreak)) ? [`${at}: overflow-wrap ${style.overflowWrap}, word-break ${style.wordBreak}`] : []),
      ];
    }),
  ), { frames, texts });
}

/* Texts that wrap and leave one character alone on their last line, as a role broken 責任/者 (#1580). Each character's
   place is read where it is drawn, and a line begins where a character stands lower than the one before it. */
async function loneLastCharacters(page: Page, frames: string, texts: string): Promise<string[]> {
  return page.evaluate(({ frames, texts }) => [...document.querySelectorAll<HTMLElement>(frames)].flatMap(frame =>
    [...frame.querySelectorAll<HTMLElement>(texts)].flatMap(el => {
      const lines: string[] = [];
      let top = -Infinity;
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const text = node.textContent ?? '';
        for (let at = 0; at < text.length;) {
          const end = at + (text.codePointAt(at)! > 0xffff ? 2 : 1);
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, end);
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && text.slice(at, end).trim()) {
            if (r.top > top + r.height / 2) lines.push('');
            top = Math.max(top, r.top);
            lines[lines.length - 1] += text.slice(at, end);
          }
          at = end;
        }
      }
      return lines.length > 1 && [...lines[lines.length - 1]!].length === 1 ? [`${el.className}: ${lines.join(' / ')}`] : [];
    }),
  ), { frames, texts });
}

/* Role names that are letter-spaced on a right to left page, or in Arabic, Persian or Hebrew, where spacing tears joined
   letters apart: the page's language is set to each for a moment and given back. Only the style is read; how the fonts of
   a machine join letters is not judged. */
async function spacedRoles(page: Page, roles: string, rtl: boolean): Promise<string[]> {
  return page.evaluate(({ roles, rtl }) => {
    const root = document.documentElement, lang = root.lang;
    const spaced: string[] = [];
    const read = (where: string) => {
      for (const role of document.querySelectorAll<HTMLElement>(roles)) {
        const spacing = getComputedStyle(role).letterSpacing;
        if (spacing !== 'normal' && parseFloat(spacing) !== 0) spaced.push(`${where}: ${(role.textContent ?? '').trim().slice(0, 24)}: letter-spacing ${spacing}`);
      }
    };
    if (rtl) read('dir rtl');
    for (const other of ['ar', 'fa', 'he']) {
      root.lang = other;
      read(`lang ${other}`);
    }
    root.lang = lang;
    return spaced;
  }, { roles, rtl });
}

/* The room above the line of what the head does, in the layout's own pixels: from the end of the line before it to its
   top. */
async function roomAboveDoing(page: Page): Promise<number> {
  return page.locator('.dview .shead .hx').first().evaluate(hx => {
    const card = hx.closest('.shead') as HTMLElement;
    const scale = card.getBoundingClientRect().height / card.offsetHeight;
    return (hx.getBoundingClientRect().top - hx.previousElementSibling!.getBoundingClientRect().bottom) / scale;
  });
}

/* The same room on the head card of the English words, opened on a page of its own of the same width in the same browser. */
async function englishRoomAboveDoing(browser: Browser, app: string, width: number): Promise<number> {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 812 : 900 }, reducedMotion: 'reduce', timezoneId: 'UTC' });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
    await serve(page, wholeTextOrg('en'));
    await page.goto(app);
    await expect(page.locator('.map .dept')).toHaveCount(4);
    await page.locator('.map .dept').first().evaluate(card => (card as HTMLElement).click());
    await expect(page.locator('.dview .dcanvas')).toBeVisible();
    await settle(page);
    return await roomAboveDoing(page);
  } finally {
    await context.close();
  }
}

/* Words of a line that no element inside it isolates from the words around them, as <bdi> does. */
async function unisolated(page: Page, lines: string, words: string[]): Promise<string[]> {
  return page.locator(lines).evaluateAll((all, words) => all.flatMap(line => words.filter(word => {
    if (!(line.textContent ?? '').includes(word)) return false;
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (!(node.textContent ?? '').includes(word)) continue;
      for (let up = node.parentElement; up && up !== line; up = up.parentElement) if (['isolate', 'isolate-override', 'plaintext'].includes(getComputedStyle(up).unicodeBidi)) return false;
    }
    return true;
  })), words);
}

/* Every word of the head card, the role frames and the chips in its frame, each heading above its frame's first chip, one
   height for every chip, and the head card and chips of their old width. */
async function checkSchema(page: Page) {
  expect.soft(await cutTexts(page, '.dview .shead .edge-in', '.role, .hn, .meta, .st, .hx-task, .hc > span')).toEqual([]);
  expect.soft(await cutTexts(page, '.dview .frame', '.fn, .fa, .fc')).toEqual([]);
  expect.soft(await cutTexts(page, '.dview .schip .edge-in', '.mn, .st, .r2, .r3')).toEqual([]);
  const headings = await page.locator('.dview .frame').evaluateAll(frames => frames.map(f => {
    const fh = f.querySelector('.fh')!.getBoundingClientRect(), chip = f.querySelector('.dept-chip')?.getBoundingClientRect();
    return chip ? chip.top - fh.bottom : null;
  }));
  for (const room of headings) if (room !== null) expect.soft(room, 'a heading ends above its first chip').toBeGreaterThanOrEqual(-1);
  const chips = await placed(page, '.dview .frame .dept-chip');
  /* The head of Development's word for #1489: the chips of a department share one height, the one the most words need. */
  expect.soft(new Set(chips.map(c => c.h)).size, 'one height for every chip').toBe(1);
  expect.soft(chips.every(c => c.w === 240), 'the chips keep their width').toBe(true);
  for (const gap of await chipGaps(page)) expect.soft(Math.abs(gap - 12), 'chips of a frame stay 12 px apart').toBeLessThanOrEqual(1);
  await grownOnlyForWords(page, 'the head card', '.dview .shead', 184);
  await grownOnlyForWords(page, 'a chip', '.dview .frame .schip', 84);
  const head = await page.locator('.dview .shead').first().evaluate(card => {
    const slot = (card.closest('.sslot') as HTMLElement | null) ?? (card as HTMLElement);
    return { w: slot.offsetWidth, h: slot.offsetHeight };
  });
  expect.soft(head.w, 'the head card keeps its width').toBe(380);
  return { head, chips };
}

/* The people chips of the map, the whole-company row on top and the department people beside and under the cards: what
   each list is called, where it is, and the size of its chip before #1551. */
const PEOPLE_ROWS = [
  { what: 'a chip of the whole-company row', chips: '.map .chips > li', w: 160, h: 56 },
  { what: 'a department person\'s chip', chips: '.map .dept-chips > li', w: 156, h: 48 },
] as const;

/* The chips of a list that stand in one row, by the top they share, each row's heights. */
async function rowHeights(page: Page, chips: string): Promise<number[][]> {
  const rows = new Map<number, number[]>();
  for (const c of await placed(page, chips)) rows.set(c.y, [...(rows.get(c.y) ?? []), c.h]);
  return [...rows.values()];
}

/* Blocks of the map that stand over each other, in the layout's own pixels: people chips, department cards and the hub. */
async function overlaps(page: Page): Promise<string[]> {
  const boxes = await page.locator('.map .chips > li, .map .dept-chips > li, .map .dept, .map .hub').evaluateAll(all => all.map(el => {
    const box = el as HTMLElement;
    return { name: `${box.className || box.tagName} ${(box.textContent ?? '').trim().slice(0, 16)}`, x: parseFloat(box.style.left), y: parseFloat(box.style.top), w: box.offsetWidth, h: box.offsetHeight };
  }));
  return boxes.flatMap((a, i) => boxes.slice(i + 1).flatMap(b => (
    a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1 ? [`${a.name} over ${b.name}`] : []
  )));
}

/* The map zoomed by the wheel so that these chips stand in the middle of the screen at 100%, or as near to it as they
   all fit, for a picture in which their words read as a person reads them. A turn of the wheel zooms about the pointer, so
   the pointer stands where the middle of the chips comes to the middle of the screen. */
async function zoomToChips(page: Page, chips: string) {
  for (let turn = 0; turn < 2; turn++) {
    const done = await page.evaluate(chips => {
      const map = document.querySelector<HTMLElement>('.map')!;
      const rects = [...map.querySelectorAll(chips)].map(li => li.getBoundingClientRect());
      const world = map.querySelector<HTMLElement>('.world')!;
      const at = map.getBoundingClientRect();
      const k = world.getBoundingClientRect().width / world.offsetWidth;
      const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
      const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
      const goal = Math.min(1, ((at.width - 48) * k) / (right - left), ((at.height - 240) * k) / (bottom - top));
      const f = goal / k;
      /* Zooming by nothing moves nothing: the first turn steps out, the second comes to the goal. */
      if (Math.abs(f - 1) < 0.05) {
        map.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.log(2) / 0.0015, clientX: at.left, clientY: at.top, bubbles: true, cancelable: true }));
        return false;
      }
      const c = [(left + right) / 2, (top + bottom) / 2], v = [at.left + at.width / 2, at.top + at.height / 2];
      const [x, y] = [0, 1].map(i => (v[i]! - f * c[i]!) / (1 - f));
      map.dispatchEvent(new WheelEvent('wheel', { deltaY: -Math.log(f) / 0.0015, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      return true;
    }, chips);
    await settle(page);
    if (done) return;
  }
}

/* What floats over each canvas, the top bar and the department's name along its top, and the zoom, the line of what happened,
   the tools and Put back along its bottom; and the blocks that may not stand under any of it: cards and people chips. */
const FLOATING = {
  map: '.topbar > *, .map .zoom, .map > .ticker, .map-arrange',
  department: '.topbar > *, .dview .crumbs, .dview .zoom, .dview .ticker, .dview .dv-acts',
} as const;
const BLOCKS = {
  map: '.map .dept, .map .chips > li, .map .dept-chips > li',
  department: '.dview .shead, .dview .frame .dept-chip, .dview .pchip',
} as const;
type Screen = keyof typeof FLOATING;
const CANVAS: Record<Screen, string> = { map: '.map', department: '.dview .dcanvas' };
const EDGES = ['left', 'right', 'top', 'bottom'] as const;

/* What a person sees of each block: the part of it inside every box that clips it and inside the screen. Which blocks stand
   under something floating over the canvas, within 1 px, and which show whole and clear of all of it, by their order. */
async function inView(page: Page, screen: Screen): Promise<{ under: string[]; whole: number[] }> {
  return page.evaluate(({ blocks, floating }) => {
    const seen = (el: Element) => {
      const r = el.getBoundingClientRect();
      let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      const cut = (c: { left: number; top: number; right: number; bottom: number }) => {
        box = { l: Math.max(box.l, c.left), t: Math.max(box.t, c.top), r: Math.min(box.r, c.right), b: Math.min(box.b, c.bottom) };
      };
      for (let up = el.parentElement; up; up = up.parentElement) if (getComputedStyle(up).overflow !== 'visible') cut(up.getBoundingClientRect());
      cut({ left: 0, top: 0, right: innerWidth, bottom: innerHeight });
      return { box, r };
    };
    const over = [...document.querySelectorAll(floating)].map(el => ({ el, r: el.getBoundingClientRect() })).filter(f => f.r.width > 0 && f.r.height > 0);
    const name = (el: Element) => `${String(el.className).split(' ')[0]} "${(el.textContent ?? '').trim().slice(0, 16)}"`;
    const under: string[] = [], whole: number[] = [];
    [...document.querySelectorAll(blocks)].forEach((el, i) => {
      const { box: s, r } = seen(el);
      if (s.r - s.l <= 1 || s.b - s.t <= 1) return;
      const hit = over.filter(f => s.l < f.r.right - 1 && f.r.left < s.r - 1 && s.t < f.r.bottom - 1 && f.r.top < s.b - 1);
      under.push(...hit.map(f => `${name(el)} under ${name(f.el)}`));
      if (!hit.length && s.l <= r.left + 1 && s.r >= r.right - 1 && s.t <= r.top + 1 && s.b >= r.bottom - 1) whole.push(i);
    });
    return { under, whole };
  }, { blocks: BLOCKS[screen], floating: FLOATING[screen] });
}

/* The bare canvas a person's hand presses and drags by dx, dy: clear of cards, chips, the handles of lines and what floats
   over the canvas, where the drag stays on the part of the canvas the screen shows, as much of it as that lets. Whether the
   world moved. A press that moved nothing goes into pressed, and the next one stands somewhere else. */
async function dragBy(page: Page, screen: Screen, dx: number, dy: number, pressed = new Set<string>()): Promise<boolean> {
  const start = await page.evaluate(({ canvas, floating, dx, dy, pressed }) => {
    let box = document.querySelector(canvas)!.getBoundingClientRect();
    for (const room of document.querySelectorAll(`${canvas} > .map-room`)) box = room.getBoundingClientRect();
    const over = [...document.querySelectorAll(floating)].map(el => el.getBoundingClientRect());
    const busy = 'button, a, input, label, li, .dept, .chip, .hub, .shead, .sslot, .dept-chip, .pchip, .frame, .bend, [role="button"], [role="checkbox"]';
    const [left, top, right, bottom] = [Math.max(box.left, 0), Math.max(box.top, 0), Math.min(box.right, innerWidth), Math.min(box.bottom, innerHeight)];
    const reach = (from: number, by: number, start: number, end: number) => (by > 0 ? (end - 4 - from) / by : by < 0 ? (from - start - 4) / -by : 1);
    let best: { x: number; y: number; f: number } | null = null;
    for (let y = top + 6; y < bottom - 6; y += 10) {
      for (let x = left + 6; x < right - 6; x += 10) {
        if (over.some(r => x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) || pressed.includes(`${x},${y}`)) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !hit.closest(canvas) || hit.closest(busy)) continue;
        const f = Math.min(1, reach(x, dx, left, right), reach(y, dy, top, bottom));
        if (!best || f > best.f) best = { x, y, f };
      }
    }
    return best && best.f * Math.hypot(dx, dy) >= 20 ? best : null;
  }, { canvas: CANVAS[screen], floating: FLOATING[screen], dx, dy, pressed: [...pressed] });
  if (!start) return false;
  const world = page.locator(`${CANVAS[screen]} .world`);
  const before = await world.boundingBox();
  await page.evaluate(() => {
    const w = window as unknown as { __ev?: string[] };
    if (w.__ev) return;
    w.__ev = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dragstart', 'selectstart', 'lostpointercapture', 'gotpointercapture'])
      window.addEventListener(type, e => { if (w.__ev!.length < 40) w.__ev!.push(`${type}@${String((e.target as Element)?.className ?? e.target).slice(0, 24)}${(e as PointerEvent).clientX !== undefined ? `:${Math.round((e as PointerEvent).clientX)},${Math.round((e as PointerEvent).clientY)}` : ''}${e.defaultPrevented ? ' PREVENTED' : ''}`); }, true);
  });
  await page.evaluate(() => { (window as unknown as { __ev: string[] }).__ev.length = 0; });
  await page.mouse.move(start.x, start.y);
  const stack = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).slice(0, 6).map(e => `${e.tagName}.${String(e.className).slice(0, 24)}`).join(' > '), start);
  await page.mouse.down();
  await page.mouse.move(start.x + dx * start.f, start.y + dy * start.f, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  const after = await world.boundingBox();
  const moved = Math.abs(after!.x - before!.x) >= 0.5 || Math.abs(after!.y - before!.y) >= 0.5;
  if (!moved && screen === 'department') {
    const ev = await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev.join(' | '));
    console.log(`DEAD press ${start.x},${start.y} for ${Math.round(dx)},${Math.round(dy)} stack ${stack} world ${JSON.stringify(before)} events ${ev}`);
  }
  if (!moved) pressed.add(`${start.x},${start.y}`);
  return moved;
}

/* The canvas dragged towards one side until it moves no more: dragged to the right, its left edge comes into view. Whether it
   stopped, that is whether the canvas has that edge. */
async function scrollToEdge(page: Page, screen: Screen, edge: (typeof EDGES)[number]): Promise<boolean> {
  const [dx, dy] = ({ left: [320, 0], right: [-320, 0], top: [0, 320], bottom: [0, -320] } as const)[edge];
  for (let turn = 0; turn < 16; turn++) if (!(await dragBy(page, screen, dx, dy))) return true;
  return false;
}

/* The canvas dragged as a person brings one card or chip, by its order, to the middle of what the canvas shows: whether it
   then shows whole, clear of all that floats over it. A press that moves nothing at once is made again on other bare canvas,
   up to three times a turn: the canvas may have no edge there, and the place pressed may be none a drag takes hold of. */
async function scrollToBlock(page: Page, screen: Screen, i: number): Promise<boolean> {
  const pressed = new Set<string>();
  for (let turn = 0; turn < 8; turn++) {
    const [dx, dy] = await page.evaluate(({ blocks, canvas, i }) => {
      const r = document.querySelectorAll(blocks)[i]!.getBoundingClientRect();
      let room = document.querySelector(canvas)!.getBoundingClientRect();
      for (const inner of document.querySelectorAll(`${canvas} > .map-room`)) room = inner.getBoundingClientRect();
      const top = Math.max(room.top, 0), bottom = Math.min(room.bottom, innerHeight);
      return [(room.left + room.right) / 2 - (r.left + r.right) / 2, (top + bottom) / 2 - (r.top + r.bottom) / 2];
    }, { blocks: BLOCKS[screen], canvas: CANVAS[screen], i });
    if (Math.hypot(dx, dy) >= 1) {
      let moved = false;
      for (let tries = 0; tries < 3 && !moved; tries++) {
        const before = pressed.size;
        moved = await dragBy(page, screen, dx, dy, pressed);
        if (!moved && pressed.size === before) break;
      }
      if (!moved) break;
      pressed.clear();
    }
    if ((await inView(page, screen)).whole.includes(i)) return true;
  }
  return (await inView(page, screen)).whole.includes(i);
}

/* Where a phone's map cuts what it shows, against the bars as they stand now: its top 8 px under the lowest bar along the
   top, its bottom 8 px over the highest along the bottom, within 1 px, across the whole width in either direction. */
const CUTS = {
  map: { cut: '.map .map-room', top: '.topbar > *', bottom: '.map .zoom, .map > .ticker, .map-arrange', line: '.map > .ticker .tx' },
};
async function cutAt(page: Page, screen: keyof typeof CUTS) {
  return page.evaluate(({ cut, top, bottom }) => {
    const rects = (s: string) => [...document.querySelectorAll(s)].map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
    const c = document.querySelector(cut)!.getBoundingClientRect();
    return { top: c.top, bottom: c.bottom, left: c.left, right: c.right, width: innerWidth, under: Math.max(...rects(top).map(r => r.bottom)), over: Math.min(...rects(bottom).map(r => r.top)) };
  }, CUTS[screen]);
}

/* The head of Development's word for #1554: the cut follows the bars' real height, as measured, not a constant. As it stands
   and again after the line of what happened grows by a long text, the cut stands 8 px clear of the bars, and nothing stands
   under them. */
async function cutFollowsBars(page: Page, screen: keyof typeof CUTS) {
  const check = async (when: string) => {
    const at = await cutAt(page, screen);
    expect.soft(Math.abs(at.top - (at.under + 8)), `${screen}, ${when}: the cut stands 8 px under the bars along the top`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(at.bottom - (at.over - 8)), `${screen}, ${when}: the cut stands 8 px over the bars along the bottom`).toBeLessThanOrEqual(1);
    expect.soft([at.left, at.right], `${screen}, ${when}: the cut runs across the whole width`).toEqual([0, at.width]);
    expect.soft((await inView(page, screen)).under, `${screen}, ${when}: nothing under what floats over it`).toEqual([]);
    return at;
  };
  const before = await check('as it stands');
  await page.locator(CUTS[screen].line).first().evaluate((el, text) => { el.textContent = text; }, LONG_HINT);
  await settle(page);
  const after = await check('after the line grows');
  expect.soft(before.over - after.over, `${screen}: the line grew taller, so the check means something`).toBeGreaterThan(10);
}

/* The map's canvas as it opens, at each of its edges in turn, and then brought to each card and chip a person has not seen
   whole yet: nothing stands under what floats over it anywhere, it stops at every edge, and every card and chip shows whole. */
async function scrollsClear(page: Page, screen: 'map', shot: (where: string) => Promise<void>) {
  const all = await page.locator(BLOCKS[screen]).count();
  const whole = new Set<number>();
  const opened = await inView(page, screen);
  expect.soft(opened.under, `${screen}: nothing under what floats over it as it opens`).toEqual([]);
  opened.whole.forEach(i => whole.add(i));
  for (const edge of EDGES) {
    expect.soft(await scrollToEdge(page, screen, edge), `${screen}: the canvas stops at its ${edge} edge`).toBe(true);
    await shot(edge);
    const at = await inView(page, screen);
    expect.soft(at.under, `${screen}: nothing under what floats over it at the ${edge} edge`).toEqual([]);
    at.whole.forEach(i => whole.add(i));
  }
  for (let i = 0; i < all; i++) {
    if (whole.has(i)) continue;
    expect.soft(await scrollToBlock(page, screen, i), `${screen}: card or chip ${i} can be scrolled into view whole`).toBe(true);
    const at = await inView(page, screen);
    expect.soft(at.under, `${screen}: nothing under what floats over it, scrolled to card or chip ${i}`).toEqual([]);
    at.whole.forEach(j => whole.add(j));
  }
}

/* The department's canvas runs from the top of the window to its bottom, and the top bar, the department's name, the zoom, the
   line of what happened and the tools are glass blocks over it with no band of their own (#1635, variant A, which replaced
   #1556's band): the schema opens and fits clear of them, and what the person drags or zooms passes under the glass, so
   nothing is cut and a block of the schema may stand under a bar. What the canvas keeps is the room the bars leave the schema:
   dragged to an edge, the box of the schema stops there with its own edge on the room's, 8 px clear of the bars along the
   top or the bottom and 16 px in from the sides of the screen, within 1 px, as the bars stand now. */
const SCHEMA = { box: '.dview .dcanvas .world', top: '.topbar > *, .dview .crumbs', bottom: '.dview .dv-dock :is(.zoom, .ticker, .dv-acts)', line: '.dview .ticker .tx' };
async function schemaAt(page: Page) {
  return page.evaluate(({ box, top, bottom }) => {
    const rects = (s: string) => [...document.querySelectorAll(s)].map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
    const b = document.querySelector(box)!.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: innerWidth, under: Math.max(...rects(top).map(r => r.bottom)), over: Math.min(...rects(bottom).map(r => r.top)) };
  }, SCHEMA);
}

/* The schema dragged to one edge: whether it stops there, and where, against the room the bars leave it. */
async function schemaStopsAt(page: Page, edge: (typeof EDGES)[number], when: string) {
  expect.soft(await scrollToEdge(page, 'department', edge), `department, ${when}: the canvas stops at its ${edge} edge`).toBe(true);
  const at = await schemaAt(page);
  const room = { left: 16, right: at.width - 16, top: at.under + 8, bottom: at.over - 8 };
  expect.soft(Math.abs(at[edge] - room[edge]), `department, ${when}: the schema stops with its ${edge} edge at ${at[edge].toFixed(1)}, where the room the bars leave it ends, ${room[edge].toFixed(1)}`).toBeLessThanOrEqual(1);
  /* A schema smaller than its room on a side moves only inside it, and the stop means nothing there. */
  expect.soft(at.right - at.left > room.right - room.left && at.bottom - at.top > room.bottom - room.top, `department, ${when}: the schema is larger than its room, so the check means something`).toBe(true);
  return at;
}

/* The schema as it opens, at each of its edges in turn, and then brought to each card and chip a person has not seen whole
   yet: it stops at every edge on the room the bars leave it, and every card and chip shows whole, clear of all that floats
   over it, once the person brings it there, whatever passes under the glass on the way. */
async function schemaScrolls(page: Page, shot: (where: string) => Promise<void>) {
  const all = await page.locator(BLOCKS.department).count();
  const whole = new Set<number>();
  (await inView(page, 'department')).whole.forEach(i => whole.add(i));
  for (const edge of EDGES) {
    await schemaStopsAt(page, edge, 'as it opens');
    await shot(edge);
    (await inView(page, 'department')).whole.forEach(i => whole.add(i));
  }
  for (let i = 0; i < all; i++) {
    if (whole.has(i)) continue;
    expect.soft(await scrollToBlock(page, 'department', i), `department: card or chip ${i} can be scrolled into view whole`).toBe(true);
    (await inView(page, 'department')).whole.forEach(j => whole.add(j));
  }
}

/* The head of Development's word for #1554: the room follows the bars' real height, as measured, not a constant. As it stands
   and again after the line of what happened grows by a long text, the schema stops at every edge on the room the bars leave
   it, and the line, which grows up from the bottom, takes that much of the room at the bottom. */
async function schemaFollowsBars(page: Page) {
  const check = async (when: string) => {
    for (const edge of ['left', 'right', 'top'] as const) await schemaStopsAt(page, edge, when);
    return schemaStopsAt(page, 'bottom', when);
  };
  const before = await check('as it stands');
  await page.locator(SCHEMA.line).first().evaluate((el, text) => { el.textContent = text; }, LONG_HINT);
  await settle(page);
  const after = await check('after the line grows');
  expect.soft(before.over - after.over, 'department: the line grew taller, so the check means something').toBeGreaterThan(10);
}

/* The API fixture, the company of these words, and the version the app root asks for and the updates its shell asks for
   once, which the fixture does not answer. */
async function serve(page: Page, org: Org) {
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.34.4', commit: 'whole-text' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.34.4', commit: 'whole-text' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
}

/* Two frames after the fonts, so what measures the words has measured them. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
  });
}

for (const look of LOOKS) {
  const name = `${look.script}-${look.dir}-${look.width}`;
  test(`every word on the map's department cards, the department's cards and its hint: ${look.script}, ${look.dir}, ${look.width}px`, async ({ page, browser, browserName }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.setViewportSize({ width: look.width, height: look.width === 375 ? 812 : 900 });
    await page.addInitScript(({ lang, dir }) => {
      localStorage.setItem('hh-lang', lang);
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = dir; });
    }, look);
    await serve(page, wholeTextOrg(look.script));
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(4);
    await page.evaluate(d => { document.documentElement.dir = d; }, look.dir);
    await settle(page);
    if (browserName === 'chromium') await shoot(page, info, `map-${name}`);

    /* The map: every word of each card in its frame, one height for all cards, and the rows apart. */
    expect.soft(await cutTexts(page, '.map .dept .edge-in', '.dname, .cnt, .role, .detail, .now > span')).toEqual([]);
    const cards = await placed(page, '.map .dept');
    expect.soft(new Set(cards.map(c => c.h)).size, 'one height for every card of the map').toBe(1);
    expect.soft(cards.every(c => c.w === 280), 'the cards keep their width').toBe(true);
    for (const gap of await columnGaps(page)) expect.soft(gap, 'cards of a column stay apart').toBeGreaterThanOrEqual(32);
    if (look.script === 'en' || look.script === 'ru') expect.soft(cards[0]!.h, 'words that fit keep the old card').toBe(160);
    /* The Head of Design's word for #1489 (#1539, N4 and N5): the page names its language, words break by its syllables
       with a hyphen, and a role's name is not letter-spaced right to left or in Arabic, Persian or Hebrew. */
    expect.soft(await page.evaluate(() => document.documentElement.lang), 'the page names its language').toBe(look.lang);
    expect.soft(await bareBreaks(page, '.map .dept .edge-in', '.dname, .cnt, .role, .detail, .now > span'), 'words of the map break with a hyphen').toEqual([]);
    expect.soft(await spacedRoles(page, '.map .dept .role', look.dir === 'rtl'), 'role names of the map are not letter-spaced right to left').toEqual([]);

    /* The department: its head card, role frames and member chips, and the hint at its foot. */
    /* A card can stand under the top bar on a phone: it is pressed as a person's tap on it would press it. */
    await page.locator('.map .dept').first().evaluate(card => (card as HTMLElement).click());
    await expect(page.locator('.dview .dcanvas')).toBeVisible();
    await settle(page);
    /* As it opens, before any press, by the Head of Design's word for #1489 (#1539, N3 and N1): a chip's name is drawn at
       least 11 px tall and every line of every chip shows; a schema that does not fit is scrolled. */
    const opened = await chipWords(page);
    expect.soft(Math.min(...opened.map(c => c.name)), 'the department opens with chip names at least 11 px tall').toBeGreaterThanOrEqual(11);
    expect.soft(opened.flatMap(c => c.hidden), 'the department opens with every line of a chip showing').toEqual([]);
    await page.locator('.dview .zoom').getByRole('button', { name: look.lang === 'en' ? 'Show everything' : 'Показать все' }).click();
    const hint = page.locator('.dview .ticker .tx');
    await expect(hint).toBeVisible();
    if (look.script === 'pseudo') await hint.evaluate((el, text) => { el.textContent = text; }, LONG_HINT);
    await settle(page);
    if (browserName === 'chromium') await shoot(page, info, `department-${name}`);

    const { head, chips } = await checkSchema(page);
    const department = '.dview .dcanvas, .dview .ticker';
    expect.soft(await bareBreaks(page, department, '.role, .hn, .meta, .st, .hx-task, .hc > span, .fn, .fa, .fc, .mn, .r2, .r3, .tx'), 'words of the department break with a hyphen').toEqual([]);
    expect.soft(await spacedRoles(page, '.dview .role', look.dir === 'rtl'), 'role names of the department are not letter-spaced right to left').toEqual([]);
    if (look.dir === 'rtl') expect.soft(await unisolated(page, '.dview .shead .meta', ['Opus 5.5', 'default effort']), 'the head\'s role line isolates its model and effort').toEqual([]);
    /* The Head of Design's word for #1489 (#1539): the head card keeps the room above the line of what the head does as the
       English words have it, within 1 px, so a card that takes more lines grows by them. */
    if (look.script !== 'en') {
      const room = await roomAboveDoing(page), english = await englishRoomAboveDoing(browser, new URL('/', page.url()).href, look.width);
      expect.soft(Math.abs(room - english), `the room above what the head does, ${room.toFixed(1)} px, as in English, ${english.toFixed(1)} px`).toBeLessThanOrEqual(1);
    }
    /* English fits the old boxes, so the schema stands exactly as it did. Russian cuts the model line of a chip by about a
       pixel in 0.34.4: there the head card and the chips may grow a line, only as far as the words need (checked above for
       every look). */
    if (look.script === 'en') {
      expect.soft([head.h, chips[0]!.h], 'words that fit keep the old head card and chips').toEqual([184, 84]);
      expect.soft(chips.every(c => (c.y - 100) % 96 === 0), 'chips stand where they stood').toBe(true);
    }

    /* The hint stands whole on the screen, clear of the zoom and the tools. */
    const ticker = await page.locator('.dview .ticker').boundingBox();
    const view = page.viewportSize()!;
    expect.soft(ticker!.x >= -1 && ticker!.x + ticker!.width <= view.width + 1 && ticker!.y >= -1 && ticker!.y + ticker!.height <= view.height + 1, 'the hint stands on the screen').toBe(true);
    const rects = await page.evaluate(() => ['.dview .ticker', '.dview .zoom', '.dview .dv-acts'].map(s => document.querySelector(s)?.getBoundingClientRect().toJSON() as DOMRect | null));
    expect.soft(overlap(rects[0]!, rects[1]!) || overlap(rects[0]!, rects[2]!), 'the hint clear of the zoom and the tools').toBe(false);
    /* The Head of Design's word for #1489 (#1539, N2): the hint keeps its own room, so Show everything puts the schema
       clear of it, and it takes at most three lines; a longer one folds to three and unfolds whole (at the end). */
    expect.soft(await underHint(page), 'the hint stands over no part of the schema').toEqual([]);
    expect.soft(await hintLines(page), 'the hint takes at most three lines').toBeLessThanOrEqual(3);

    /* Zoomed far out, where chips show colours: no word is cut or runs over a chip, and, by the head of Development's word
       for #1489, role names keep their size and the layout holds as it stood. */
    await zoomTo(page, 0.4);
    await settle(page);
    if (browserName === 'chromium') await shoot(page, info, `department-far-${name}`);
    const far = await checkSchema(page);
    expect.soft(far.head, 'far zoom keeps the head card').toEqual(head);
    expect.soft(far.chips, 'far zoom moves no chip').toEqual(chips);

    /* Every word of the hint, unfolded by its own button where it folds. */
    const unfold = page.locator('.dview .ticker [aria-expanded="false"]');
    if (await unfold.count()) {
      await unfold.first().click();
      await settle(page);
    }
    expect.soft(await cutTexts(page, '.dview .ticker', '.tx')).toEqual([]);

    expect.soft(errors).toEqual([]);
  });

  /* The Head of Design's word for #1551: a people chip of the map takes its size from its words, which wrap and break by
     the syllables of the page's language, and every chip of a row is as tall as the one of the most words. Chips whose
     words fit keep their old boxes, and no chip comes over another or over a card. */
  test(`every word on the map's people chips, one height for a row: ${look.script}, ${look.dir}, ${look.width}px`, async ({ page, browserName }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.setViewportSize({ width: look.width, height: look.width === 375 ? 812 : 900 });
    await page.addInitScript(({ lang, dir }) => {
      localStorage.setItem('hh-lang', lang);
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = dir; });
    }, look);
    await serve(page, wholeTextOrg(look.script));
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(4);
    await expect(page.locator('.map .chips > li')).toHaveCount(3);
    await expect(page.locator('.map .dept-chips > li')).toHaveCount(6);
    await page.evaluate(d => { document.documentElement.dir = d; }, look.dir);
    await settle(page);

    const chips = '.map .chips .chip, .map .dept-chips .chip';
    expect.soft(await cutTexts(page, chips, 'b, small')).toEqual([]);
    expect.soft(await bareBreaks(page, chips, 'b, small'), 'words of the people chips break with a hyphen').toEqual([]);
    /* Japanese breaks at its phrases (#1580). Only Chromium finds them, with word-break: auto-phrase; Firefox and WebKit
       break between any two characters, and there the chips keep the checks above. */
    if (look.script === 'cjk' && browserName === 'chromium') expect.soft(await loneLastCharacters(page, chips, 'b, small'), 'no Japanese chip leaves one character alone on its last line').toEqual([]);
    for (const row of PEOPLE_ROWS) {
      for (const heights of await rowHeights(page, row.chips)) expect.soft(new Set(heights).size, `one height for the chips of a row: ${row.what}`).toBe(1);
      const boxes = await placed(page, row.chips);
      expect.soft(boxes.every(b => b.w === row.w), `${row.what} keeps its width`).toBe(true);
      await grownOnlyForWords(page, row.what, row.chips, row.h);
      if (look.script === 'en') expect.soft(boxes.map(b => b.h), `words that fit keep the old box: ${row.what}`).toEqual(boxes.map(() => row.h));
    }
    expect.soft(await overlaps(page), 'no chip over another or over a card').toEqual([]);
    expect.soft(await cutTexts(page, '.map .dept .edge-in', '.dname, .cnt, .role, .detail, .now > span'), 'the cards keep every word beside the chips').toEqual([]);

    await shoot(page, info, `map-people-${browserName}-${name}`);
    for (const [part, list] of [['top', '.chips > li'], ['departments', '.dept-chips > li']] as const) {
      await zoomToChips(page, list);
      await shoot(page, info, `map-people-near-${part}-${browserName}-${name}`);
    }
    expect.soft(await cutTexts(page, chips, 'b, small'), 'every word near').toEqual([]);

    expect.soft(errors).toEqual([]);
  });
}

/* The Head of Design's rule for #1539 (19.11), for #1554: on a phone the company map opens with a card's name drawn at least
   11 px tall in every language and scrolls; a department opens on its head card, centred on it at the top edge of the room
   under the top bar and its name. On both, no card or chip stands under what floats over the canvas, as it opens and at each
   edge it is scrolled to, and Show everything still shows the whole map. */
for (const look of LOOKS.filter(l => l.width === 375)) {
  const name = `${look.script}-${look.dir}-${look.width}`;
  const open = async (page: Page) => {
    await page.setViewportSize({ width: look.width, height: 812 });
    await page.addInitScript(({ lang, dir }) => {
      localStorage.setItem('hh-lang', lang);
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = dir; });
    }, look);
    await serve(page, wholeTextOrg(look.script));
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(4);
    await page.evaluate(d => { document.documentElement.dir = d; }, look.dir);
    await settle(page);
  };
  /* Pictures for Design: as it opens and after Show everything in every engine, at each edge in Chromium. */
  const pictures = (page: Page, info: TestInfo, browserName: string, what: string) => async (where: string) => {
    if (browserName !== 'chromium' && where !== 'open' && where !== 'all') return;
    await shoot(page, info, `${what}-${where}-${browserName}-${name}`);
  };
  const errorsOf = (page: Page) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text());
    });
    return errors;
  };

  test(`the map on a phone opens readable and scrolls to every card: ${look.script}, ${look.dir}`, async ({ page, browserName }, info) => {
    const errors = errorsOf(page);
    await open(page);
    const shot = pictures(page, info, browserName, `phone-map`);
    await shot('open');
    const names = await page.locator('.map .dept .dname').evaluateAll(all => {
      const world = document.querySelector<HTMLElement>('.map .world')!;
      const k = world.getBoundingClientRect().width / world.offsetWidth;
      return all.map(el => parseFloat(getComputedStyle(el).fontSize) * k);
    });
    expect.soft(Math.min(...names), 'the map opens with card names at least 11 px tall').toBeGreaterThanOrEqual(10.99);
    /* Design's note on #1596, for #1597: the name of every people chip in view as the map opens is as readable as a card's. */
    const chipNames = await page.locator('.map .chip b').evaluateAll(all => {
      const world = document.querySelector<HTMLElement>('.map .world')!, room = document.querySelector('.map .map-room')!.getBoundingClientRect();
      const k = world.getBoundingClientRect().width / world.offsetWidth;
      return all.filter(el => {
        const r = el.getBoundingClientRect();
        return r.bottom > room.top && r.top < room.bottom && r.right > room.left && r.left < room.right;
      }).map(el => parseFloat(getComputedStyle(el).fontSize) * k);
    });
    expect.soft(chipNames.length, 'the map opens with people chips in view').toBeGreaterThan(0);
    expect.soft(Math.min(...chipNames), 'the map opens with people chip names at least 11 px tall').toBeGreaterThanOrEqual(10.99);
    /* As in #1596: it opens centred across on the hub. */
    const across = await page.evaluate(() => {
      const hub = document.querySelector('.map .hub-art')!.getBoundingClientRect(), room = document.querySelector('.map .map-room')!.getBoundingClientRect();
      return Math.abs(hub.left + hub.width / 2 - (room.left + room.width / 2));
    });
    expect.soft(across, 'the map opens centred across on the hub').toBeLessThanOrEqual(1);
    await scrollsClear(page, 'map', shot);

    await page.locator('.map .zoom').getByRole('button', { name: look.lang === 'en' ? 'Show everything' : 'Показать все' }).click();
    await settle(page);
    await shot('all');
    const all = await inView(page, 'map');
    expect.soft(all.under, 'Show everything puts nothing under what floats').toEqual([]);
    expect.soft(all.whole.length, 'Show everything shows every card and chip whole').toBe(await page.locator(BLOCKS.map).count());
    await cutFollowsBars(page, 'map');
    expect.soft(errors).toEqual([]);
  });

  /* The department in English, Russian and the long pseudo translation, and, by the head of Development's word, right to left. */
  if (look.script === 'cjk') continue;
  test(`a department on a phone opens on its head card, stops at the room the bars leave it and brings every card clear of them: ${look.script}, ${look.dir}`, async ({ page, browserName }, info) => {
    const errors = errorsOf(page);
    await open(page);
    /* A card can stand under the top bar on a phone: it is pressed as a person's tap on it would press it. */
    await page.locator('.map .dept').first().evaluate(card => (card as HTMLElement).click());
    await expect(page.locator('.dview .dcanvas')).toBeVisible();
    await settle(page);
    const shot = pictures(page, info, browserName, `phone-department`);
    await shot('open');
    const at = await page.evaluate(() => {
      const box = (el: Element | null) => el!.getBoundingClientRect();
      const head = box(document.querySelector('.dview .shead')), canvas = box(document.querySelector('.dview .dcanvas'));
      const top = Math.max(...[...document.querySelectorAll('.topbar > *, .dview .crumbs')].map(box).filter(r => r.height > 0).map(r => r.bottom));
      return { middle: head.left + head.width / 2 - (canvas.left + canvas.width / 2), below: head.top - top, left: head.left, right: innerWidth - head.right };
    });
    expect.soft(Math.abs(at.middle), `the head card is centred, ${at.middle.toFixed(1)} px off`).toBeLessThanOrEqual(1);
    expect.soft(at.below, 'the head card stands under the department\'s name').toBeGreaterThanOrEqual(0);
    expect.soft(at.below, 'the head card stands at the top edge').toBeLessThanOrEqual(24);
    expect.soft(Math.min(at.left, at.right), 'the head card shows whole across the screen').toBeGreaterThanOrEqual(0);
    const head = await page.locator(BLOCKS.department).evaluateAll(all => all.findIndex(el => el.matches('.shead')));
    expect.soft((await inView(page, 'department')).whole, 'the head card shows whole as it opens').toContain(head);
    await schemaScrolls(page, shot);
    await schemaFollowsBars(page);
    expect.soft(errors).toEqual([]);
  });
}

/* Design on #1597, by decision 2 of #1596: a wide screen's map that fits at a readable size, its card names 11 px tall or
   more, opens as Show everything shows it, fitted and centred on the whole layout, with no card past an edge, and never
   larger than 100%. A map that fits only smaller opens readable with the hub itself in the middle across, left to right and
   right to left alike. */
const ALONE = (org: Org): Org => ({ ...org, people: [], departments: [{ ...org.departments[2]!, people: [] }] });
/* Too tall to fit readable: a stack of people docked beside the second card, on the hub's right, makes every card as tall
   as it, so the hub stands off the middle of the whole layout. */
const STACKED = (org: Org): Org => ({
  ...org,
  departments: org.departments.map((d, i) => (i === 1 ? { ...d, people: Array.from({ length: 20 }, (_, n) => ({ ...d.people[0]!, id: `n${n + 10}`, name: `${d.people[0]!.name} ${n + 1}` })) } : d)),
});
for (const look of LOOKS.filter(l => l.width === 1440 && (l.script === 'en' || l.script === 'rtl'))) {
  const name = `${look.script}-${look.dir}-${look.width}`;
  const opened = (page: Page) => page.evaluate(() => {
    const world = document.querySelector<HTMLElement>('.map .world')!, at = world.getBoundingClientRect();
    const hub = document.querySelector('.map .hub-art')!.getBoundingClientRect(), room = document.querySelector('.map .map-room')!.getBoundingClientRect();
    const names = [...document.querySelectorAll('.map .dept .dname')].map(el => parseFloat(getComputedStyle(el).fontSize));
    const k = at.width / world.offsetWidth;
    return { k, x: at.left, y: at.top, across: hub.left + hub.width / 2 - (room.left + room.width / 2), name: Math.min(...names) * k };
  });
  for (const [what, company, cards] of [['fits', (org: Org) => org, 4], ['small', ALONE, 1], ['tall', STACKED, 4]] as const) {
    test(`the map on a wide screen opens fitted when it fits readable, else readable on the hub: ${what}, ${look.script}, ${look.dir}`, async ({ page, browserName }, info) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setViewportSize({ width: look.width, height: 900 });
      await page.addInitScript(({ lang, dir }) => {
        localStorage.setItem('hh-lang', lang);
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = dir; });
      }, look);
      await serve(page, company(wholeTextOrg(look.script)));
      await page.goto('/');
      await expect(page.locator('.map .dept')).toHaveCount(cards);
      await page.evaluate(d => { document.documentElement.dir = d; }, look.dir);
      await settle(page);
      await shoot(page, info, `wide-map-${what}-open-${browserName}-${name}`);
      const open = await opened(page), whole = (await inView(page, 'map')).whole.length;
      expect.soft(open.name, 'the map opens with card names at least 11 px tall').toBeGreaterThanOrEqual(10.99);
      expect.soft(open.k, 'the map opens no larger than 100%').toBeLessThanOrEqual(1);
      if (what === 'small') expect.soft(open.k, 'a small map opens at 100%').toBe(1);
      await page.locator('.map .zoom').getByRole('button', { name: look.lang === 'en' ? 'Show everything' : 'Показать все' }).click();
      await settle(page);
      const all = await opened(page);
      if (what === 'tall') {
        expect.soft(Math.abs(open.across), `the map opens centred across on the hub, ${open.across.toFixed(1)} px off`).toBeLessThanOrEqual(1);
        expect.soft(all.k, 'Show everything goes further out than the map opens').toBeLessThan(open.k);
      } else {
        expect.soft(Math.abs(all.k - open.k), 'the map opens at the size Show everything shows it').toBeLessThanOrEqual(1e-3);
        expect.soft(Math.max(Math.abs(all.x - open.x), Math.abs(all.y - open.y)), 'the map opens where Show everything shows it').toBeLessThanOrEqual(1);
        expect.soft(whole, 'the map opens with every card and chip whole').toBe(await page.locator(BLOCKS.map).count());
      }
      expect.soft(errors).toEqual([]);
    });
  }
}
