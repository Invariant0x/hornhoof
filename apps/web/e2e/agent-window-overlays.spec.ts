import { expect, test, type Locator } from '@playwright/test';
import { box, chooseTerminal } from './api';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

async function activate(button: Locator) {
  await button.focus();
  await button.press('Enter');
}

/* A strip takes no room from what is on a wide screen. On a phone the row of strips takes the foot of the screen, so the same
   picture stands half the row higher. */
async function expectPlaceBesideStrip(picture: Locator, alone: Awaited<ReturnType<typeof box>>, width: number) {
  const { y, ...rest } = await box(picture);
  const { y: aloneY, ...same } = alone;
  expect(rest).toEqual(same);
  expect(y).toBeCloseTo(aloneY - (width > 760 ? 0 : 22));
}

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  test(`overlays and minimized layout in ${lang}, ${theme}, ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme);
    }, { lang, theme });
    await chooseTerminal(page);
    const en = lang === 'en';
    const errors: string[] = [], stops: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0 };
    await serveAgentWindow(page, live);
    await page.route('**/api/agents/b1/stop', route => {
      stops.push(route.request().method());
      return route.fulfill({ json: {} });
    });
    await page.route('**/api/link', route => route.fulfill({ json: { link: null, domain: 'hornhoof.org' } }));
    await page.route('**/api/link/names/acme', route => route.fulfill({ json: { name: 'acme', free: true } }));
    await page.route('**/api/updates', route => route.fulfill({ json: {
      current: { version: '0.5.1', commit: 'abc1234', migrations: 1 }, available: false, latest: null,
      versions: [], error: null, checkedAt: null, updater: { present: false, status: null, waiting: null },
    } }));
    await page.route('**/api/updates/current', route => route.fulfill({ json: { version: '0.5.1', commit: 'abc1234' } }));
    await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: {
      now: '2026-11-04T00:00:00Z', turn: null, repository: true, stage: 'work', lines: [], review: null, time: [], idle: [],
    } } }));
    await page.goto('/');
    const mapWorld = page.locator('.map .world');
    const fitName = en ? 'Show everything' : 'Показать все';
    await page.locator('.map').getByRole('button', { name: fitName, exact: true }).click();
    const mapWithoutWindow = await box(mapWorld);
    await page.getByRole('button', { name: /^Development/ }).click();
    const department = page.locator('.dview'), world = department.locator('.world');
    const fit = department.getByRole('button', { name: fitName, exact: true });
    await fit.click();
    const withoutWindow = await box(world);
    await page.getByRole('region', { name: en ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
    const window = page.getByRole('complementary', { name: /^Bruno,/ });
    await expect(window.locator('.xterm-screen')).toBeVisible();
    const connections = live.connections;
    const main = page.getByRole('main');
    await expect(main).toHaveClass(/with-window/);
    const drawerNames = en ? ['About the department', 'Speed'] : ['Об отделе', 'Скорость'];
    for (const name of drawerNames) {
      await activate(department.getByRole('button', { name, exact: true }));
      const drawer = page.getByRole('complementary', { name, exact: true });
      await expect(drawer).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      expect(stops).toEqual([]);
    }
    const account = page.getByRole('button', { name: en ? 'Account' : 'Аккаунт', exact: true });
    await activate(account);
    const logout = page.getByRole('button', { name: en ? 'Log out' : 'Выйти', exact: true });
    await expect(logout).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(logout).toHaveCount(0);
    expect(stops).toEqual([]);
    for (const name of en ? ['About', 'Settings', 'Versions'] : ['О программе', 'Настройки', 'Версии']) {
      await activate(account);
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(stops).toEqual([]);
    }
    await window.focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => stops).toEqual(['POST']);
    await fit.focus();
    await fit.press('Enter');
    const withWindow = await box(world);
    await window.getByRole('button', { name: en ? 'Minimize' : 'Свернуть', exact: true }).click();
    await expect(window).toBeHidden();
    await expect(main).not.toHaveClass(/with-window/);
    await expect(department.locator('.ticker')).toBeVisible();
    await fit.click();
    await expectPlaceBesideStrip(world, withoutWindow, width);
    if (width > 760) expect(withWindow).not.toEqual(withoutWindow);
    await page.screenshot({ path: info.outputPath(`department-minimized-${lang}-${theme}-${width}.png`) });
    const restore = page.getByRole('button', { name: en ? 'Restore Bruno, Developer' : 'Развернуть: Bruno, Разработчик', exact: true });
    await restore.click();
    await expect(window).toBeVisible();
    await expect(main).toHaveClass(/with-window/);
    await expect(department.locator('.ticker')).toHaveCount(0);
    await fit.focus();
    await fit.press('Enter');
    expect(await box(world)).toEqual(withWindow);
    await page.screenshot({ path: info.outputPath(`department-restored-${lang}-${theme}-${width}.png`) });
    await window.getByRole('button', { name: en ? 'Minimize' : 'Свернуть', exact: true }).click();
    await department.locator('.crumbs button').click();
    await expect(department).toHaveCount(0);
    const mapFit = page.locator('.map').getByRole('button', { name: fitName, exact: true });
    await mapFit.click();
    await expectPlaceBesideStrip(mapWorld, mapWithoutWindow, width);
    const put = await box(mapWorld);
    await restore.click();
    await expect(main).toHaveClass(/with-window/);
    /* A window that opens leaves the map where the person put it; Fit then shows all of it clear of the window. On a phone the
       window covers the map and its Fit, so it is pressed from the keyboard, as above. */
    expect(await box(mapWorld)).toEqual(put);
    await activate(mapFit);
    if (width > 760) await expect.poll(() => box(mapWorld)).not.toEqual(mapWithoutWindow);
    expect(live.connections).toBe(connections);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
