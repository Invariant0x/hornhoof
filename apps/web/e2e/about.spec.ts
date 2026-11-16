import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { ME, serveApi } from './api';

const VERSION = { version: '0.5.0', commit: 'abc1234' };
const PERSON = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };

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
    await expect(dialog.getByRole('link')).toHaveCount(3);
    const words = language === 'en' ? en : ru;
    /* Feedback is closed to one sentence and its button until the person opens it. */
    const feedback = dialog.getByRole('region', { name: words.feedback.section, exact: true });
    const write = feedback.getByRole('button', { name: words.feedback.write, exact: true });
    await expect(write).toBeVisible();
    await expect(feedback.getByRole('textbox')).toHaveCount(0);
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(write).toBeFocused();
    await page.keyboard.press('Tab');
    const close = dialog.getByRole('button', { name: language === 'en' ? 'Close' : 'Закрыть', exact: true });
    await expect(close).toBeFocused();
    /* Three links and Write to developers, then back to the cross. */
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
    /* As Design's reference draws it: 480 px, or the screen less 16 px on each side; a 44 px cross; 14 px text, its facts
       13.5 px and its author 12 px; the description, the facts, the author, a line, then Feedback. */
    expect(Math.abs(box!.width - Math.min(480, width - 32)), 'the window is 480 px or the screen less 32 px').toBeLessThanOrEqual(1);
    const cross = (await close.boundingBox())!;
    expect([Math.round(cross.width), Math.round(cross.height)], 'the cross is a 44 px target').toEqual([44, 44]);
    const fontSize = (selector: string) => dialog.locator(selector).first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    expect(await fontSize(':scope > p')).toBe(14);
    expect(await fontSize('.facts')).toBe(13.5);
    expect(await fontSize('.about-author')).toBe(12);
    expect(await dialog.evaluate(element => [...element.children].map(child => child.tagName.toLowerCase() + (child.className ? `.${child.className}` : '')))).toEqual(['header', 'p', 'dl.facts', 'p.about-author', 'hr.about-sep', 'section.about-feedback']);
    if (width === 1440) expect(await dialog.evaluate(element => element.scrollHeight <= element.clientHeight), 'the window fits without scrolling').toBe(true);
    /* Writing takes the whole width of the window inside its padding, as the facts do. */
    const edges = await dialog.evaluate(element => [...element.querySelectorAll(':scope > .facts, :scope > .about-feedback')].map(part => {
      const rect = part.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.right)];
    }));
    expect(edges[1]).toEqual(edges[0]);
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
  await expect(dialog.locator('dd').getByText('Loading…')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'MIT', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('about-loading.png') });
  release();
  await expect(dialog.getByText('The server version could not be loaded. Close this window and open it again to retry.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('about-version-failed.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
