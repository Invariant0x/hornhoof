import { expect, test, type Page } from '@playwright/test';
import { box } from './api';
import { LONG, noSideScroll, openMachines, SIZES, within, WORDS } from './machine-priority-steps';

/* Moving the company server: the question before it, a refusal, and a move that waits for its copy. */

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const [width, height] of SIZES) {
  const place = `${language} ${theme} ${width}`;
  const w = WORDS[language];
  const shot = (name: string) => `${name}-${language}-${theme}-${width}.png`;
  const card = (page: Page, hostname: string) => page.getByRole('article', { name: hostname });
  const open = (page: Page, hostname: string) => page.getByRole('button', { name: `${w.open} ${hostname}`, exact: true }).click();

  test(`asks before it moves the server, and says how a move goes, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const sent = await openMachines(page, language, theme, { status: 409, reason: 'updating' });
    await open(page, LONG);
    const target = card(page, LONG);
    const here = target.getByRole('button', { name: w.here, exact: true });
    await expect(here).toBeVisible();
    expect(await within(here, target)).toBe(true);
    await here.click();
    /* The question takes the button's place, with its answers inside the card and the focus on the first. */
    const question = target.getByText(w.ask(LONG));
    const [yes, cancel] = [target.getByRole('button', { name: w.yes, exact: true }), target.getByRole('button', { name: w.cancel, exact: true })];
    await expect(question).toBeVisible();
    await expect(yes).toBeFocused();
    for (const one of [question, yes, cancel]) expect(await within(one, target)).toBe(true);
    /* Each answer is large enough to press with a finger, and the two do not lie on each other. */
    const [a, b] = [await box(yes), await box(cancel)];
    expect(Math.min(a.height, b.height)).toBeGreaterThanOrEqual(44);
    expect(a.x + a.width <= b.x + 1 || a.y + a.height <= b.y + 1).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('move-ask')), fullPage: true });
    /* A refusal is said under the answers, inside the card. */
    await yes.click();
    const refusal = target.getByText(w.updating);
    await expect(refusal).toBeVisible();
    expect(await within(refusal, target)).toBe(true);
    expect(sent).toEqual([{ path: '/api/machines/m3/move', body: 'POST' }]);
    await page.screenshot({ path: info.outputPath(shot('move-refused')), fullPage: true });
    /* Cancel gives the focus back to the button. */
    await cancel.click();
    await expect(here).toBeFocused();
  });

  test(`shows a move that waits for its copy, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openMachines(page, language, theme, undefined, { machine: 'm3', state: 'preparing', reason: null, leader: 'rack-01', progress: 40 });
    await open(page, LONG);
    const target = card(page, LONG);
    const [line, stop] = [target.getByText(w.waiting(LONG)), target.getByRole('button', { name: w.stop, exact: true })];
    await expect(line).toBeVisible();
    await expect(stop).toBeVisible();
    for (const one of [line, stop]) expect(await within(one, target)).toBe(true);
    await expect(target.getByRole('button', { name: w.here, exact: true })).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('move-waiting')), fullPage: true });
  });
}
