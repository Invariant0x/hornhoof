import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PSEUDO_LOCALES } from '@hornhoof/protocol';
import { ME, serveApi } from './api';

/* The main screens in the two languages made for tests: English 40% longer than it is and marked, and English mirrored.
   A text that skips the language files shows plain, a layout that cannot hold a longer text clips it or scrolls the
   page sideways, and one that does not mirror shows in the wrong direction. Shots go to the folder a run collects. */
const SHOTS = process.env.HH_OUT ? join(process.env.HH_OUT, 'pseudo-locales') : fileURLToPath(new URL('results/pseudo-locales-shots', import.meta.url));
const VERSION = { version: '0.5.0', commit: 'abc1234' };
const WIDTHS = [375, 1440];

/* What a person cannot read on the page: the page scrolls sideways, a text is cut with an ellipsis, or a box that hides
   its overflow holds more than it shows. A map or a canvas moves its content on purpose and is left out, and so is the line
   of what happened, which ends in an ellipsis on its one row on purpose, its whole text in its title (#2102). */
const clipped = (page: Page, scope: string) => page.locator(scope).first().evaluate((root: HTMLElement) => {
  const found: string[] = [];
  const sideways = document.documentElement.scrollWidth - window.innerWidth;
  if (sideways > 1) found.push(`the page scrolls ${sideways}px sideways`);
  const name = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : ''}`;
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    /* Text kept for a screen reader is clipped to nothing on purpose. */
    if (el.closest('svg, canvas, .world, .map, .tr-map, .sr, .ticker, [aria-hidden="true"]') || !el.getClientRects().length) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const own = [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && /\p{L}/u.test(node.textContent ?? ''));
    if (!own) continue;
    if (style.textOverflow === 'ellipsis') found.push(`${name(el)} cuts its text with an ellipsis`);
    const hides = style.overflowX === 'hidden' || style.overflowX === 'clip';
    if (hides && el.scrollWidth > el.clientWidth + 1) found.push(`${name(el)} hides ${el.scrollWidth - el.clientWidth}px of its text sideways`);
    const hidesDown = style.overflowY === 'hidden' || style.overflowY === 'clip';
    if (hidesDown && el.scrollHeight > el.clientHeight + 1 && style.maxHeight === 'none') found.push(`${name(el)} hides ${el.scrollHeight - el.clientHeight}px of its text downward`);
  }
  return found;
});

for (const { id: language, dir } of PSEUDO_LOCALES) for (const width of WIDTHS) {
  test.describe(`${language} at ${width}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 700 : 900 });
      await serveApi(page);
      for (const [path, body] of Object.entries({ '/api/me': ME, '/api/version': VERSION, '/api/updates/current': VERSION })) {
        await page.route(`**${path}`, route => route.fulfill({ json: body }));
      }
      await page.addInitScript(({ language, theme }) => {
        localStorage.setItem('hh-lang', language);
        localStorage.setItem('hh-theme', theme);
      }, { language, theme: 'light' });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      mkdirSync(SHOTS, { recursive: true });
    });

    /* One screen: it is shown, it is photographed, and nothing on it is clipped. */
    const check = async (page: Page, screen: string, scope: string) => {
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `${language}-${width}-${screen}.png`) });
      expect(await clipped(page, scope), `${screen}`).toEqual([]);
    };

    test('every text of the map screen comes from the language and the page keeps in its width', async ({ page }) => {
      /* A pseudo-language marks each of its texts; a screen text that skipped the files shows without the mark. */
      await expect(page.locator('.avatar')).toBeVisible();
      await check(page, 'map', 'body');
    });

    test('the account menu, Settings and About hold a longer text', async ({ page }) => {
      await page.locator('.avatar').click();
      const rows = page.locator('.account-menu .mi');
      /* A pseudo-language marks each of its texts; a menu text that skipped the language files shows without the mark. */
      if (language === 'en-XL') for (const text of await rows.allTextContents()) expect(text, 'a text with no mark').toContain('⟦');
      await check(page, 'account-menu', '.account-menu');
      await rows.nth(1).click();
      const settings = page.locator('[role="dialog"]').first();
      await expect(settings).toBeVisible();
      await check(page, 'settings', '[role="dialog"]');
      for (const [index, button] of (await settings.locator('.settings-nav button').all()).entries()) {
        await button.click();
        await check(page, `settings-group-${index}`, '[role="dialog"]');
      }
      await page.keyboard.press('Escape');
      await page.locator('.avatar').click();
      await page.locator('.account-menu .mi').nth(-2).click();
      await expect(page.locator('[role="dialog"]').first()).toBeVisible();
      await check(page, 'about', '[role="dialog"]');
    });

    test('a department opens in a longer text', async ({ page }) => {
      await page.locator('.dept').first().click();
      await check(page, 'department', 'body');
    });
  });
}

/* The check itself: it must find what it looks for, or a page that clips would pass it. */
test('the check finds a text cut with an ellipsis, a box that hides its text and a page that scrolls sideways', async ({ page }) => {
  await serveApi(page);
  await page.goto('/');
  await expect(page.locator('.avatar')).toBeVisible();
  expect(await clipped(page, 'body')).toEqual([]);
  await page.evaluate(() => {
    const cut = document.createElement('p');
    cut.id = 'cut';
    cut.textContent = 'A long line that does not fit the room it was given';
    cut.style.cssText = 'width: 40px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis';
    const wide = document.createElement('div');
    wide.style.cssText = 'width: 5000px; height: 1px';
    document.body.append(cut, wide);
  });
  const found = await clipped(page, 'body');
  expect(found.some(line => line.includes('p#cut') || line.startsWith('p ') || line.includes('ellipsis'))).toBe(true);
  expect(found.some(line => line.includes('sideways') && line.startsWith('the page'))).toBe(true);
});
