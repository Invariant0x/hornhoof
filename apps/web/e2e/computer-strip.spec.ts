import { expect, test, type Locator, type Page } from '@playwright/test';
import { box } from './api';
import { ASKED, CLOSED, MANY, OPEN, REASON, SECOND, SETTINGS, openWindow } from './computer-strip-api';

/* What the block took of the window before it became a strip, in px, measured on the same window. */
const BEFORE = { asked: { 1440: 208, 375: 344 }, open: { 1440: 181, 375: 220 } };

const strip = (window: Locator) => window.locator('.t-access');
const terminal = (window: Locator) => window.locator('.t-term');

async function oneHeaderRow(window: Locator): Promise<number> {
  return window.locator(':scope > .t-bar').evaluate(bar => parseFloat(getComputedStyle(bar).minHeight));
}

/* Not wider than the screen, nothing cut at its edge, and the terminal stays the biggest thing in the window. */
async function expectFits(page: Page, window: Locator) {
  const width = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await strip(window).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  for (const button of await strip(window).getByRole('button').all()) {
    const b = await box(button);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(width);
  }
  const [bar, term] = [await box(strip(window)), await box(terminal(window))];
  expect(term.y + term.height).toBeLessThanOrEqual(bar.y + 1);
  expect(term.height).toBeGreaterThan(bar.height);
}

async function expectOneLine(page: Page, window: Locator, before: number) {
  await expect(strip(window)).toBeVisible();
  await expect(window.locator('.t-cards')).toHaveCount(0);
  const { height } = await box(strip(window));
  expect(height).toBeLessThanOrEqual(await oneHeaderRow(window));
  expect(height * 4).toBeLessThanOrEqual(before);
  await expectFits(page, window);
}

for (const s of SETTINGS) {
  const named = `${s.lang} ${s.theme} ${s.width}`;
  const width = s.width as 1440 | 375;

  test(`a request is one line, and Open for a day opens it: ${named}`, async ({ page }) => {
    const { words, window, errors, posts } = await openWindow(page, s, ASKED);
    const line = window.getByRole('region', { name: words.asks, exact: true });
    await expect(line).toBeVisible();
    await expectOneLine(page, window, BEFORE.asked[width]);
    await expect(line.getByText(REASON)).toHaveCount(1);
    expect(await line.getByText(REASON).evaluate(el => [getComputedStyle(el).whiteSpace, getComputedStyle(el).textOverflow])).toEqual(['nowrap', 'ellipsis']);
    await expect(window.getByText(words.what)).toHaveCount(0);
    await line.getByRole('button', { name: words.more, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(window.getByText(words.what)).toBeVisible();
    await expectFits(page, window);
    await page.keyboard.press('Enter');
    await expect(window.getByText(words.what)).toHaveCount(0);
    await line.getByRole('button', { name: words.openDay, exact: true }).click();
    await expect(window.getByRole('region', { name: words.open, exact: true })).toBeVisible();
    await expect(line).toHaveCount(0);
    expect(posts).toEqual(['/api/machines/node-a/access/open']);
    expect(errors).toEqual([]);
  });

  test(`Not now answers a request and gives the place back to the terminal: ${named}`, async ({ page }) => {
    const { words, window, errors, posts } = await openWindow(page, s, ASKED);
    const line = window.getByRole('region', { name: words.asks, exact: true });
    const withStrip = await box(terminal(window));
    await line.getByRole('button', { name: words.notNow, exact: true }).click();
    await expect(line).toHaveCount(0);
    await expect(strip(window)).toHaveCount(0);
    await expect.poll(async () => (await box(terminal(window))).height).toBeGreaterThan(withStrip.height);
    expect(posts).toEqual(['/api/machines/node-a/access/decline']);
    expect(errors).toEqual([]);
  });

  test(`open access is one line, and Close access closes it: ${named}`, async ({ page }) => {
    const { words, window, errors, posts } = await openWindow(page, s, OPEN);
    const line = window.getByRole('region', { name: words.open, exact: true });
    await expect(line).toBeVisible();
    await expectOneLine(page, window, BEFORE.open[width]);
    await expect(window.getByText(words.until)).toHaveCount(0);
    await line.getByRole('button', { name: words.more, exact: true }).click();
    await expect(window.getByText(words.until)).toBeVisible();
    await expectFits(page, window);
    await line.getByRole('button', { name: words.close, exact: true }).click();
    await expect(line).toHaveCount(0);
    expect(posts).toEqual(['/api/machines/node-a/access/close']);
    expect(errors).toEqual([]);
  });

  test(`two machines are one line with a counter, then two lines of the same height: ${named}`, async ({ page }) => {
    const { words, window, errors, posts } = await openWindow(page, s, ASKED, [SECOND]);
    const first = window.getByRole('region', { name: words.asks, exact: true });
    const second = window.getByRole('region', { name: words.second, exact: true });
    const counter = window.getByRole('button', { name: words.others, exact: true });
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
    await expect(counter).toHaveText(words.oneMore);
    await expectOneLine(page, window, BEFORE.asked[width]);
    expect(await first.getByText('node-a', { exact: true }).evaluate(name => name.scrollWidth - name.clientWidth)).toBeLessThanOrEqual(0);
    await counter.click();
    await expect(second).toBeVisible();
    await expectFits(page, window);
    expect((await box(second)).height).toBe((await box(first)).height);
    await second.getByRole('button', { name: words.close, exact: true }).click();
    await expect.poll(() => posts).toEqual(['/api/machines/node-b/access/close']);
    expect(errors).toEqual([]);
  });
}

test('many machines scroll inside the strip, and the terminal stays', async ({ page }) => {
  const { words, window, errors } = await openWindow(page, { lang: 'en', theme: 'dark', width: 375 }, OPEN, MANY);
  await window.getByRole('button', { name: new RegExp(`^Other machines with access: ${MANY.length}$`) }).click();
  const last = window.getByRole('region', { name: `Access to ${MANY.at(-1)!.machine.name}`, exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last.getByRole('button', { name: words.close, exact: true })).toBeInViewport();
  const [all, whole] = [await box(strip(window)), await box(window)];
  expect(all.height).toBeLessThanOrEqual(whole.height * 0.46);
  await expectFits(page, window);
  expect(errors).toEqual([]);
});

test('someone who may not answer sees who decides in the line, on a phone too', async ({ page }) => {
  const { words, window, errors } = await openWindow(page, { lang: 'ru', theme: 'light', width: 375 }, { ...ASKED, canOpen: false, canClose: false });
  const line = window.getByRole('region', { name: words.asks, exact: true });
  await expect(line.getByText(words.decided)).toBeVisible();
  await expect(line.getByRole('button', { name: words.openDay, exact: true })).toHaveCount(0);
  await expect(line.getByRole('button', { name: words.notNow, exact: true })).toHaveCount(0);
  await expectOneLine(page, window, BEFORE.asked[375]);
  expect(errors).toEqual([]);
});

test('the keyboard walks a line in order and shows where it is', async ({ page }) => {
  const { words, window } = await openWindow(page, { lang: 'ru', theme: 'dark', width: 375 }, ASKED, [SECOND]);
  const line = window.getByRole('region', { name: words.asks, exact: true });
  await line.getByRole('button', { name: words.more, exact: true }).focus();
  for (const name of [words.openDay, words.notNow, words.others]) {
    await page.keyboard.press('Tab');
    const focused = window.getByRole('button', { name, exact: true });
    await expect(focused).toBeFocused();
    expect(await focused.evaluate(el => [getComputedStyle(el).outlineStyle, getComputedStyle(el).clipPath])).toEqual(['solid', 'none']);
  }
});

test('a machine with nothing open or asked shows no strip', async ({ page }) => {
  const { window } = await openWindow(page, { lang: 'en', theme: 'light', width: 1440 }, CLOSED);
  await expect(terminal(window)).toBeVisible();
  await expect(strip(window)).toHaveCount(0);
});
