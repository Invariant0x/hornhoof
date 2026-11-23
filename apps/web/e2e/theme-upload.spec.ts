import type { InstalledThemeView } from '@hornhoof/protocol/themes';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS } from '../src/skins/roles';
import { ME, serveApi } from './api';
import { captureWith } from './capture';

/* Themes uploaded as one archive (docs/theme-archive.md), as the CEO meets them in Settings, Company & access: Upload
   theme, a refusal that says what to fix and gives the focus back, the uploaded theme's card with its licence, the
   interface it puts on with no change to the app's code, and a world theme that brought less than all its art kept as
   its interface alone, with no world drawn (#1972). The server's side, the check and the store, is proven in
   apps/server/test/theme-routes.test.ts; here the page gets the answers that server gives. Each runs at 1440 and 375 px,
   in English and in Russian, as Design checks them; the shots go to $HH_OUT, for the head of Design. */

const capture = captureWith('theme-upload', process.env.HH_OUT);
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const SIZES = [['en', 1440], ['ru', 1440], ['en', 375], ['ru', 375]] as const;
/* The focus ring stands this far outside a button: a 2 px outline 2 px off it (theme.css, .btn:focus-visible). */
const RING = 4;

/* An uploaded theme's look: a built-in skin's values under no built-in id, on a ground of its own. */
const lookOf = (id: 'pixel' | 'light', bg: string) => {
  const skin = builtinSkin(id)!;
  return { ...Object.fromEntries(Object.entries(skin).filter(([key]) => key !== 'id')), colors: { ...skin.colors, bg } };
};

/* leftOut: a theme that declares an iso2d world but brought less than all its art, which the store keeps as its
   interface alone (docs/theme-archive.md, 4.2). */
function viewOf(id: string, name: Readonly<{ en: string; ru: string }>, leftOut = false): InstalledThemeView {
  const base = `/api/themes/files/${id}/1.0.0/`;
  return {
    id, version: '1.0.0', name, description: { en: 'A synthetic test theme.', ru: 'Тема для проверки.' }, author: 'Test', license: 'CC0-1.0',
    engine: leftOut ? 'iso2d' : 'none', languages: ['en', 'ru'], base, cover: null, shots: [], licenseFile: `${base}LICENSE`, hasWorld: false,
    worldLeftOut: leftOut ? 'art_missing' : null, hasKit: false, size: 4096, installedAt: '2026-11-23T10:00:00.000Z',
  };
}

const NIGHT = viewOf('night-shift', { en: 'Night shift', ru: 'Ночная смена' }, false);
const STATION = viewOf('night-station', { en: 'Night station', ru: 'Ночная станция' }, true);
/* The store gives no world for a theme whose world it left out: the look route answers world null. */
const LOOKS: Record<string, unknown> = {
  [NIGHT.id]: { id: NIGHT.id, version: '1.0.0', base: NIGHT.base, look: lookOf('pixel', '#0A0B0C'), fonts: [], kit: null, world: null },
  [STATION.id]: { id: STATION.id, version: '1.0.0', base: STATION.base, look: lookOf('light', '#F7F7F2'), fonts: [], kit: null, world: null },
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

async function openThemes(page: Page, said: Messages) {
  await page.getByRole('button', { name: said.shell.account, exact: true }).click();
  await page.getByRole('button', { name: said.settings.menu, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: said.settings.title });
  await dialog.getByRole('button', { name: said.settings.groups.company, exact: true }).click();
  await expect(dialog.getByRole('region', { name: said.skins.catalog })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return dialog;
}

const token = (page: Page, name: string) => page.evaluate(property => document.documentElement.style.getPropertyValue(property), name);

/* Nothing runs off the window or its dialog sideways. */
async function fits(page: Page) {
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('html, .dialog, .settings-scroll')].filter(box => box.scrollWidth > box.clientWidth + 1).map(box => box.className || box.tagName))).toEqual([]);
}

async function open(page: Page, lang: 'en' | 'ru', width: number) {
  await page.setViewportSize({ width, height: width < 760 ? 812 : 900 });
  await page.addInitScript(language => localStorage.setItem('hh-lang', language), lang);
}

for (const [lang, width] of SIZES) {
  const said = MESSAGES[lang];
  const words = said.skins;
  const at = `${lang}-${width}`;
  const night = NIGHT.name[lang]!;
  const station = STATION.name[lang]!;

test(`a theme with no engine, ${lang} ${width}: refused with what to fix and the focus back on Upload theme, then installed, and its look goes on`, async ({ page }, info: TestInfo) => {
  await open(page, lang, width);
  await serveThemes(page, []);
  await page.goto('/');
  const dialog = await openThemes(page, said);
  const upload = dialog.getByRole('button', { name: words.archive.upload, exact: true });
  await upload.scrollIntoViewIfNeeded();
  const hint = dialog.getByText(words.archive.hint);
  await expect(hint).toBeVisible();
  /* One button for a theme of either kind, the hint above it and clear of its focus ring, the button at the end edge. */
  await expect(dialog.getByRole('button', { name: /^(Add from file|Добавить из файла)$/ })).toHaveCount(0);
  const [button, above] = [(await upload.boundingBox())!, (await hint.boundingBox())!];
  expect(button.y - (above.y + above.height), 'room over Upload theme for its focus ring').toBeGreaterThanOrEqual(RING);
  expect(button.height, 'a 44 px target').toBeGreaterThanOrEqual(44);
  await fits(page);
  await capture(page, info, `store-upload-${at}`);

  /* By the keyboard, as a person who tabs to it, so the focus ring shows where focus comes back. */
  await upload.focus();
  const [refusedPick] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await refusedPick.setFiles(zip);
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText(words.archive.refused);
  await expect(alert).toContainText(words.archive.problems.file_script('ui/kit/run.js'));
  await expect(upload).toBeFocused();
  expect(await upload.evaluate(button => button.matches(':focus-visible'))).toBe(true);
  await fits(page);
  await capture(page, info, `store-refused-focus-${at}`);

  const [pick] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await pick.setFiles(zip);
  const card = dialog.locator('li[data-installed="night-shift"]');
  await expect(card.getByRole('heading', { name: night })).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText(words.archive.installed(night));
  await expect(card.getByText(words.archive.origin, { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: words.archive.license('CC0-1.0') })).toHaveAttribute('href', NIGHT.licenseFile);
  /* Focus comes to the new card's Apply, with its ring. */
  const apply = card.getByRole('button', { name: `${words.apply}: ${night}` });
  await expect(apply).toBeFocused();
  expect(await apply.evaluate(button => button.matches(':focus-visible'))).toBe(true);
  await card.scrollIntoViewIfNeeded();
  await fits(page);
  await capture(page, info, `store-uploaded-focus-${at}`);
  /* Uploaded themes are the company's own: they stand under Custom. */
  await dialog.getByRole('button', { name: words.filters.custom, exact: true }).click();
  await expect(dialog.locator('li.skin-card')).toHaveCount(1);
  await dialog.getByRole('button', { name: words.filters.all, exact: true }).click();
  await expect(dialog.getByText(words.empty, { exact: true })).toHaveCount(0);

  expect(await token(page, COLOR_TOKENS.bg)).not.toBe('#0A0B0C');
  await apply.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night-shift');
  expect(await token(page, COLOR_TOKENS.bg)).toBe('#0A0B0C');
  await capture(page, info, `store-applied-${at}`);

  /* By the keyboard to Remove, in the theme's own look: its ring shows on the dark ground. */
  const remove = card.getByRole('button', { name: `${words.remove}: ${night}` });
  await card.getByRole('link', { name: words.archive.license('CC0-1.0') }).focus();
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  expect(await remove.evaluate(button => button.matches(':focus-visible'))).toBe(true);
  await fits(page);
  await capture(page, info, `store-remove-focus-${at}`);

  /* The licence it came with opens as plain text from the theme's own files. */
  const [licence] = await Promise.all([page.waitForEvent('popup'), card.getByRole('link', { name: words.archive.license('CC0-1.0') }).click()]);
  await expect(licence.locator('body')).toContainText('Synthetic test data, CC0-1.0.');
});

test(`a world theme without all its art, ${lang} ${width}: the company on it gets its interface alone, no world is drawn, and its card says why`, async ({ page }, info: TestInfo) => {
  await open(page, lang, width);
  await serveThemes(page, [STATION], STATION.id);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: STATION.id } } }));
  /* Nothing of a world is asked for: no engine's art and no world's art. */
  const worldAsked: string[] = [];
  page.on('request', request => {
    if (/\/world\/art\/|\/world-art\//.test(request.url())) worldAsked.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', STATION.id);
  expect(await token(page, COLOR_TOKENS.bg)).toBe('#F7F7F2');
  await expect(page.locator('main .map').first()).toBeVisible();
  await expect(page.locator('.map.world-map')).toHaveCount(0);
  await expect(page.locator('.world-canvas-host canvas')).toHaveCount(0);
  expect(await page.locator('html').getAttribute('data-world')).toBeNull();
  await capture(page, info, `interface-only-map-${at}`);

  const dialog = await openThemes(page, said);
  const card = dialog.locator(`li[data-installed="${STATION.id}"]`);
  await expect(card.getByRole('heading', { name: station })).toBeVisible();
  await expect(card.getByText(words.archive.origin, { exact: true })).toBeVisible();
  await expect(card.getByText(words.archive.worldLeftOut, { exact: true })).toBeVisible();
  await expect(card.getByText(words.applied, { exact: true })).toBeVisible();
  await expect(card.locator('.skin-perf-note')).toHaveCount(0);
  await dialog.getByRole('button', { name: words.filters.worlds, exact: true }).click();
  await expect(card).toHaveCount(0);
  await dialog.getByRole('button', { name: words.filters.all, exact: true }).click();
  await card.scrollIntoViewIfNeeded();
  await fits(page);
  await capture(page, info, `interface-only-store-${at}`);
  expect(worldAsked).toEqual([]);
});
}
