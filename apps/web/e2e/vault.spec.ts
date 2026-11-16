import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { serveRoutes } from './routes-api';

/* The Passwords group as a person meets it: the list of sign-ins, and the form with a field whose problem holds the
   focus, in both shipped themes, in English and Russian, left to right and right to left, wide and narrow. Every field and
   button is a target of 44px, nothing runs off sideways, and the pictures are for the check against the style book. */
test.use({ reducedMotion: 'reduce' });
const SHOTS = 'e2e/results/vault-shots';
mkdirSync(SHOTS, { recursive: true });

const ENTRIES = [
  {
    id: 'v1', name: 'Partner site of the northern region shops', site: 'https://accounts.partner-shops-of-the-northern-region.example/sign-in/with/a/very/long/address',
    login: 'team.northern.region@acme.example', hasCode: true, createdBy: { id: 'p2', name: 'Maria' }, createdAt: '2030-01-01T09:00:00.000Z',
  },
  {
    id: 'v2', name: 'CRM', site: 'https://crm.example', login: 'sales@acme.example', hasCode: false, createdBy: { id: 'a1', name: 'David AI' }, createdAt: '2030-01-02T09:00:00.000Z',
  },
];

type Look = { lang: 'en' | 'ru'; theme: 'cyberpunk' | 'light'; dir: 'ltr' | 'rtl'; width: number };
const LOOKS: Look[] = [
  ...(['en', 'ru'] as const).flatMap(lang => (['cyberpunk', 'light'] as const).flatMap(theme => [1440, 375].map(width => ({ lang, theme, dir: 'ltr' as const, width })))),
  { lang: 'en', theme: 'light', dir: 'rtl', width: 1440 },
  { lang: 'en', theme: 'light', dir: 'rtl', width: 375 },
];

async function open(page: Page, { lang, theme, dir, width }: Look) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { lang, theme, dir });
  await serveRoutes(page);
  await page.route('**/api/vault', route => route.fulfill({ json: { entries: ENTRIES } }));
}

/* What is not a target of 44px among the fields and buttons of the group. */
async function small(group: Locator) {
  return group.evaluate(root => [...root.querySelectorAll('input:not([type=checkbox]), select, button')].flatMap(el => {
    const high = Math.round(el.getBoundingClientRect().height);
    return high >= 44 ? [] : [`${el.tagName} ${(el.textContent ?? '').trim()} ${high}`];
  }));
}

async function fits(page: Page, group: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await group.evaluate(el => [...el.querySelectorAll('li, b, span, small, p, label, .field')].filter(n => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1).map(n => `${n.tagName}.${n.className} ${(n as HTMLElement).scrollWidth}>${(n as HTMLElement).clientWidth} ${(n.textContent ?? '').slice(0, 40)}`))).toEqual([]);
}

for (const look of LOOKS) {
  const t = look.lang === 'en' ? en : ru;
  const name = `${look.lang}-${look.theme}-${look.dir}-${look.width}`;
  test(`the Passwords group, its list and a field with a problem in focus ${name}`, async ({ page, browserName }) => {
    test.setTimeout(0);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await open(page, look);
    await page.goto('/settings/passwords');
    const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
    const group = dialog.locator('.sgroup[data-group="passwords"]');
    await expect(group.getByText(ENTRIES[0]!.name)).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await fits(page, group);
    expect(await small(group)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/list-${browserName}-${name}.png`, animations: 'disabled' });

    await group.getByRole('button', { name: t.vault.add, exact: true }).click();
    await group.getByLabel(t.vault.site, { exact: true }).fill('https://partner.example/login');
    await group.getByRole('button', { name: t.common.save, exact: true }).click();
    const field = group.getByLabel(t.vault.name, { exact: true });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(group.getByText(t.vault.needName, { exact: true })).toBeVisible();
    const pink = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.borderTopColor = 'var(--pink)';
      document.body.append(probe);
      const color = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return color;
    });
    expect(await field.evaluate(e => getComputedStyle(e).borderTopColor)).toBe(pink);
    expect(await field.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('solid');
    await fits(page, group);
    expect(await small(group)).toEqual([]);
    await field.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${SHOTS}/field-error-${browserName}-${name}.png`, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}
