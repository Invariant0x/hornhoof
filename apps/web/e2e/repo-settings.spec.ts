import { expect, test, type Locator, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Org, Repository } from '../src/types';
import { ME, serveApi } from './api';
import { inOneRowAtEnd } from './button-row';
import { taskStream } from './hub-turn-api';

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const LONG = 'npm ci --prefer-offline --no-audit --no-fund && ATestRunnerWithANameSoLongThatNoLineOfThePanelCanHoldAllOfItAtOnceAndHasNowhereToBreak --shard={part}/{parts} --reporter=verbose';
const REPO: Repository = { url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234', author: null, testMemoryGb: 4, fullTestCommand: null };

type Product = Org['departments'][number]['products'][number];

function orgWith(repository: Repository, products: Product[] = []): Org {
  return {
    company: ME.company,
    orchestrator: null,
    agents: { total: 0, working: 0 },
    people: [],
    departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', ownerPersonId: null, agents: { total: 0, working: 0 }, products, teams: [], people: [], employees: [], roles: [], repository }],
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
  const products: Product[] = [];
  const puts: unknown[] = [];
  const posts: unknown[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/org') return route.fulfill({ json: orgWith(shown, products) });
    /* A product's briefing, which the panel shows under it. */
    if (/^\/api\/departments\/p\d+\/briefing$/.test(url.pathname)) return route.fulfill({ json: { briefing: { text: '', repositories: [], connected: null, updatedAt: null, by: null } } });
    /* Another repository whose address ends as the department's own does is refused, as the server refuses it. */
    if (url.pathname === '/api/departments/d2/repositories' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; url: string; branch: string };
      posts.push(body);
      if (body.url.endsWith('/app.git')) return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'taken', reason: 'repo_folder_taken' } } });
      const product = { id: `p${products.length + 1}`, name: body.name, repository: { url: body.url, branch: body.branch, tokenLast4: null, author: null, testMemoryGb: 4, fullTestCommand: null } };
      products.push(product);
      await route.fulfill({ status: 201, json: { product } });
      return page.evaluate(() => window.hubTaskEvent('org'));
    }
    if (url.pathname === '/api/version') return route.fulfill({ json: { version: '0.7.0', commit: 'task-386' } });
    if (url.pathname === '/api/updates') return route.fulfill({ json: { current: { version: '0.7.0', commit: 'task-386' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    if (url.pathname === '/api/departments/d2/approval-policy') return route.fulfill({ json: { departmentId: 'd2', owner: null, canSetOwner: false, canChangePolicy: false, candidates: [], rules: [] } });
    if (url.pathname === '/api/departments/d2/repository' && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { fullTestCommand?: string | null; releaseWorkflow?: string | null };
      puts.push(body);
      if (body.fullTestCommand?.includes('{part}/4')) return route.fulfill({ status: 400, json: { error: { code: 'validation', message: en.errors.repo_command_invalid, reason: 'repo_command_invalid' } } });
      shown = {
        ...shown,
        fullTestCommand: body.fullTestCommand === undefined ? shown.fullTestCommand : body.fullTestCommand,
        releaseWorkflow: body.releaseWorkflow === undefined ? shown.releaseWorkflow : body.releaseWorkflow,
      };
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
  return { errors, puts, posts };
}

const section = (page: Page, t: Messages) => page.getByRole('region', { name: t.dept.repositories, exact: true });

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

const OTHER = 'https://github.com/acme/a-mobile-application-whose-repository-name-runs-on-and-on-past-any-line.git';

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`a person adds another repository to a department, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const { errors, posts } = await open(page, lang, theme, width);
        const part = section(page, t);
        await expect(part.getByRole('listitem').first()).toContainText(t.dept.ownRepository);
        await part.getByRole('button', { name: t.dept.addRepository, exact: true }).click();
        const form = part.getByRole('form', { name: t.dept.addRepository });

        /* An address that ends as the department's own does: the server says why, and what was typed stays. */
        await form.getByLabel(t.dept.address, { exact: true }).fill('https://github.com/other/app.git');
        await expect(form.getByLabel(t.dept.repoName, { exact: true })).toHaveValue('app');
        await form.getByRole('button', { name: t.dept.addThis, exact: true }).click();
        await expect(form.getByRole('alert')).toHaveText(t.errors.repo_folder_taken);
        await fitsTheScreen(page, width);
        await part.screenshot({ path: info.outputPath(`repo-add-refused-${width}-${lang}-${theme}.png`) });

        await form.getByLabel(t.dept.address, { exact: true }).fill(OTHER);
        await expect(form.getByLabel(t.dept.repoName, { exact: true })).toHaveValue('a-mobile-application-whose-repository-name-runs-on-and-on-pa');
        await form.getByLabel(t.dept.repoName, { exact: true }).fill('Mobile');
        await fitsTheScreen(page, width);
        await part.screenshot({ path: info.outputPath(`repo-add-form-${width}-${lang}-${theme}.png`) });
        await form.getByRole('button', { name: t.dept.addThis, exact: true }).click();
        await expect.poll(() => posts.at(-1)).toEqual({ name: 'Mobile', url: OTHER, branch: 'main' });

        /* The new product shows with its repository, its long address wrapped inside the panel. */
        const mobile = part.getByRole('listitem', { name: 'Mobile' });
        await expect(mobile.getByText(OTHER)).toBeVisible();
        await expect(part.getByRole('form', { name: t.dept.addRepository })).toHaveCount(0);
        await fitsTheScreen(page, width);
        await part.screenshot({ path: info.outputPath(`repo-add-done-${width}-${lang}-${theme}.png`) });
        expect(errors.filter(e => !/409/.test(e))).toEqual([]);
      });
    }
  }
}

/* A repository form's own buttons stand in one row at its end edge, as in every other form, and each is a target of 44 px
   (Design, #1321): Save and Cancel when the department's repository changes, Add and Cancel when another one is added.
   Neither shipped language is right to left, so right to left is the same panel in a synthetic direction. */
async function tallEnough(form: Locator, names: readonly string[]) {
  for (const name of names) {
    const box = await form.getByRole('button', { name, exact: true }).boundingBox();
    expect(box?.height ?? 0, `${name} is a target of 44 px`).toBeGreaterThanOrEqual(44);
  }
}

for (const lang of ['en', 'ru'] as const) {
  for (const width of [1440, 375]) {
    for (const dir of ['ltr', 'rtl'] as const) {
      test(`a repository form's buttons stand in one row at the end edge, 44 px tall, in ${lang}, ${dir}, at ${width}px`, async ({ page, browserName }, info) => {
        const t = MESSAGES[lang];
        const { errors } = await open(page, lang, 'light', width);
        await page.evaluate(dir => { document.documentElement.dir = dir; }, dir);
        const part = section(page, t);
        await part.getByRole('button', { name: t.dept.change, exact: true }).click();
        const edit = part.locator('form').filter({ has: page.getByLabel(t.dept.fullCommand, { exact: true }) });
        await expect(edit).toBeVisible();
        await inOneRowAtEnd(edit, [t.common.save, t.common.cancel]);
        await tallEnough(edit, [t.common.save, t.common.cancel]);
        await fitsTheScreen(page, width);
        if (browserName === 'chromium') await edit.screenshot({ path: info.outputPath(`repo-edit-buttons-${lang}-${dir}-${width}.png`) });
        await edit.getByRole('button', { name: t.common.cancel, exact: true }).click();

        await part.getByRole('button', { name: t.dept.addRepository, exact: true }).click();
        const add = part.getByRole('form', { name: t.dept.addRepository });
        await expect(add).toBeVisible();
        await inOneRowAtEnd(add, [t.dept.addThis, t.common.cancel]);
        await tallEnough(add, [t.dept.addThis, t.common.cancel]);
        await fitsTheScreen(page, width);
        if (browserName === 'chromium') await add.screenshot({ path: info.outputPath(`repo-add-buttons-${lang}-${dir}-${width}.png`) });
        expect(errors).toEqual([]);
      });
    }
  }
}

const WORKFLOW = '.github/workflows/continuous-integration-and-release-of-every-version.yml';

for (const lang of ['en', 'ru'] as const) {
  for (const width of [1440, 375]) {
    test(`a person names the release workflow and takes it away, in ${lang}, at ${width}px`, async ({ page }, info) => {
      const t = MESSAGES[lang];
      const { errors, puts } = await open(page, lang, 'light', width);
      const part = section(page, t);
      await expect(part.getByText(t.dept.noReleaseWorkflow)).toBeVisible();
      await part.getByRole('button', { name: t.dept.change, exact: true }).click();
      const field = part.getByLabel(t.dept.releaseWorkflow, { exact: true });
      await expect(field).toHaveValue('');
      await field.fill(WORKFLOW);
      await part.screenshot({ path: info.outputPath(`repo-workflow-form-${width}-${lang}.png`) });
      await fitsTheScreen(page, width);
      await part.getByRole('button', { name: t.common.save, exact: true }).click();
      await expect.poll(() => puts.at(-1)).toEqual({ url: REPO.url, branch: 'main', releaseWorkflow: WORKFLOW });

      /* A long path wraps inside the panel. */
      await expect(part.getByText(t.dept.releaseWorkflowIs(WORKFLOW))).toBeVisible();
      await expect(part.getByText(t.dept.noReleaseWorkflow)).toHaveCount(0);
      await fitsTheScreen(page, width);
      await part.screenshot({ path: info.outputPath(`repo-workflow-named-${width}-${lang}.png`) });

      await part.getByRole('button', { name: t.dept.change, exact: true }).click();
      await expect(field).toHaveValue(WORKFLOW);
      await field.fill('');
      await part.getByRole('button', { name: t.common.save, exact: true }).click();
      await expect.poll(() => puts.at(-1)).toEqual({ url: REPO.url, branch: 'main', releaseWorkflow: null });
      await expect(part.getByText(t.dept.noReleaseWorkflow)).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}
