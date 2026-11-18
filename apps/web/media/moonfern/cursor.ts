import type { Locator, Page } from '@playwright/test';

/* A drawn mouse pointer for marketing scenes: the recorded video holds no system cursor, so the page draws one that
   follows the mouse events Playwright sends, and shows a ring where it clicks. It catches no clicks of its own. */
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

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/* Glides the pointer from where it is to the middle of a target, at a pace the eye can follow. */
export async function glideTo(page: Page, from: { x: number; y: number }, target: Locator, ms = 900): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error('the cursor target is not on screen');
  const to = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const steps = Math.max(8, Math.round(ms / 20));
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.waitForTimeout(ms / steps);
  }
  return to;
}

/* Presses where the pointer is, slowly enough for the ring to show. */
export async function clickHere(page: Page): Promise<void> {
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
}
