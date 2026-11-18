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

function scene(width: number, footerStyle = ''): Pick<Page, 'locator'> {
  document.body.innerHTML = `
    <main class="tracker-page"><article class="tr-card">Last card</article></main>
    <footer class="version-mark" style="${footerStyle}">0.32.0</footer>
  `;
  setBox('.tracker-page', 0, 68, width, 700);
  setBox('.tr-card', 16, 700, width - 32, 68);
  setBox('.version-mark', 0, 768, width, 26);
  return { locator: selector => new SceneLocator(document.querySelector(selector)!) as unknown as Locator };
}

afterEach(() => { document.body.innerHTML = ''; });

it.each([390, 760])('accepts a hidden version and clear tracker content at %i px', async width => {
  const page = scene(width, 'display: none; position: fixed');
  setBox('.version-mark', 0, 740, width, 28);
  document.body.insertAdjacentHTML('afterbegin', '<header class="topbar" style="position: fixed">Navigation</header>');
  setBox('.topbar', 0, 0, width, 68);
  await expect(assertTrackerEdges(page, width)).resolves.toBeUndefined();
});

it('reports a fixed element covering the phone tracker even with the version hidden', async () => {
  const page = scene(390, 'display: none');
  document.body.insertAdjacentHTML('beforeend', '<aside class="overlay" style="position: fixed">Overlay</aside>');
  setBox('.overlay', 0, 740, 390, 28);
  await expect(assertTrackerEdges(page, 390)).rejects.toThrow(/fixed elements overlapping the tracker.*overlay/s);
});

it('requires the version to be visible above the phone breakpoint', async () => {
  await expect(assertTrackerEdges(scene(761, 'display: none'), 761)).rejects.toThrow(/toBeVisible/);
});

it("keeps the desktop board's last card clear of the footer", async () => {
  const page = scene(1440);
  const last = page.locator('.tr-card');
  await expect(assertTrackerEdges(page, 1440, last)).resolves.toBeUndefined();
  setBox('.version-mark', 0, 748, 1440, 26);
  await expect(assertTrackerEdges(page, 1440, last)).rejects.toThrow(/expected 768 to be less than or equal to 749/);
});
