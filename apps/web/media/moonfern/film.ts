import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { MARKS_DIR, RESULTS_DIR } from './record';

declare global {
  interface Window {
    __hhFilmStep?: (ms: number) => void;
  }
}

/* A marketing cut is taken frame by frame on a controlled clock, not by the video recorder: the recorder captures the
   page at its CSS size, so at a device scale of 2 its frames are half the size of the picture. Each frame moves the page's
   clock (timers, Date, requestAnimationFrame), every CSS, Web Animations and SVG animation by the same 40 ms, then takes a
   full-resolution screenshot. run.sh turns the frames into the raw .webm, the MP4 and the GIF. */
export const FILM_FPS = 25;
const STEP_MS = 1000 / FILM_FPS;
export const FRAMES_DIR = path.join(RESULTS_DIR, 'frames');

type Point = { x: number; y: number };
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/* Before the page loads: the page's clock waits for the film, and the film can step every animation of the page. An
   animation is caught the first frame it is seen, keeps the time it had run, and moves on only with the film. */
export async function installFilmClock(page: Page, time: string): Promise<void> {
  await page.clock.install({ time: new Date(time) });
  await page.addInitScript(() => {
    type Held = { __film?: number };
    window.__hhFilmStep = (ms: number) => {
      for (const animation of document.getAnimations() as (Animation & Held)[]) {
        if (animation.__film === undefined) {
          animation.__film = ms - Number(animation.currentTime ?? 0);
          animation.pause();
        }
        animation.currentTime = ms - animation.__film;
      }
      for (const svg of document.querySelectorAll('svg') as NodeListOf<SVGSVGElement & Held>) {
        if (svg.ownerSVGElement) continue;
        if (svg.__film === undefined) {
          svg.__film = ms - svg.getCurrentTime() * 1000;
          svg.pauseAnimations();
        }
        svg.setCurrentTime((ms - svg.__film) / 1000);
      }
    };
  });
}

/* Before the take: steps the page's clock until what is watched stands still for a few steps in a row. The map fits
   itself to the screen on layout events that come in real time, then animates on the page's clock, so the clock moves
   in small steps with a breath of real time between them. */
export async function settle(page: Page, watched: Locator, tries = 60): Promise<void> {
  let last = '', same = 0;
  for (let i = 0; i < tries && same < 4; i++) {
    await page.clock.runFor(100);
    await page.waitForTimeout(30);
    const box = await watched.boundingBox();
    const now = box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}` : '';
    same = now === last ? same + 1 : 0;
    last = now;
  }
}

/* The zoom's readout as a number: "80%" is 80. */
async function percentOf(shown: Locator): Promise<number> {
  return Number((await shown.textContent())?.replace('%', ''));
}

/* Turns the wheel under the pointer until the zoom's readout says percent: first by move(turn), then by small turns that
   set it exactly. Before a take, move is a single turn of the wheel. */
export async function wheelZoomTo(page: Page, percent: number, shown: Locator, move?: (turn: number) => Promise<void>): Promise<void> {
  const scale = await page.evaluate(() => devicePixelRatio);
  const turnTo = async () => (-Math.log(percent / (await percentOf(shown))) / 0.0015) * scale;
  const settled = async (was: number) => {
    for (let i = 0; i < 20 && (await percentOf(shown)) === was; i++) await page.waitForTimeout(25);
  };
  let was = await percentOf(shown);
  if (was !== percent) {
    if (move) await move(await turnTo());
    else await page.mouse.wheel(0, await turnTo());
    await settled(was);
  }
  for (let i = 0; i < 6 && (was = await percentOf(shown)) !== percent; i++) {
    await page.mouse.wheel(0, await turnTo());
    await settled(was);
  }
  if ((await percentOf(shown)) !== percent) throw new Error(`the map did not come to ${percent}%, it shows ${await percentOf(shown)}%`);
}

export class Film {
  private frame = 0;
  private ms = 0;
  private readonly steps: { step: string; sec: number }[] = [];
  readonly dir: string;
  pointer: Point;

  constructor(readonly page: Page, readonly name: string, start: Point) {
    this.dir = path.join(FRAMES_DIR, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.pointer = start;
  }

  get seconds(): number {
    return this.frame / FILM_FPS;
  }

  /* A named moment of the cut, for the editor's timing marks. */
  mark(step: string): void {
    this.steps.push({ step, sec: Number(this.seconds.toFixed(2)) });
  }

  /* One frame: the clock and every animation move on by one step, then the picture is taken at full resolution. */
  async shot(): Promise<void> {
    await this.page.clock.runFor(STEP_MS);
    this.ms += STEP_MS;
    await this.page.evaluate(ms => window.__hhFilmStep?.(ms), this.ms);
    await this.page.screenshot({ path: path.join(this.dir, `${String(this.frame).padStart(5, '0')}.png`) });
    this.frame++;
  }

  async hold(ms: number): Promise<void> {
    for (let i = 0; i < Math.round(ms / STEP_MS); i++) await this.shot();
  }

  /* Frames go on until the page shows what is waited for, as a person would see it come. */
  async until(ready: () => Promise<boolean>, ms = 4000): Promise<void> {
    for (let i = 0; i < Math.round(ms / STEP_MS); i++) {
      if (await ready()) return;
      await this.shot();
    }
    throw new Error(`${this.name}: the page did not come within ${ms} ms of film`);
  }

  async glide(to: Point, ms = 900): Promise<void> {
    const from = this.pointer;
    const steps = Math.max(2, Math.round(ms / STEP_MS));
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      await this.page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      await this.shot();
    }
    this.pointer = to;
  }

  /* A click the eye sees: the press holds for a few frames while the ring opens. */
  async click(): Promise<void> {
    await this.page.mouse.down();
    await this.shot();
    await this.shot();
    await this.page.mouse.up();
    await this.shot();
  }

  /* Pulls the canvas by (dx, dy) the way a hand does. */
  async drag(dx: number, dy: number, ms = 900): Promise<void> {
    const from = this.pointer;
    const steps = Math.max(2, Math.round(ms / STEP_MS));
    await this.page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      await this.page.mouse.move(Math.round(from.x + dx * t), Math.round(from.y + dy * t));
      await this.shot();
    }
    await this.page.mouse.up();
    this.pointer = { x: from.x + dx, y: from.y + dy };
  }

  /* Scrolls a box to top the way a wheel under the pointer does, smoothly, one frame at a time. */
  async scroll(box: Locator, top: number, ms = 1500): Promise<void> {
    const from = await box.evaluate(el => el.scrollTop);
    const steps = Math.max(2, Math.round(ms / STEP_MS));
    for (let i = 1; i <= steps; i++) {
      await box.evaluate((el, y) => el.scrollTo({ top: y, behavior: 'instant' }), Math.round(from + (top - from) * ease(i / steps)));
      await this.shot();
    }
  }

  /* Zooms the canvas under the pointer with the wheel until shown, the zoom's own readout, says percent. The canvas zooms
     by e^(-deltaY * 0.0015) a wheel step (apps/web/src/ui/canvas.tsx), and the page gets the wheel's turn divided by the
     device scale. The last turn, if one is needed, sets the readout exactly. */
  async wheelZoomTo(percent: number, shown: Locator, ms = 800): Promise<void> {
    await wheelZoomTo(this.page, percent, shown, async turn => {
      const steps = Math.max(2, Math.round(ms / STEP_MS));
      for (let i = 0; i < steps; i++) {
        await this.page.mouse.wheel(0, turn / steps);
        await this.shot();
      }
    });
  }

  /* The timing marks beside the frames: run.sh reads the frame rate and length, the editor the named moments. */
  finish(): void {
    fs.mkdirSync(MARKS_DIR, { recursive: true });
    const mark = { name: this.name, startSec: 0, durationSec: Number(this.seconds.toFixed(3)), fps: FILM_FPS, frames: this.frame, steps: this.steps };
    fs.writeFileSync(path.join(MARKS_DIR, `${this.name}.json`), JSON.stringify(mark, null, 2) + '\n');
  }
}
