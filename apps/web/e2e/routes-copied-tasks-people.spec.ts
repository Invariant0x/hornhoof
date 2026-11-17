import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { SETTINGS } from './computer-strip-api';
import { serveRoutes } from './routes-api';

/* A copied link to a task or a person opens the same record for another person, in each language, theme and width. */
test.use({ reducedMotion: 'reduce' });

for (const settings of SETTINGS) {
  const { lang, theme, width } = settings;
  const t = lang === 'en' ? en : ru;
  for (const [path, role, title] of [
      ['/tasks/t1', 'complementary', '#1 Checkout step 1'],
      ['/people/p2', 'heading', t.people.editHeading('Maria')],
    ] as const) {
    test(`copied ${path} ${lang} ${theme} ${width}`, async ({ page, browser }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(({ lang, theme }) => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', theme); }, settings);
      await serveRoutes(page);
      await page.goto(path);
      await expect(page.getByRole(role, { name: title, exact: true })).toBeVisible();
      const copied = page.url();
      const other = await browser.newContext({ viewport: { width, height: 1000 } });
      const second = await other.newPage();
      await second.addInitScript(({ lang, theme }) => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', theme); }, settings);
      await serveRoutes(second, { person: 'p2' });
      await second.goto(copied);
      await expect(second.getByRole(role, { name: title, exact: true })).toBeVisible();
      await second.reload();
      await expect(second.getByRole(role, { name: title, exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`copied-${path.split('/')[1]}-${lang}-${theme}-${width}.png`), animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await other.close();
    });
    }
}
