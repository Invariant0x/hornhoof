import { expect, test, type Page } from '@playwright/test';
import type { Org } from '../src/types';
import { serveApi } from './api';
import { captureWith } from './capture';
import { LONG_HINT, wholeTextOrg, type Script } from './whole-text-data';

/* The department cards of the map, the head card, role frames and member chips of a department's screen, and the hint at
   its foot show every word: no ellipsis, no line clamp and no text cut off or standing out of its frame, in a long pseudo
   translation, Japanese and right to left as in English and Russian, on a wide screen and on a phone. Where the words fit
   the old boxes, the boxes keep their old sizes. Each check is soft, so a look goes through the map, the department and
   far zoom, takes every picture and fails at its end with every cut it found. The run that takes the pictures names its
   phase and folder in WHOLE_TEXT_PHASE and WHOLE_TEXT_SHOTS. */
test.describe.configure({ timeout: 180_000 });

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

/* The size and place of each element in the world of its canvas, as the layout set them. */
async function placed(page: Page, selector: string): Promise<{ x: number; y: number; w: number; h: number }[]> {
  return page.locator(selector).evaluateAll(all => all.map(el => {
    const s = (el as HTMLElement).style;
    return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height) };
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

/* Zoomed all the way out, then in by the wheel to the scale asked for. */
async function zoomTo(page: Page, k: number) {
  await page.evaluate(k => {
    const out = document.querySelector<HTMLButtonElement>('.dview .zoom .zbtn')!;
    for (let i = 0; i < 20; i++) out.click();
    document.querySelector<HTMLElement>('.dview .dcanvas')!.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -Math.log(k / 0.15) / 0.0015, clientX: 200, clientY: 200, bubbles: true, cancelable: true }),
    );
  }, k);
  await expect(page.locator('.dview .zoom .zv')).toHaveText(`${Math.round(k * 100)}%`);
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
  expect.soft(new Set(chips.map(c => c.h)).size, 'one height for every chip').toBe(1);
  expect.soft(chips.every(c => c.w === 240), 'the chips keep their width').toBe(true);
  const head = await page.locator('.dview .shead').first().evaluate(card => {
    const s = ((card.closest('.sslot') as HTMLElement | null) ?? (card as HTMLElement)).style;
    return { w: parseFloat(s.width), h: parseFloat(s.height) };
  });
  expect.soft(head.w, 'the head card keeps its width').toBe(380);
  return { head, chips };
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
  test(`every word on the map's department cards, the department's cards and its hint: ${look.script}, ${look.dir}, ${look.width}px`, async ({ page, browserName }, info) => {
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

    /* The department: its head card, role frames and member chips, and the hint at its foot. */
    /* A card can stand under the top bar on a phone: it is pressed as a person's tap on it would press it. */
    await page.locator('.map .dept').first().evaluate(card => (card as HTMLElement).click());
    await expect(page.locator('.dview .dcanvas')).toBeVisible();
    await page.locator('.dview .zoom').getByRole('button', { name: look.lang === 'en' ? 'Show everything' : 'Показать все' }).click();
    const hint = page.locator('.dview .ticker .tx');
    await expect(hint).toBeVisible();
    if (look.script === 'pseudo') await hint.evaluate((el, text) => { el.textContent = text; }, LONG_HINT);
    await settle(page);
    if (browserName === 'chromium') await shoot(page, info, `department-${name}`);

    const { head, chips } = await checkSchema(page);
    expect.soft(await cutTexts(page, '.dview .ticker', '.tx')).toEqual([]);
    if (look.script === 'en' || look.script === 'ru') {
      expect.soft([head.h, chips[0]!.h], 'words that fit keep the old head card and chips').toEqual([184, 84]);
      expect.soft(chips.every(c => (c.y - 100) % 96 === 0), 'chips stand where they stood').toBe(true);
    }

    /* The hint stands whole on the screen, clear of the zoom and the tools. */
    const ticker = await page.locator('.dview .ticker').boundingBox();
    const view = page.viewportSize()!;
    expect.soft(ticker!.x >= -1 && ticker!.x + ticker!.width <= view.width + 1 && ticker!.y >= -1 && ticker!.y + ticker!.height <= view.height + 1, 'the hint stands on the screen').toBe(true);
    const rects = await page.evaluate(() => ['.dview .ticker', '.dview .zoom', '.dview .dv-acts'].map(s => document.querySelector(s)?.getBoundingClientRect().toJSON() as DOMRect | null));
    expect.soft(overlap(rects[0]!, rects[1]!) || overlap(rects[0]!, rects[2]!), 'the hint clear of the zoom and the tools').toBe(false);

    /* Zoomed far out, where chips show colours: the layout holds, and no word is cut or runs over a chip. */
    await zoomTo(page, 0.4);
    await settle(page);
    if (browserName === 'chromium') await shoot(page, info, `department-far-${name}`);
    const far = await checkSchema(page);
    expect.soft(far.head, 'far zoom keeps the head card').toEqual(head);
    expect.soft(far.chips, 'far zoom moves no chip').toEqual(chips);

    expect.soft(errors).toEqual([]);
  });
}
