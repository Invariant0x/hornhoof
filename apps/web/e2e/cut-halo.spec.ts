import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { BUILTIN_SKINS, type BuiltinSkinId } from '../src/skins/registry';
import { ASKED, ONE, serveHubTurn } from './hub-turn-api';

/* A card with a cut corner draws its glow and its focus ring in its own shape (style book 1.4, section 3): no square halo
   and no triangle of the background at a cut, in every built-in skin, at 1440 and 375, in Russian and right to left. Each
   test keeps pictures of the glowing card, of its cut corner enlarged and of the focused card, for Design to compare with
   the same pictures of the code before. */
test.describe.configure({ timeout: 180_000 });
/* The map opens still, so it fits the screen at once; the glow is let breathe only while it is measured. */
test.use({ reducedMotion: 'reduce' });

const SKINS: readonly BuiltinSkinId[] = BUILTIN_SKINS.map(s => s.id);
const PLACES = [['ru', 'ltr'], ['ru', 'rtl']] as const;
const WIDTHS = [1440, 375] as const;
/* Room around a card in a picture: the glow fades well inside it. */
const ROOM = 32;
const GLOWING = 'button.dept.busy, button.dept.waits, button.chip-btn.attn';

type Rgb = [number, number, number];
/* Where a card stands on the screen, its scale on the map, its cut on the screen and whether the cut is in steps. */
type Card = { x: number; y: number; w: number; h: number; scale: number; cut: number; steps: boolean };

async function openMap(page: Page, skin: BuiltinSkinId, dir: 'ltr' | 'rtl', width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
  await page.addInitScript(({ skin }) => {
    localStorage.setItem('hh-lang', 'ru');
    localStorage.setItem('hh-theme', skin);
  }, { skin });
  await serveHubTurn(page, ONE, [ASKED]);
  await page.goto('/');
  await page.evaluate(d => { document.documentElement.dir = d; }, dir);
  await expect(page.locator('button.dept.busy').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', skin);
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function cardOf(button: Locator): Promise<Card> {
  return button.locator(':scope > .edge').evaluate(edge => {
    const r = edge.getBoundingClientRect();
    const scale = r.width / (edge as HTMLElement).offsetWidth;
    const k = Number(getComputedStyle(document.documentElement).getPropertyValue('--cut-k'));
    const cut = parseFloat(getComputedStyle(edge).getPropertyValue('--cut')) * k * scale;
    return { x: r.left, y: r.top, w: r.width, h: r.height, scale, cut, steps: document.documentElement.dataset.cut === 'steps' && k > 0 };
  });
}

/* The whole map, by the keyboard on its button, then the map at the scale of 1 around the cut corner at the bottom left of a
   card, by the wheel, as a person zooms. No button is pressed by the mouse, so a focus that follows is a keyboard's in
   every engine. */
async function closeUp(page: Page, button: Locator): Promise<Card> {
  await page.locator('.map .zoom .zbtn').last().focus();
  await page.keyboard.press('Enter');
  const card = await cardOf(button);
  expect(card.x >= 0 && card.y + card.h <= page.viewportSize()!.height, 'the whole map shows the card').toBe(true);
  await page.mouse.move(card.x + 1, card.y + card.h - 1);
  await page.mouse.wheel(0, Math.log(card.scale) / 0.0015);
  await expect.poll(async () => Math.abs((await cardOf(button)).scale - 1)).toBeLessThan(0.01);
  await page.mouse.move(0, 0);
  return cardOf(button);
}

/* The breathing glow at its brightest, the middle of its 2.6 s, and every other animation standing still. */
async function glowAtItsBrightest(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => document.getAnimations().some(a => (a as CSSAnimation).animationName === 'dglow'))).toBe(true);
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      a.pause();
      if (['dglow', 'dbreathe'].includes((a as CSSAnimation).animationName)) a.currentTime = 1300;
    }
  });
}

/* A colour of the skin as this engine paints it. */
async function painted(page: Page, token: string): Promise<Rgb> {
  const text = await page.evaluate(token => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = `var(${token})`;
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
  return text.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number) as Rgb;
}

/* The part of the screen around a card that the screen holds. */
function clipAround(page: Page, card: Card) {
  const viewport = page.viewportSize()!;
  const left = Math.max(0, Math.floor(card.x - ROOM)), top = Math.max(0, Math.floor(card.y - ROOM));
  return { x: left, y: top, width: Math.min(viewport.width, Math.ceil(card.x + card.w + ROOM)) - left, height: Math.min(viewport.height, Math.ceil(card.y + card.h + ROOM)) - top };
}

/* The picture of the screen around a card, read back pixel by pixel by the page itself, so each engine reads its own
   drawing. at(x, y) takes screen coordinates, and null for a point the picture does not hold. */
async function around(page: Page, card: Card) {
  const clip = clipAround(page, card);
  const png = (await page.screenshot({ clip, animations: 'allow' })).toString('base64');
  const pixels = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: [...context.getImageData(0, 0, bitmap.width, bitmap.height).data] };
  }, png);
  return {
    at(x: number, y: number): Rgb | null {
      const [px, py] = [Math.floor(x - clip.x), Math.floor(y - clip.y)];
      if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) return null;
      const i = (py * pixels.width + px) * 4;
      return [pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!];
    },
  };
}

const distance = (a: Rgb, b: Rgb) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/* Points just outside the cut at the bottom left and at the top right of a card, inside the box around it, and how far
   they stand from the card. In a skin of steps a point is the corner pixel; with a slanted cut it stands on the middle of
   the cut, 2 px in from the box. */
function cutPoints(card: Card): { points: [number, number][]; off: number } {
  if (card.steps) return { points: [[card.x + 1.5, card.y + card.h - 1.5], [card.x + card.w - 1.5, card.y + 1.5]], off: 1.6 };
  return { points: [[card.x + 2, card.y + card.h - 2], [card.x + card.w - 2, card.y + 2]], off: (card.cut - 4) / Math.SQRT2 };
}

/* The cut corner at the bottom left, enlarged six times without smoothing, for the eye. */
async function corner(page: Page, card: Card, path: string) {
  const size = 40;
  const clip = { x: Math.max(0, Math.floor(card.x - 16)), y: Math.max(0, Math.floor(card.y + card.h - size + 16)), width: size, height: size };
  const png = (await page.screenshot({ clip, animations: 'allow' })).toString('base64');
  const big = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width * 6;
    canvas.height = bitmap.height * 6;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, png);
  await writeFile(path, Buffer.from(big, 'base64'));
}

const NO_DOTS = '.map::before { background-image: none !important; }';

for (const skin of SKINS) {
  for (const width of WIDTHS) {
    for (const [lang, dir] of PLACES) {
      const place = `${skin} ${lang} ${dir} ${width}`;
      const name = (what: string, browser: string) => `${what}-${skin}-${lang}-${dir}-${width}-${browser}.png`;

      test(`a glowing card and a focused one keep the shape of their cut corners, ${place}`, async ({ page, browserName }, info) => {
        await openMap(page, skin, dir, width);
        const glowing = page.locator(GLOWING);
        const count = await glowing.count();
        expect(count).toBeGreaterThan(0);
        /* The map as it opens: on a phone every card stands small. */
        if (width === 375) await page.screenshot({ path: info.outputPath(name('map', browserName)), animations: 'allow' });

        const sizes: Card[] = [];
        for (let i = 0; i < count; i++) {
          await page.emulateMedia({ reducedMotion: 'reduce' });
          const card = await closeUp(page, glowing.nth(i));
          sizes.push(card);
          await glowAtItsBrightest(page);
          await page.screenshot({ path: info.outputPath(name(`glow-${i}`, browserName)), clip: clipAround(page, card), animations: 'allow' });
          await corner(page, card, info.outputPath(name(`glow-corner-${i}`, browserName)));
          /* No dot of the map stands on a point read. */
          const dots = await page.addStyleTag({ content: NO_DOTS });
          const ground = await painted(page, '--bg');
          const shot = await around(page, card);
          const { points, off } = cutPoints(card);
          /* As far out from a straight side: the start edge, a little above the cut. */
          const y = card.y + card.h - card.cut - 8;
          const side = shot.at(card.x - Math.max(off, 2), y);
          expect(side, `${place}: card ${i} has its side on the screen`).not.toBeNull();
          const lit = distance(side!, ground);
          expect(lit, `${place}: the glow lights the side of card ${i}`).toBeGreaterThan(12);
          /* The glow keeps its size: a blur of 12 px is gone 20 px out, where the map looks as it does 30 px out. */
          const [far, beyond] = [shot.at(card.x - 20, y), shot.at(card.x - 30, y)];
          if (far && beyond) expect.soft(distance(far, beyond), `${place}: the glow of card ${i} fades within its old reach`).toBeLessThanOrEqual(5);
          for (const [x, y] of card.cut > 0 ? points : []) {
            const pixel = shot.at(x, y);
            if (!pixel) continue;
            expect.soft(distance(pixel, ground), `${place}: the glow lights the cut of card ${i} at ${x.toFixed(1)}, ${y.toFixed(1)} as it lights its side (${lit})`).toBeGreaterThanOrEqual(lit * 0.5);
          }
          await dots.evaluate(style => style.remove());
        }
        await writeFile(info.outputPath(`sizes-${skin}-${lang}-${dir}-${width}-${browserName}.json`), JSON.stringify(sizes));

        /* Focus from the keyboard, with no glow: the ring follows the cut. */
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const button = page.locator('button.dept').first();
        const box = await closeUp(page, button);
        await button.focus();
        expect(await button.evaluate(element => element.matches(':focus-visible'))).toBe(true);
        await page.screenshot({ path: info.outputPath(name('focus', browserName)), clip: clipAround(page, box), animations: 'allow' });
        await corner(page, box, info.outputPath(name('focus-corner', browserName)));
        const dots = await page.addStyleTag({ content: NO_DOTS });
        const ring = await painted(page, '--cyan-ink');
        const shot = await around(page, box);
        expect.soft(distance(shot.at(box.x - 3, box.y + box.h / 2)!, ring), `${place}: the ring stands 2 px off the side`).toBeLessThan(60);
        const outer = shot.at(box.x - 3.5, box.y + box.h + 2.5)!;
        if (box.cut > 0) {
          expect.soft(distance(outer, ring), `${place}: no ring at the corner of the box, where the card is cut`).toBeGreaterThan(120);
          if (!box.steps) {
            const along = shot.at(box.x + box.cut / 2 - 3 / Math.SQRT2, box.y + box.h - box.cut / 2 + 3 / Math.SQRT2)!;
            expect.soft(distance(along, ring), `${place}: the ring runs along the cut`).toBeLessThan(140);
          }
        } else {
          expect.soft(distance(outer, ring), `${place}: a skin with no cut keeps a square ring`).toBeLessThan(60);
        }
        await dots.evaluate(style => style.remove());
      });
    }
  }
}
