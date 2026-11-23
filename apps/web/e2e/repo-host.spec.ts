import { expect, test, type Locator, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Org, RepoHost, RepoKey } from '../src/types';
import { ME, serveApi } from './api';
import { taskStream } from './hub-turn-api';

/* The GitHub key Hornhoof creates repositories with: the company's in its settings, a department's own on its screen. Each
   look is saved where SHOTS names, else with the test's results. */

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
/* The longest owner GitHub takes, so that the line naming it is as long as it gets. */
const OWNER = 'acme-a-very-long-organization-name-x39';
const KEY: RepoKey = { provider: 'github', owner: OWNER, tokenLast4: '1111' };
const SHOTS = process.env.SHOTS;

async function prepare(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  /* Calls the test does not answer, as the version and the updates, fail as the server fails them; only the page's own errors count. */
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
  await taskStream(page);
  await serveApi(page);
  return errors;
}

const shot = (look: string) => async (target: Page | Locator, name: string, info: { outputPath: (name: string) => string }) => {
  const file = `repo-host-${name}-${look}.png`;
  await target.screenshot({ path: SHOTS ? `${SHOTS}/${file}` : info.outputPath(file) });
};

/* Nothing in it is wider than the box that holds it, and the page does not scroll sideways. */
async function fits(page: Page, box: string, width: number) {
  const sizes = await page.evaluate(selector => {
    const el = document.querySelector(selector);
    return { page: document.documentElement.scrollWidth, scroll: el?.scrollWidth ?? 0, inner: el?.clientWidth ?? 0 };
  }, box);
  expect(sizes.page, 'the page has no sideways scroll').toBeLessThanOrEqual(width);
  expect(sizes.scroll, `${box} has no sideways scroll`).toBeLessThanOrEqual(sizes.inner);
}

function orgWith(repoHost: RepoHost | null): Org {
  return {
    company: ME.company,
    orchestrator: null,
    agents: { total: 0, working: 0 },
    people: [],
    departments: [{ id: 'd2', name: 'Marketing', templateKey: null, roleCode: 'MKT', about: '', ownerPersonId: null, agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], repository: null, repoHost }],
  };
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      const look = `${width}-${lang}-${theme}`;
      const capture = shot(look);

      test(`a person saves the company's GitHub key in its settings, under Integrations, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const errors = await prepare(page, lang, theme, width);
        let saved: RepoKey | null = null;
        const puts: unknown[] = [];
        await page.route('**/api/link', route => route.fulfill({ json: { link: null, domain: 'hornhoof.org' } }));
        await page.route('**/api/repo-host', async route => {
          if (route.request().method() === 'GET') return route.fulfill({ json: { host: saved } });
          const body = route.request().postDataJSON() as { owner: string; token?: string };
          puts.push(body);
          if (body.owner.includes('/')) return route.fulfill({ status: 400, json: { error: { code: 'validation', message: 'x', reason: 'repo_host_invalid' } } });
          saved = { ...KEY, owner: body.owner };
          return route.fulfill({ json: { host: saved } });
        });
        /* The company's key is a card of Integrations, beside Google Sheets. */
        await page.goto('/settings/integrations');
        const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
        const part = dialog.getByRole('article', { name: t.repoHost.title, exact: true });
        await expect(part.getByText(t.repoHost.none)).toBeVisible();
        await page.evaluate(async () => { await document.fonts.ready; });
        await capture(dialog, 'settings-none', info);

        await part.getByRole('button', { name: t.repoHost.save, exact: true }).click();
        await part.getByLabel(t.repoHost.owner, { exact: true }).fill('github.com/acme');
        await part.getByLabel(t.repoHost.key, { exact: true }).fill('ghp_x1111');
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect(part.getByRole('alert')).toHaveText(t.errors.repo_host_invalid);
        await expect(part.getByLabel(t.repoHost.owner, { exact: true })).toHaveValue('github.com/acme');
        await fits(page, '.dialog', width);
        await part.getByRole('alert').scrollIntoViewIfNeeded();
        await capture(dialog, 'settings-refused', info);

        await part.getByLabel(t.repoHost.owner, { exact: true }).fill(OWNER);
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect(part.getByText(t.repoHost.saved(OWNER, '1111'))).toBeVisible();
        expect(puts.at(-1)).toEqual({ owner: OWNER, token: 'ghp_x1111' });
        await fits(page, '.dialog', width);
        await capture(dialog, 'settings-saved', info);

        await part.getByRole('button', { name: t.repoHost.remove, exact: true }).click();
        const removeAsk = page.getByRole('alertdialog', { name: t.repoHost.confirm.remove.title });
        await expect(removeAsk).toHaveAccessibleDescription(t.repoHost.confirm.remove.effect(OWNER));
        await fits(page, '[role="alertdialog"]', width);
        await capture(removeAsk, 'settings-remove', info);
        expect(errors).toEqual([]);
      });

      test(`a department's screen names the key it uses and takes one of its own, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const errors = await prepare(page, lang, theme, width);
        let host: RepoHost | null = { ...KEY, own: false };
        const puts: unknown[] = [];
        await page.route('**/api/**', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/api/org') return route.fulfill({ json: orgWith(host) });
          if (url.pathname === '/api/departments/d2/approval-policy') return route.fulfill({ json: { departmentId: 'd2', owner: null, canSetOwner: false, canChangePolicy: false, candidates: [], rules: [] } });
          if (url.pathname === '/api/departments/d2/repo-host' && route.request().method() === 'PUT') {
            const body = route.request().postDataJSON() as { owner: string };
            puts.push(body);
            host = { ...KEY, owner: body.owner, tokenLast4: '2222', own: true };
            await route.fulfill({ json: { host } });
            /* As the server tells every open page. */
            return page.evaluate(() => window.hubTaskEvent('org'));
          }
          return route.fallback();
        });
        await page.goto('/departments/d2');
        await page.getByRole('button', { name: t.dept.about, exact: true }).click();
        await page.evaluate(async () => { await document.fonts.ready; });
        await page.setViewportSize({ width, height: 2200 });
        const part = page.getByRole('region', { name: t.repoHost.title, exact: true });
        await expect(part.getByText(t.repoHost.deptCompany(OWNER))).toBeVisible();
        await fits(page, '.dv-drawer-b', width);
        await capture(part, 'department-company', info);

        await part.getByRole('button', { name: t.repoHost.own, exact: true }).click();
        await expect(part.getByLabel(t.repoHost.key, { exact: true })).toHaveAttribute('type', 'text');
        await expect(part.getByLabel(t.repoHost.key, { exact: true })).toHaveCSS('-webkit-text-security', 'disc');
        await part.getByLabel(t.repoHost.owner, { exact: true }).fill(OWNER);
        await part.getByLabel(t.repoHost.key, { exact: true }).fill('github_pat_2222');
        await fits(page, '.dv-drawer-b', width);
        await capture(part, 'department-form', info);
        await part.getByRole('button', { name: t.common.save, exact: true }).click();
        await expect(part.getByText(t.repoHost.deptOwn(OWNER, '2222'))).toBeVisible();
        expect(puts).toEqual([{ owner: OWNER, token: 'github_pat_2222' }]);
        await fits(page, '.dv-drawer-b', width);
        await capture(part, 'department-own', info);
        await capture(page, 'department-page', info);
        expect(errors).toEqual([]);
      });
    }
  }
}
