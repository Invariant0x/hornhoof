import type { Locator, Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import { assertTrackerEdges } from '../media/moonfern/tracker-scene';

vi.mock('@playwright/test', () => ({
  expect: (value: unknown, message?: string) => expect(value instanceof SceneLocator ? value.element : value, message),
}));

class SceneLocator {
  constructor(readonly element: Element) {}

  async evaluate<R>(read: (element: Element) => R): Promise<R> {
    return read(this.element);
  }

  async boundingBox() {
    const { x, y, width, height } = this.element.getBoundingClientRect();
    return { x, y, width, height };
  }
}

function setBox(selector: string, x: number, y: number, width: number, height: number): void {
  document.querySelector(selector)!.getBoundingClientRect = () => new DOMRect(x, y, width, height);
}

function scene(width: number, footerHtml = ''): Pick<Page, 'locator'> {
  document.body.innerHTML = `
    <main class="tracker-page"><article class="tr-card">Last card</article></main>
    ${footerHtml}
  `;
  setBox('.tracker-page', 0, 68, width, 700);
  setBox('.tr-card', 16, 700, width - 32, 68);
  return { locator: selector => new SceneLocator(document.querySelector(selector)!) as unknown as Locator };
}

afterEach(() => { document.body.innerHTML = ''; });

it.each([390, 760])('accepts clear tracker content and no version bar at %i px', async width => {
  const page = scene(width);
  document.body.insertAdjacentHTML('afterbegin', '<header class="topbar" style="position: fixed">Navigation</header>');
  setBox('.topbar', 0, 0, width, 68);
  await expect(assertTrackerEdges(page, width)).resolves.toBeUndefined();
});

it('reports a fixed element covering the phone tracker', async () => {
  const page = scene(390);
  document.body.insertAdjacentHTML('beforeend', '<aside class="overlay" style="position: fixed">Overlay</aside>');
  setBox('.overlay', 0, 740, 390, 28);
  await expect(assertTrackerEdges(page, 390)).rejects.toThrow(/fixed elements overlapping the tracker.*overlay/s);
});

it('rejects a bottom version bar on desktop tracker pages (#1874)', async () => {
  const page = scene(1440, '<footer class="version-mark">0.40.2</footer>');
  await expect(assertTrackerEdges(page, 1440)).rejects.toThrow();
});

it("keeps the desktop board's last card aligned to the bottom of the full-height tracker", async () => {
  const page = scene(1440);
  const last = page.locator('.tr-card');
  await expect(assertTrackerEdges(page, 1440, last)).resolves.toBeUndefined();
  setBox('.tr-card', 16, 720, 1408, 68);
  await expect(assertTrackerEdges(page, 1440, last)).rejects.toThrow(/expected 20 to be less than or equal to 1/);
});
