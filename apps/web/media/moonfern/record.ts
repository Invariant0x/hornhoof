import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.resolve(HERE, '..', 'results');
export const VIDEOS_DIR = path.join(RESULTS_DIR, 'videos');
export const MARKS_DIR = path.join(RESULTS_DIR, 'marks');

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/* Smoothly scrolls the Shell .body container (or window when outside Shell) to an exact target scrollTop. */
export async function smoothScrollBody(page: Page, targetTop: number, steps = 12, stepMs = 42): Promise<void> {
  const startTop = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.body');
    return body ? body.scrollTop : window.scrollY;
  });
  const delta = targetTop - startTop;
  if (Math.abs(delta) < 1) return;
  for (let i = 1; i <= steps; i++) {
    const nextTop = i === steps ? targetTop : Math.round(startTop + delta * easeInOut(i / steps));
    await page.evaluate(top => {
      const body = document.querySelector<HTMLElement>('.body');
      if (body) body.scrollTop = top;
      else window.scrollTo(0, top);
    }, nextTop);
    await page.waitForTimeout(stepMs);
  }
}

/* Smoothly drags a pan-zoom canvas by exact integer (dx, dy) pixels so reversing (-dx, -dy) restores exact coordinates. */
export async function smoothDrag(
  page: Page,
  target: Locator,
  dx: number,
  dy: number,
  steps = 10,
  stepMs = 45,
  anchor: { xRatio: number; yRatio: number } = { xRatio: 0.55, yRatio: 0.55 },
): Promise<void> {
  const box = await target.boundingBox();
  if (!box) return;
  const startX = Math.round(box.x + box.width * anchor.xRatio);
  const startY = Math.round(box.y + box.height * anchor.yRatio);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.evaluate(() => (document.activeElement as HTMLElement | SVGElement | null)?.blur?.());
  for (let i = 1; i <= steps; i++) {
    const x = i === steps ? startX + dx : Math.round(startX + dx * easeInOut(i / steps));
    const y = i === steps ? startY + dy : Math.round(startY + dy * easeInOut(i / steps));
    await page.mouse.move(x, y);
    await page.waitForTimeout(stepMs);
  }
  await page.mouse.up();
  await page.evaluate(() => (document.activeElement as HTMLElement | SVGElement | null)?.blur?.());
}

export type SceneRecorder = {
  markReady: () => Promise<void>;
  finishGif: (name: string) => Promise<void>;
};

export function createSceneRecorder(page: Page): SceneRecorder {
  const createdAt = performance.now();
  let startSec = 0;

  return {
    async markReady() {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      startSec = Math.max(0, (performance.now() - createdAt) / 1000);
    },
    async finishGif(name: string) {
      const endSec = (performance.now() - createdAt) / 1000;
      const durationSec = Math.max(1, endSec - startSec);
      const video = page.video();
      await page.close();
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
      fs.mkdirSync(MARKS_DIR, { recursive: true });
      if (video) {
        await video.saveAs(path.join(VIDEOS_DIR, `${name}.webm`));
      }
      fs.writeFileSync(
        path.join(MARKS_DIR, `${name}.json`),
        JSON.stringify({ name, startSec: Number(startSec.toFixed(3)), durationSec: Number(durationSec.toFixed(3)) }, null, 2) + '\n',
      );
    },
  };
}
