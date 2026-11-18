import type { Page } from '@playwright/test';

/* A drawn mouse pointer for marketing scenes: a screenshot holds no system cursor, so the page draws one that follows the
   mouse events Playwright sends, and shows a ring where it presses. It catches no clicks of its own. */
export async function installSceneCursor(page: Page, start: { x: number; y: number }): Promise<void> {
  await page.addInitScript(({ x, y }) => {
    const draw = () => {
      const pointer = document.createElement('div');
      pointer.setAttribute('aria-hidden', 'true');
      pointer.style.cssText = `position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(${x}px,${y}px);`;
      pointer.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M3 2 L3 22 L8.5 17 L12.5 26 L16 24.5 L12 15.5 L19.5 15.5 Z" fill="#ffffff" stroke="#0b0f14" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      const ring = document.createElement('div');
      ring.setAttribute('aria-hidden', 'true');
      ring.style.cssText = 'position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #ffffff;z-index:2147483646;pointer-events:none;opacity:0;';
      document.body.append(ring, pointer);
      document.addEventListener('mousemove', e => { pointer.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
      document.addEventListener('mousedown', e => {
        ring.style.left = `${e.clientX}px`;
        ring.style.top = `${e.clientY}px`;
        ring.animate([{ opacity: 0.9, transform: 'scale(0.4)' }, { opacity: 0, transform: 'scale(1.3)' }], { duration: 520, easing: 'ease-out' });
      }, true);
    };
    if (document.body) draw();
    else document.addEventListener('DOMContentLoaded', draw, { once: true });
  }, start);
}
