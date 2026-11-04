import { expect, test, type Page } from '@playwright/test';
import { ME, serveApi } from './api';

const VERSION = { version: '0.5.0', commit: 'abc1234' };
const PERSON = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };
/* The window is small: it was 292 and 448 pixels tall on these screens before it was made compact. */
const TALLEST: Record<number, number> = { 1440: 220, 375: 240 };

async function prepare(page: Page, language: string, theme: string): Promise<void> {
  await serveApi(page);
  for (const [path, body] of Object.entries({ '/api/me': PERSON, '/api/version': VERSION, '/api/updates/current': VERSION })) {
    await page.route(`**${path}`, route => route.fulfill({ json: body }));
  }
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
}

for (const language of ['en', 'ru']) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`About ${language} ${theme} ${width}`, async ({ page }, info) => {
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: width === 375 ? 667 : 900 });
    await prepare(page, language, theme);
    await page.goto('/');
    const account = page.getByRole('button', { name: language === 'en' ? 'Account' : 'Аккаунт', exact: true });
    const open = async () => {
      await account.click();
      await page.getByRole('button', { name: language === 'en' ? 'About' : 'О программе', exact: true }).click();
    };
    await open();
    const dialog = page.getByRole('dialog', { name: language === 'en' ? 'About Hornhoof' : 'О программе Hornhoof' });
    await expect(dialog.getByText('0.5.0 (abc1234)')).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveCount(4);
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('link', { name: 'hornhoof.org', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const close = dialog.getByRole('button', { name: language === 'en' ? 'Close' : 'Закрыть', exact: true });
    await expect(close).toBeFocused();
    for (let index = 0; index < 5; index++) await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.evaluate(async () => { await document.fonts.ready; });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`about-${language}-${theme}-${width}.png`), fullPage: true });
    await expect(dialog).not.toContainText(language === 'en' ? 'Developer' : 'Разработчик');
    await expect(dialog.locator('.about-author')).toHaveText(language === 'en' ? 'Author: Ivan Korol, © 2026' : 'Автор: Ivan Korol, © 2026');
    expect(box!.height, 'the window is clearly lower than it was').toBeLessThan(TALLEST[width]!);
    expect(box!.width, 'the window is no wider than a small window').toBeLessThanOrEqual(420);
    expect(await dialog.evaluate(element => element.scrollHeight <= element.clientHeight), 'the window fits without scrolling').toBe(true);
    const fontSize = (selector: string) => dialog.locator(selector).first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    expect(await fontSize('.facts')).toBeLessThanOrEqual(13);
    expect(await fontSize('.about-author')).toBeLessThanOrEqual(12.5);
    await dialog.getByRole('button', { name: language === 'en' ? 'Close' : 'Закрыть', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(account).toBeFocused();
    await open();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await open();
    await page.mouse.click(4, 4);
    await expect(dialog).toHaveCount(0);
    await expect(account).toBeFocused();
    expect(problems).toEqual([]);
  });
}

test('About stays useful while its version loads and when it fails', async ({ page }, info) => {
  await prepare(page, 'en', 'light');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/updates/current', async route => {
    await pending;
    await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Unavailable.' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'About Hornhoof' });
  await expect(dialog.getByText('Loading…')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'MIT', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('about-loading.png') });
  release();
  await expect(dialog.getByText('The server version could not be loaded. Close this window and open it again to retry.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('about-version-failed.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
