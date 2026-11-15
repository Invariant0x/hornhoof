import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { SETTINGS_GROUPS } from '../src/routes';
import { ME, serveApi } from './api';

/* The short account menu and Settings in its four groups, as a person meets them: in a light and a dark skin, in the
   longest and the shortest shipped language and right to left, at a desktop's width and a phone's. Every group keeps its
   parts on one shared edge, nothing runs off the screen, and a picture of each look is kept with the results. */

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const WIDTHS = [1440, 375];
/* Light, and Cyberpunk, the dark default. */
const SKINS = ['light', 'cyberpunk'];
/* Russian runs longer than English on these screens; no shipped language is written right to left yet, so English is
   also laid out mirrored. */
const LOOKS = [{ lang: 'en', dir: 'ltr' }, { lang: 'ru', dir: 'ltr' }, { lang: 'en', dir: 'rtl' }] as const;
const SHOTS = process.env.SHOTS;

const OUTBOUND = {
  channels: [{
    id: 'ch1', departmentId: 'd2', productId: null, name: 'Sales Mail', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', status: 'active',
    generation: 2, stoppedReason: null, stoppedAt: null,
    accounts: [{ id: 'ac1', label: 'Sales Primary', senderDomain: 'mail.acme.example', status: 'active', configGeneration: 1, available: true }],
  }],
  messages: [{
    id: 'm1', departmentId: 'd2', productId: null, taskId: 't1', channelId: 'ch1', channelName: 'Sales Mail', accountId: 'ac1', accountLabel: 'Sales Primary',
    senderDomain: 'mail.acme.example', revision: 1, contentDigest: '9f86d081884c7d659a2feaa0c55ad015', status: 'sent', reasonCodes: [], scheduledAt: '2026-11-15T09:00:00.000Z',
    updatedAt: '2026-11-15T09:01:00.000Z', unknownRecovery: null,
  }],
  escalations: [],
  approvals: [],
};
const GOOGLE = { kind: 'service_account', account: 'sheets-bot@acme.iam.gserviceaccount.com', shareEmail: 'ivan@acme.com', keyLast4: '9876' };

async function prepare(page: Page, lang: string, skin: string, width: number): Promise<string[]> {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang, skin });
  const problems: string[] = [];
  /* WebKit reports a request that the test's own next page.goto cuts off as a page error; that is the test, not the page. */
  page.on('pageerror', error => { if (!error.message.endsWith('due to access control checks.')) problems.push(error.message); });
  /* The updates the CEO's banner asks for are left unanswered, as the server of a test gives none. */
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/') && path !== '/api/updates' && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await serveApi(page);
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.24.0', commit: 'c6bd5a8', migrations: 1 } }));
  await page.route('**/api/outbound', route => route.fulfill({ json: OUTBOUND }));
  await page.route('**/api/google-sheets', route => route.fulfill({ json: { google: GOOGLE } }));
  await page.route('**/api/link', route => route.fulfill({ json: { link: { name: 'acme', url: 'https://acme.hornhoof.org' }, domain: 'hornhoof.org' } }));
  return problems;
}

/* Turns the page right to left, as a language written that way would. */
async function direction(page: Page, dir: string) {
  await page.evaluate(value => { document.documentElement.dir = value; }, dir);
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const file = `settings-${name}.png`;
  await page.screenshot({ path: SHOTS ? `${SHOTS}/${file}` : info.outputPath(file), animations: 'disabled' });
}

/* Whether the page or the window scrolls sideways, and the parts of the open group whose edges leave the shared one. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('.settings-window')!;
    const parts = [...dialog.querySelectorAll<HTMLElement>('.settings-main > .settings-group > *, .settings-main > .integrations > *, .settings-main > .messaging > *')];
    const main = dialog.querySelector('.settings-main')!.getBoundingClientRect();
    const off = parts.map(part => part.getBoundingClientRect()).filter(box => Math.abs(box.left - main.left) > 1 || Math.abs(box.right - main.right) > 1);
    const nav = dialog.querySelector('.settings-nav')!.getBoundingClientRect();
    const small = [...dialog.querySelectorAll<HTMLElement>('.settings-nav .btn, .lang-choice')].filter(control => Math.round(control.getBoundingClientRect().height) < 44).map(control => control.textContent);
    return {
      pageScroll: document.documentElement.scrollWidth > innerWidth,
      windowScroll: dialog.scrollWidth > dialog.clientWidth,
      parts: parts.length,
      off: off.length,
      small,
      navStart: document.documentElement.dir === 'rtl' ? nav.right >= main.right : nav.left <= main.left,
    };
  });
}

for (const skin of SKINS) for (const { lang, dir } of LOOKS) for (const width of WIDTHS) {
  const look = `${lang}-${dir}-${skin}-${width}`;
  test(`the account menu is short and Settings keeps its four groups in order, on one edge: ${look}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const t = MESSAGES[lang];
    const problems = await prepare(page, lang, skin, width);
    await page.goto('/');
    await direction(page, dir);
    await page.getByRole('button', { name: t.shell.account, exact: true }).click();
    const menu = page.locator('.account-menu');
    await expect(menu.getByRole('button')).toHaveText([new RegExp(`^${t.shell.tabs.improvements}`), t.updates.menu, t.settings.menu, t.about.menu, t.shell.logOut]);
    await expect(menu.getByRole('group')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, info, `menu-${look}`);

    for (const group of [undefined, ...SETTINGS_GROUPS]) {
      await page.goto(group ? `/settings/${group}` : '/settings');
      await direction(page, dir);
      const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
      const nav = dialog.getByRole('navigation', { name: t.settings.groupsLabel, exact: true });
      await expect(nav.getByRole('button')).toHaveText([t.settings.groups.appearance, t.settings.groups.integrations, t.settings.groups.messaging, t.settings.groups.company]);
      await expect(nav.getByRole('button', { name: t.settings.groups[group ?? 'appearance'], exact: true })).toHaveAttribute('aria-current', 'page');
      if (!group) await expect(dialog.getByRole('radiogroup', { name: t.language.title, exact: true })).toBeVisible();
      if (group === 'integrations') await expect(dialog.getByRole('article', { name: t.googleSheets.title, exact: true }).getByText(t.integrations.connected, { exact: true })).toBeVisible();
      if (group === 'messaging') await expect(dialog.getByRole('heading', { name: 'Sales Mail', exact: true })).toBeVisible();
      if (group === 'company') await expect(dialog.getByRole('link', { name: 'https://acme.hornhoof.org', exact: true })).toBeVisible();
      const found = await layout(page);
      expect(found.pageScroll, `${look} ${group}: the page does not scroll sideways`).toBe(false);
      expect(found.windowScroll, `${look} ${group}: the window does not scroll sideways`).toBe(false);
      expect(found.parts, `${look} ${group}: the group has parts`).toBeGreaterThan(0);
      expect(found.off, `${look} ${group}: every part on the shared edge`).toBe(0);
      expect(found.small, `${look} ${group}: 44 px targets`).toEqual([]);
      expect(found.navStart, `${look} ${group}: the groups stand at the start`).toBe(true);
      await shot(page, info, `${group ?? 'appearance'}-${look}`);
    }
    expect(problems).toEqual([]);
  });
}

test('About holds writing to the developers in a light and a dark skin, in both languages and right to left, wide and narrow', async ({ page }, info) => {
  test.setTimeout(120_000);
  for (const skin of SKINS) for (const { lang, dir } of LOOKS) for (const width of WIDTHS) {
    const t = MESSAGES[lang];
    await page.unrouteAll();
    await prepare(page, lang, skin, width);
    await page.route('**/api/updates/current', route => route.fulfill({ json: { version: '0.24.0', commit: 'c6bd5a8' } }));
    await page.goto('/about');
    await direction(page, dir);
    const about = page.getByRole('dialog', { name: t.about.title, exact: true });
    const part = about.getByRole('region', { name: t.feedback.title, exact: true });
    await expect(part.getByRole('button', { name: t.common.next, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await about.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await shot(page, info, `about-feedback-${lang}-${dir}-${skin}-${width}`);
  }
});
