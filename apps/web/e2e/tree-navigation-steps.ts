import { expect, type Page } from '@playwright/test';
import { serveTree } from './tree-api';

/* The tree of a turn, read-only: tree-navigation-move.spec.ts moves and zooms it, tree-navigation-panels.spec.ts opens the
   department's panels on its left, tree-navigation-agent.spec.ts an agent's window from it. Each in both languages and themes,
   wide and narrow. */
type Lang = 'en' | 'ru';
type Theme = 'light' | 'dark';
export function variants(): { lang: Lang; theme: Theme; width: number; variant: string; close: string }[] {
  return (['en', 'ru'] as const).flatMap(lang => (['light', 'dark'] as const).flatMap(theme => [1440, 375].map(width =>
    ({ lang, theme, width, variant: `${lang}, ${theme}, ${width}px`, close: lang === 'en' ? 'Close' : 'Закрыть' }))));
}

export async function openTree(page: Page, lang: Lang, theme: Theme, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (r.method() !== 'GET') writes.push(r.method() + ' ' + new URL(r.url()).pathname); });
  await serveTree(page, { during: true });
  await page.goto('/');
  await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
  await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
  await expect(page.locator('.tv-in')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { errors, writes };
}
