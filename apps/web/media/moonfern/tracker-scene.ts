import { expect, type Locator, type Page } from '@playwright/test';

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/* Picks a view of the tracker as a person does: List, Board or Graph in the View group. */
export async function pickView(page: Page, name: 'List' | 'Board' | 'Graph'): Promise<void> {
  await page.locator('.tr-views label').filter({ hasText: new RegExp(`^${name}$`) }).click();
  await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
}

/* Smoothly scrolls the nearest scrolling box around a locator so it stands near the top of that box. */
export async function smoothScrollTo(page: Page, target: Locator, offset = 24, steps = 14, stepMs = 40): Promise<void> {
  const handle = await target.elementHandle();
  if (!handle) return;
  const plan = await handle.evaluate((el, off) => {
    let box: HTMLElement | null = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    const scroller = box ?? (document.scrollingElement as HTMLElement);
    const from = scroller.scrollTop;
    const to = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, from + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - off));
    (window as unknown as { __hhScroller?: HTMLElement }).__hhScroller = scroller;
    return { from, to };
  }, offset);
  for (let i = 1; i <= steps; i++) {
    const top = Math.round(plan.from + (plan.to - plan.from) * easeInOut(i / steps));
    await page.evaluate(y => {
      const s = (window as unknown as { __hhScroller?: HTMLElement }).__hhScroller;
      if (s) s.scrollTop = y;
    }, top);
    await page.waitForTimeout(stepMs);
  }
}

/* Says which /api calls the scene left unanswered, without failing the render: the frames show whether it matters. */
export function reportUnmocked(errors: string[]): void {
  if (errors.length) console.log(`[media] unanswered or failed while recording:\n${errors.join('\n')}`);
}
