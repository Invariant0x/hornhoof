import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { DICTIONARIES, LANGUAGES, type Language } from '../src/i18n';
import type { CompanyPause, Me } from '../src/types';
import { serveApi } from './api';

/* Plain files directly inside HH_OUT are uploaded onto the task automatically by run_tests. */
const SHOTS = process.env.HH_OUT || fileURLToPath(new URL('results/company-pause-shots', import.meta.url));
const PAUSED_AT = '2026-11-21T10:15:00.000Z';
const PAUSED: CompanyPause = { by: 'p1', byName: 'Ivan', at: PAUSED_AT };
const LISTED_ME: Me = {
  person: { id: 'p3', companyId: 'c1', name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', status: 'active', scopeKind: 'listed', isOwner: false },
  company: { id: 'c1', name: 'Acme' },
};

/* Dynamically rank shipped locales by rendered string length on the pause screen (CONTRIBUTING.md). */
function localeScore(id: Language): number {
  const t = DICTIONARIES[id];
  return [
    t.firstContact.title,
    t.companyPause.pauseMenu,
    t.companyPause.resumeMenu,
    t.companyPause.resume,
    t.companyPause.bannerRunning(2, PAUSED.byName, '10:15'),
    t.companyPause.bannerIdle(PAUSED.byName, '10:15'),
  ].reduce((sum, s) => sum + s.length, 0);
}

const RANKED = [...LANGUAGES].sort((a, b) => localeScore(a.id) - localeScore(b.id));
const TEST_LOCALES: Language[] = RANKED.length > 1 ? [RANKED[0]!.id, RANKED.at(-1)!.id] : [RANKED[0]!.id];
const LONGEST_LOCALE: Language = RANKED.at(-1)!.id;

function shot(png: Buffer, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), png);
  console.log(`SHOT ${name}.png sha256=${createHash('sha256').update(png).digest('hex')}`);
}

async function assertNoOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}

async function assertBannerClearOfTopbar(page: Page) {
  const box = await page.evaluate(() => {
    const top = document.querySelector('header.topbar')?.getBoundingClientRect();
    const banner = document.querySelector('main.body > .update-banner')?.getBoundingClientRect();
    return top && banner ? { topBottom: top.bottom, bannerTop: banner.top, bannerRight: banner.right, bannerLeft: banner.left, vw: window.innerWidth } : null;
  });
  expect(box).not.toBeNull();
  expect(box!.bannerTop).toBeGreaterThanOrEqual(box!.topBottom - 1);
  expect(box!.bannerLeft).toBeGreaterThanOrEqual(0);
  expect(box!.bannerRight).toBeLessThanOrEqual(box!.vw + 1);
}

async function setupPauseRoutes(page: Page, initial: { paused: CompanyPause | null; finishingTurns: number; me?: Me }) {
  let state = { paused: initial.paused, finishingTurns: initial.finishingTurns };
  await serveApi(page);
  if (initial.me) {
    await page.route('**/api/me', route => route.fulfill({ json: initial.me }));
  }
  await page.route('**/api/company/pause', route => {
    if (route.request().method() === 'POST') {
      state = { paused: PAUSED, finishingTurns: state.finishingTurns };
      return route.fulfill({ json: state });
    }
    return route.fulfill({ json: state });
  });
  await page.route('**/api/company/resume', route => {
    state = { paused: null, finishingTurns: 0 };
    return route.fulfill({ json: state });
  });
  return {
    setFinishing(n: number) {
      state = { ...state, finishingTurns: n };
    },
  };
}

for (const lang of TEST_LOCALES) {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1440, 375] as const) {
      test(`pause menu, banner states and resume flow: ${lang} ${theme} ${width}px`, async ({ page }, info) => {
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        const t = DICTIONARIES[lang];
        await page.setViewportSize({ width, height: 850 });
        await page.addInitScript(({ l, th }) => {
          localStorage.setItem('hh-lang', l);
          localStorage.setItem('hh-theme', th);
        }, { l: lang, th: theme });
        const ctrl = await setupPauseRoutes(page, { paused: null, finishingTurns: 2 });

        await page.goto('/');
        await expect(page.locator('header.topbar')).toBeVisible();
        await assertNoOverflow(page);

        /* Open account menu and verify Pause sits directly after Talk to the orchestrator. */
        await page.getByRole('button', { name: t.shell.account }).click();
        const menu = page.locator('.account-menu');
        await expect(menu).toBeVisible();
        const labels = await menu.getByRole('button').allTextContents();
        const contactIdx = labels.indexOf(t.firstContact.title);
        expect(contactIdx).toBeGreaterThanOrEqual(0);
        expect(labels[contactIdx + 1]).toBe(t.companyPause.pauseMenu);
        await assertNoOverflow(page);

        if (info.project.name === 'chromium' && (
          (lang === TEST_LOCALES[0] && theme === 'light' && width === 1440) ||
          (lang === LONGEST_LOCALE && theme === 'dark' && width === 1440) ||
          (lang === LONGEST_LOCALE && theme === 'light' && width === 375)
        )) {
          shot(await page.screenshot(), `pause-menu-${lang}-${theme}-${width}`);
        }

        /* Trigger pause: banner shows 2 finishing turns, who paused, when, and Resume. */
        await menu.getByRole('button', { name: t.companyPause.pauseMenu }).click();
        const banner = page.getByRole('status', { name: t.companyPause.label });
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(PAUSED.byName);
        await expect(banner.getByRole('button', { name: t.companyPause.resume })).toBeVisible();
        await assertBannerClearOfTopbar(page);
        await assertNoOverflow(page);

        if (info.project.name === 'chromium' && !(lang === TEST_LOCALES[0] && theme === 'dark' && width === 375)) {
          shot(await page.screenshot(), `pause-running-${lang}-${theme}-${width}`);
        }

        /* Reload with 0 finishing turns to verify "Nothing is running" state. */
        ctrl.setFinishing(0);
        await page.reload();
        await expect(banner).toBeVisible();
        await assertBannerClearOfTopbar(page);
        await assertNoOverflow(page);

        if (info.project.name === 'chromium' && theme === 'light' && (
          (lang === TEST_LOCALES[0] && width === 1440) ||
          (lang === LONGEST_LOCALE && width === 375)
        )) {
          shot(await page.screenshot(), `pause-idle-${lang}-${theme}-${width}`);
        }

        /* Resume clears the banner. */
        await banner.getByRole('button', { name: t.companyPause.resume }).click();
        await expect(banner).toBeHidden();
        await assertNoOverflow(page);
        expect(errors).toEqual([]);
      });
    }
  }
}

test('listed-scope person sees pause banner without Pause or Resume controls, and RTL stays clear', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const t = DICTIONARIES[LONGEST_LOCALE];
  await page.setViewportSize({ width: 375, height: 850 });
  await page.addInitScript(l => {
    localStorage.setItem('hh-lang', l);
    localStorage.setItem('hh-theme', 'light');
  }, LONGEST_LOCALE);
  await setupPauseRoutes(page, { paused: PAUSED, finishingTurns: 1, me: LISTED_ME });

  await page.goto('/');
  const banner = page.getByRole('status', { name: t.companyPause.label });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: t.companyPause.resume })).toHaveCount(0);
  await assertBannerClearOfTopbar(page);
  await assertNoOverflow(page);

  await page.getByRole('button', { name: t.shell.account }).click();
  const menu = page.locator('.account-menu');
  await expect(menu.getByRole('button', { name: t.companyPause.pauseMenu })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: t.companyPause.resumeMenu })).toHaveCount(0);

  if (info.project.name === 'chromium') {
    shot(await page.screenshot(), `pause-listed-${LONGEST_LOCALE}-light-375`);
  }

  /* Verify RTL direction on the banner keeps words readable without overflow. */
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await assertBannerClearOfTopbar(page);
  await assertNoOverflow(page);
  if (info.project.name === 'chromium') {
    shot(await page.screenshot(), `pause-rtl-${LONGEST_LOCALE}-light-375`);
  }
  expect(errors).toEqual([]);
});
