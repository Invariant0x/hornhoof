import type { InstalledThemeView } from '@hornhoof/protocol/themes';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS } from '../src/skins/roles';
import { createHornhoofLiveFixture } from '../src/world/live-sync';
import { dataOfWorldPack } from '../src/world-packs/data-pack';
import { resolveWorldPack } from '../src/world-packs/registry';
import { ME, serveApi } from './api';
import { captureWith } from './capture';

/* Themes uploaded as one archive (docs/theme-archive.md), as the CEO meets them in Settings, Company & access: Upload
   theme, a refusal that says what to fix and gives the focus back, the uploaded theme's card with its licence, and the
   interface and the world it puts on with no change to the app's code. The server's side, the check and the store, is
   proven in apps/server/test/theme-routes.test.ts; here the page gets the answers that server gives. The shots go to
   $HH_OUT, for the head of Design. */

const capture = captureWith('theme-upload', process.env.HH_OUT);
const words = en.skins;

/* An uploaded theme's look: a built-in skin's values under no built-in id, on a ground of its own. */
const lookOf = (id: 'pixel' | 'light', bg: string) => {
  const skin = builtinSkin(id)!;
  return { ...Object.fromEntries(Object.entries(skin).filter(([key]) => key !== 'id')), colors: { ...skin.colors, bg } };
};

function viewOf(id: string, name: string, world: boolean): InstalledThemeView {
  const base = `/api/themes/files/${id}/1.0.0/`;
  return {
    id, version: '1.0.0', name: { en: name, ru: name }, description: { en: 'A synthetic test theme.', ru: 'Тема для проверки.' }, author: 'Test', license: 'CC0-1.0',
    engine: world ? 'iso2d' : 'none', languages: ['en', 'ru'], base, cover: null, shots: [], licenseFile: `${base}LICENSE`, hasWorld: world, hasKit: false, size: 4096,
    installedAt: '2026-11-23T10:00:00.000Z',
  };
}

const NIGHT = viewOf('night-shift', 'Night shift', false);
const STATION = viewOf('night-station', 'Night station', true);
const LOOKS: Record<string, unknown> = {
  [NIGHT.id]: { id: NIGHT.id, version: '1.0.0', base: NIGHT.base, look: lookOf('pixel', '#0A0B0C'), fonts: [], kit: null, world: null },
  [STATION.id]: { id: STATION.id, version: '1.0.0', base: STATION.base, look: lookOf('pixel', '#0A0B0C'), fonts: [], kit: null, world: dataOfWorldPack(resolveWorldPack('space')) },
};
const REFUSED = { error: { code: 'validation', message: 'The theme archive was refused.', reason: 'theme_refused', details: { problem: { code: 'file_script', path: 'ui/kit/run.js' } } } };
const zip = { name: 'night-shift.zip', mimeType: 'application/zip', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]) };

/* The theme routes as the server answers them: what is installed, an upload that is refused once and then taken, each
   theme's look, and its licence as a file. Routes added after serveApi answer first. */
async function serveThemes(page: Page, installed: InstalledThemeView[], company = 'cyberpunk') {
  let themes = installed;
  let refuseNext = true;
  await serveApi(page);
  await page.route('**/api/world/theme', route => {
    const theme = route.request().method() === 'PUT' ? (route.request().postDataJSON() as { theme: string }).theme : company;
    return route.fulfill({ json: { theme, activePack: null, canEdit: true, renamedAgentsCount: 0 } });
  });
  await page.route('**/api/themes', (route: Route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { themes } });
    if (refuseNext) {
      refuseNext = false;
      return route.fulfill({ status: 422, json: REFUSED });
    }
    themes = [NIGHT];
    return route.fulfill({ status: 201, json: { themes } });
  });
  await page.route('**/api/themes/*/look', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    return LOOKS[id] ? route.fulfill({ json: LOOKS[id] }) : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found.' } } });
  });
  /* On the context, so the tab the licence opens in gets it too. */
  await page.context().route('**/api/themes/files/**/LICENSE', route => route.fulfill({ contentType: 'text/plain; charset=utf-8', body: 'Synthetic test data, CC0-1.0.\n' }));
}

async function openThemes(page: Page) {
  await page.getByRole('button', { name: en.shell.account, exact: true }).click();
  await page.getByRole('button', { name: en.settings.menu, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: en.settings.title });
  await dialog.getByRole('button', { name: en.settings.groups.company, exact: true }).click();
  await expect(dialog.getByRole('region', { name: words.catalog })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return dialog;
}

const token = (page: Page, name: string) => page.evaluate(property => document.documentElement.style.getPropertyValue(property), name);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
});

test('a theme with no engine: refused with what to fix and the focus back on Upload theme, then installed, and its look goes on', async ({ page }, info: TestInfo) => {
  await serveThemes(page, []);
  await page.goto('/');
  const dialog = await openThemes(page);
  const upload = dialog.getByRole('button', { name: words.archive.upload, exact: true });
  await upload.scrollIntoViewIfNeeded();
  await expect(dialog.getByText(words.archive.hint)).toBeVisible();
  await capture(page, info, 'store-upload');

  /* By the keyboard, as a person who tabs to it, so the focus ring shows where focus comes back. */
  await upload.focus();
  const [refusedPick] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await refusedPick.setFiles(zip);
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText(words.archive.refused);
  await expect(alert).toContainText(words.archive.problems.file_script('ui/kit/run.js'));
  await expect(upload).toBeFocused();
  expect(await upload.evaluate(button => button.matches(':focus-visible'))).toBe(true);
  await capture(page, info, 'store-refused-focus');

  const [pick] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await pick.setFiles(zip);
  const card = dialog.locator('li[data-installed="night-shift"]');
  await expect(card.getByRole('heading', { name: 'Night shift' })).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText(words.archive.installed('Night shift'));
  await expect(card.getByText(words.archive.origin, { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: words.archive.license('CC0-1.0') })).toHaveAttribute('href', NIGHT.licenseFile);
  await card.scrollIntoViewIfNeeded();
  await capture(page, info, 'store-uploaded');

  expect(await token(page, COLOR_TOKENS.bg)).not.toBe('#0A0B0C');
  await card.getByRole('button', { name: `${words.apply}: Night shift` }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night-shift');
  expect(await token(page, COLOR_TOKENS.bg)).toBe('#0A0B0C');
  await capture(page, info, 'store-applied');

  /* The licence it came with opens as plain text from the theme's own files. */
  const [licence] = await Promise.all([page.waitForEvent('popup'), card.getByRole('link', { name: words.archive.license('CC0-1.0') }).click()]);
  await expect(licence.locator('body')).toContainText('Synthetic test data, CC0-1.0.');
});

test('a theme with an iso2d world: the company on it gets its look and its world map, with no change to the code', async ({ page }, info: TestInfo) => {
  await serveThemes(page, [STATION], STATION.id);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: STATION.id } } }));
  await page.route('**/api/world/state', route => route.fulfill({ json: createHornhoofLiveFixture() }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', STATION.id);
  await expect(page.locator('html')).toHaveAttribute('data-world', STATION.id);
  await expect(page.locator(`.map.world-map[data-world-canvas="${STATION.id}"] canvas`).first()).toBeVisible();
  expect(await token(page, COLOR_TOKENS.bg)).toBe('#0A0B0C');
  await page.waitForTimeout(1500);
  await capture(page, info, 'world-map');

  const dialog = await openThemes(page);
  const card = dialog.locator(`li[data-installed="${STATION.id}"]`);
  await expect(card.getByText(`${words.archive.origin} · ${words.worldBadge}`, { exact: true })).toBeVisible();
  await expect(card.getByText(words.applied, { exact: true })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await capture(page, info, 'world-store');
});
