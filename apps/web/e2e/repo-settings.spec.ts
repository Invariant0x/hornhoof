import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Org, Repository } from '../src/types';
import { ME, serveApi } from './api';
import { taskStream } from './hub-turn-api';

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const LONG = 'npm ci --prefer-offline --no-audit --no-fund && ATestRunnerWithANameSoLongThatNoLineOfThePanelCanHoldAllOfItAtOnceAndHasNowhereToBreak --shard={part}/{parts} --reporter=verbose';
const REPO: Repository = { url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234', author: null, testMemoryGb: 4, fullTestCommand: null };

function orgWith(repository: Repository): Org {
  return {
    company: ME.company,
    orchestrator: null,
    agents: { total: 0, working: 0 },
    people: [],
    departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', ownerPersonId: null, agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], repository }],
  };
}

/* The department's panel as a person meets it. A save is answered as the server would: a part with no number of parts is refused. */
async function open(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number, repository = REPO) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await taskStream(page);
  await serveApi(page);
  let shown = repository;
  const puts: unknown[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/org') return route.fulfill({ json: orgWith(shown) });
    if (url.pathname === '/api/version') return route.fulfill({ json: { version: '0.7.0', commit: 'task-386' } });
    if (url.pathname === '/api/updates') return route.fulfill({ json: { current: { version: '0.7.0', commit: 'task-386' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    if (url.pathname === '/api/departments/d2/approval-policy') return route.fulfill({ json: { departmentId: 'd2', owner: null, canSetOwner: false, canChangePolicy: false, candidates: [], rules: [] } });
    if (url.pathname === '/api/departments/d2/repository' && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { fullTestCommand?: string | null };
      puts.push(body);
      if (body.fullTestCommand?.includes('{part}/4')) return route.fulfill({ status: 400, json: { error: { code: 'validation', message: en.errors.repo_command_invalid, reason: 'repo_command_invalid' } } });
      shown = { ...shown, fullTestCommand: body.fullTestCommand === undefined ? shown.fullTestCommand : body.fullTestCommand };
      await route.fulfill({ json: { repository: shown } });
      /* As the server tells every open page. */
      return page.evaluate(() => window.hubTaskEvent('org'));
    }
    return route.fallback();
  });
  await page.goto('/departments/d2');
  await page.getByRole('button', { name: MESSAGES[lang].dept.about, exact: true }).click();
  await page.evaluate(async () => { await document.fonts.ready; });
  /* Tall enough that the panel shows the whole section, without scrolling, in its screenshots. */
  await page.setViewportSize({ width, height: 2200 });
  return { errors, puts };
}

const section = (page: Page, t: Messages) => page.getByRole('region', { name: t.dept.repository, exact: true });

async function fitsTheScreen(page: Page, width: number) {
  const scroll = await page.evaluate(() => {
    /* The panel's body is what scrolls, and a line too wide makes it scroll sideways. */
    const drawer = document.querySelector('.dv-drawer-b');
    return { page: document.documentElement.scrollWidth, drawer: drawer?.scrollWidth ?? 0, inner: drawer?.clientWidth ?? 0 };
  });
  expect(scroll.page, 'the page has no sideways scroll').toBeLessThanOrEqual(width);
  expect(scroll.drawer, 'the panel has no sideways scroll').toBeLessThanOrEqual(scroll.inner);
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`a person reads, changes and takes away the full test command, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const { errors, puts } = await open(page, lang, theme, width);
        const part = section(page, t);
        await expect(part.getByText(t.dept.noFullCommand)).toBeVisible();
        await part.screenshot({ path: info.outputPath(`repo-none-${width}-${lang}-${theme}.png`) });

        await part.getByRole('button', { name: t.dept.change, exact: true }).click();
        const field = part.getByLabel(t.dept.fullCommand, { exact: true });
        await expect(field).toHaveValue('');

        /* A part with no number of parts: the server says why, and what was typed stays. */
        await field.fill('vitest --shard={part}/4');
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect(part.getByRole('alert')).toHaveText(t.errors.repo_command_invalid);
        await expect(field).toHaveValue('vitest --shard={part}/4');
        await part.screenshot({ path: info.outputPath(`repo-refused-${width}-${lang}-${theme}.png`) });
        await fitsTheScreen(page, width);

        await field.fill(LONG);
        await part.screenshot({ path: info.outputPath(`repo-form-${width}-${lang}-${theme}.png`) });
        await fitsTheScreen(page, width);
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect.poll(() => puts.at(-1)).toEqual({ url: REPO.url, branch: 'main', fullTestCommand: LONG });

        /* A long command wraps inside the panel. */
        await expect(part.getByText(t.dept.fullCommandIs(LONG))).toBeVisible();
        await fitsTheScreen(page, width);
        await part.screenshot({ path: info.outputPath(`repo-named-${width}-${lang}-${theme}.png`) });
        await page.screenshot({ path: info.outputPath(`repo-page-${width}-${lang}-${theme}.png`) });

        await part.getByRole('button', { name: t.dept.change, exact: true }).click();
        await expect(field).toHaveValue(LONG);
        await field.fill('');
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect.poll(() => puts.at(-1)).toEqual({ url: REPO.url, branch: 'main', fullTestCommand: null });
        await expect(part.getByText(t.dept.noFullCommand)).toBeVisible();
        expect(errors.filter(e => !/400/.test(e))).toEqual([]);
      });
    }
  }
}
