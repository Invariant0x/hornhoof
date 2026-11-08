import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { ECHELON_WORKFLOW } from '../test/echelon-workflow';
import { detail, serveApi, TASKS } from './api';

const dictionaries: Record<Language, Messages> = { en, ru };
/* Rank the strings this panel renders, using the shipped registry rather than a fixed locale pair. */
const ranked = LANGUAGES.map(({ id }) => ({ id, size: Object.values(dictionaries[id].tasks)
  .flatMap(value => typeof value === 'string' ? [value] : typeof value === 'object' && value !== null ? Object.values(value).filter(v => typeof v === 'string') : [])
  .reduce((n, value) => n + value.length, 0) })).sort((a, b) => a.size - b.size);
const locales = [...new Set([ranked[0]!.id, ranked[ranked.length - 1]!.id, ...LANGUAGES.filter(l => /^(ar|he|fa|ur)$/.test(l.id)).map(l => l.id)])];
const longOwner = 'ReviewOwnerWithAnUnbrokenIdentifier'.repeat(8);
const longReason = 'Review found a risk in external input. '.repeat(12);
const workflow = { ...ECHELON_WORKFLOW, stage: 'security' as const, ownerAgentId: longOwner,
  security: { included: true, addedByAgentId: 'reviewer', reason: longReason },
  stages: ECHELON_WORKFLOW.stages.map(stage => stage.stage === 'review' ? { ...stage, status: 'complete' as const }
    : stage.stage === 'security' ? { ...stage, status: 'active' as const, ownerAgentId: longOwner, reason: longReason } : stage) };
const task = { ...detail(TASKS[0]!), echelons: workflow, body: '', brief: '', title: 'Echelon task' };

async function serveWorkflow(page: Page) {
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/tasks/t1') return route.fulfill({ json: { task } });
    if (url.pathname === '/api/tasks') return route.fulfill({ json: { tasks: [task] } });
    return route.fallback();
  });
}

async function fits(panel: Locator, route: Locator) {
  const sizes = await route.evaluate(element => {
    const panel = element.closest('.acard')!;
    const outside = panel.getBoundingClientRect();
    return {
      scroll: element.scrollWidth, width: element.clientWidth,
      escaped: [...element.querySelectorAll('li, b, span, p')].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.left < outside.left - 1 || rect.right > outside.right + 1;
      }).map(el => el.textContent),
    };
  });
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
  expect(sizes.escaped).toEqual([]);
  await expect(panel.getByRole('button', { name: dictionaries[await panel.page().evaluate(() => localStorage.getItem('hh-lang')) as Language].common.close, exact: true })).toBeVisible();
}

for (const locale of locales) for (const theme of ['light', 'dark']) for (const width of [375, 1440]) {
  test(`actual task workflow: ${locale} ${theme} ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('hh-lang', locale);
      localStorage.setItem('hh-theme', theme);
    }, { locale, theme });
    await serveWorkflow(page);
    await page.goto('/tasks/t1');
    const panel = page.getByRole('complementary', { name: '#1 Echelon task' });
    const route = panel.getByRole('list', { name: locale === 'ru' ? 'Маршрут задачи' : 'Task workflow' });
    await expect(route).toBeVisible();
    expect(await route.locator('li > b').allTextContents()).toEqual(['Architecture', 'Development', 'Review', 'Security', 'Tests']);
    await expect(route.locator('[aria-current="step"]')).toContainText('Security');
    await expect(route).toContainText(longOwner);
    await expect(route).toContainText(longReason.trim());
    await page.evaluate(() => document.fonts.ready);
    await fits(panel, route);
    await route.locator('[aria-current="step"]').scrollIntoViewIfNeeded();
    await info.attach('actual-workflow', { body: await panel.screenshot(), contentType: 'image/png' });
    expect(errors).toEqual([]);
  });
}
