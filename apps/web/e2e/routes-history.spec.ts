import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { SETTINGS } from './computer-strip-api';
import { serveRoutes } from './routes-api';
import { openTaskCard } from './api';

/* The sections, their history and their links in each language, theme and width, and links a person may not open. */
test.use({ reducedMotion: 'reduce' });

for (const settings of SETTINGS) {
  const { lang, theme, width } = settings;
  const t = lang === 'en' ? en : ru;
  test(`routes and history ${lang} ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ lang, theme }) => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', theme); }, settings);
    await serveRoutes(page);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    await page.goto('/');
    const tab = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });
    for (const [name, path] of [[t.shell.tabs.tasks, '/tasks'], [t.shell.tabs.people, '/people'], [t.shell.tabs.subscriptions, '/subscriptions'], [t.shell.tabs.machines, '/machines'], [t.shell.tabs.map, '/']] as const) {
      await tab(name).click();
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/' : path}$`));
    }
    await tab(t.shell.tabs.people).click();
    await tab(t.shell.tabs.machines).click();
    await page.goBack();
    await expect(page.getByRole('heading', { name: t.people.heading, exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/people$/);
    await page.goForward();
    await expect(page.getByRole('heading', { name: t.machines.heading, exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/machines$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: t.machines.heading, exact: true })).toBeVisible();

    await tab(t.shell.tabs.people).click();
    await page.getByRole('button', { name: t.people.editLabel('Maria'), exact: true }).click();
    await expect(page).toHaveURL(/\/people\/p2$/);
    await expect(page.getByRole('heading', { name: t.people.editHeading('Maria') })).toBeVisible();
    await page.getByRole('button', { name: t.common.cancel, exact: true }).click();
    await tab(t.shell.tabs.machines).click();
    await page.getByRole('button', { name: t.tables.openCard('build-box'), exact: true }).click();
    await expect(page).toHaveURL(/\/machines\/m1$/);
    await expect(page.getByRole('article', { name: 'build-box', exact: true })).toBeVisible();
    await tab(t.shell.tabs.tasks).click();
    await openTaskCard(page, 1);
    await expect(page).toHaveURL(/\/tasks\/t1$/);
    await expect(page.getByRole('complementary', { name: '#1 Checkout step 1', exact: true })).toBeVisible();
    await page.getByRole('complementary', { name: '#1 Checkout step 1', exact: true }).getByRole('button', { name: t.window.close, exact: true }).click();
    await tab(t.shell.tabs.map).click();
    await page.getByRole('button', { name: /^Development/ }).click();
    await expect(page).toHaveURL(/\/departments\/d2$/);
    await expect(page.getByRole('heading', { name: 'Development', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`department-${lang}-${theme}-${width}.png`), animations: 'disabled' });

    for (const [label, path, title] of [[t.about.menu, '/about', t.about.title], [t.settings.menu, '/settings/profile', t.settings.title], [t.updates.menu, '/versions', t.updates.title]] as const) {
      await page.getByRole('button', { name: t.shell.account, exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/departments\/d2$/);
    }
    await page.getByRole('button', { name: t.shell.account, exact: true }).click();
    await page.getByRole('button', { name: t.shell.tabs.improvements, exact: true }).click();
    await expect(page).toHaveURL(/\/improvements$/);
    await expect(page.getByRole('heading', { name: t.improvements.title, exact: true })).toBeVisible();

    await page.goto('/unknown');
    await expect(page.getByRole('heading', { name: t.routes.accessDenied, exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`unavailable-${lang}-${theme}-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: t.routes.home, exact: true }).click();
    await expect(page).toHaveURL(/\/$/);

    expect(errors).toEqual([]);
  });
}

test('login keeps a local deep link and never follows an external return address', async ({ page }) => {
  const external: string[] = [];
  await page.route('https://outside.example/**', route => {
    external.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<h1>External destination</h1>' });
  });
  await serveRoutes(page, { signedOut: true });
  await page.goto('/tasks/t1?next=https://outside.example');
  await page.getByLabel('Email', { exact: true }).fill('ivan@acme.test');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '#1 Checkout step 1', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/t1\?next=https:\/\/outside.example$/);
  expect(new URL(page.url()).hostname).toBe('localhost');
  expect(external).toEqual([]);
});

test('the settings dialog reserves stable scrollbar room', async ({ page }) => {
  await serveRoutes(page);
  await page.goto('/settings/company');
  /* The heading stays put; the body under it scrolls and keeps its room. */
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true }).locator('.settings-scroll')).toHaveCSS('scrollbar-gutter', 'stable');
});

test('unknown and inaccessible links show the same unavailable page', async ({ page }, info) => {
  await serveRoutes(page);
  const foreign: string[] = [];
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.body?.textContent?.includes('Foreign secret')) throw new Error('Foreign data appeared');
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  page.on('pageerror', e => foreign.push(e.message));
  for (const path of ['/unknown', '/people/foreign', '/machines/foreign', '/tasks/foreign', '/departments/foreign', '/people/%25']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Insufficient permissions', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to the map', exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('unavailable.png') });
  await page.getByRole('button', { name: 'Go to the map', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(foreign).toEqual([]);
});

test('an inaccessible task never retains the previous task while its answer is delayed', async ({ page }) => {
  await serveRoutes(page);
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/tasks/foreign', async route => {
    await pending;
    await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Foreign secret' } } });
  });
  await page.goto('/tasks/t1');
  await expect(page.getByText('The shared checkout task.', { exact: true })).toBeVisible();
  const flashes: string[] = [];
  page.on('pageerror', e => flashes.push(e.message));
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (location.pathname === '/tasks/foreign' && document.body.textContent?.includes('The shared checkout task.')) throw new Error('Old task appeared under foreign path');
      if (document.body.textContent?.includes('Foreign secret')) throw new Error('Denied reply leaked');
    }).observe(document, { subtree: true, childList: true, characterData: true });
    history.pushState(null, '', '/tasks/foreign');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText('The shared checkout task.', { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: 'Insufficient permissions', exact: true })).toBeVisible();
  expect(flashes).toEqual([]);
});

test('history keeps a selected machine visible through a different search', async ({ page }) => {
  await serveRoutes(page);
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: ['alpha', 'beta'].map((name, i) => ({
    id: `m${i + 1}`, hostname: `${name}-box`, owner: { id: 'p1', name: 'Ivan' }, os: 'linux', arch: 'x86_64',
    online: false, lastSeenAt: null, load: null, plans: [], lendsTests: true, running: { agents: [], parts: [] },
  })) } }));
  await page.goto('/machines/m1');
  await expect(page.getByRole('article', { name: 'alpha-box', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open the card of beta-box', exact: true }).click();
  await page.getByRole('searchbox').fill('beta-box');
  await page.goBack();
  await expect(page).toHaveURL(/\/machines\/m1$/);
  await expect(page.getByRole('article', { name: 'alpha-box', exact: true })).toBeVisible();
});

test('closing a history-revisited dialog returns to its own section', async ({ page }) => {
  await serveRoutes(page);
  await page.goto('/people');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('navigation').getByRole('button', { name: 'Machines', exact: true }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => history.go(-4));
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('dialog', { name: 'About Hornhoof', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/people$/);
});

for (const [path, api] of [['/versions', '/api/updates']]) {
  test(`a denied ${path} dialog offers a visible way home`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await serveRoutes(page);
    await page.route(`**${api}`, route => route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }));
    await page.goto(path!);
    const dialog = page.getByRole('dialog', { name: 'Insufficient permissions', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Go to the map', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });
}
