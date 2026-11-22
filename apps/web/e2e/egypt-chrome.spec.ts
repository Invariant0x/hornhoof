import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { BuiltinSkinId } from '../src/skins/registry';
import type { Org } from '../src/types';
import { ME, serveApi } from './api';
import { captureWith } from './capture';

/* Item 1 of #1803: themes change only visual style (stone, papyrus, colours, fonts, icons), never product chrome layout or
   the brand logo mark. Verifies that Cyberpunk (dark), Light, and Ancient Egypt place every map chrome element in the same
   position across Russian and English on desktop (1440x900) and mobile (375x812), and captures side-by-side screenshots. */

const capture = captureWith('map-chrome', process.env.HH_SCREENSHOT_DIR);
const VERSION = { version: '0.40.2', commit: '518d9f270' };
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const SIZES = {
  1440: { width: 1440, height: 900 },
  375: { width: 375, height: 812 },
} as const;
type Width = keyof typeof SIZES;
type Lang = 'en' | 'ru';
type ThemeChoice = Extract<BuiltinSkinId, 'cyberpunk' | 'light' | 'egypt'>;
type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };

const SALES = '00000000-0000-4000-8000-000000000001';
const DEV = '00000000-0000-4000-8000-000000000002';

const sampleOrg = (): Org => ({
  company: ME.company,
  orchestrator: {
    id: 'a1',
    name: 'Orchestrator',
    model: 'claude-opus-4-6',
    effort: 'high',
    subscription: {
      id: 'sub-1',
      provider: 'claude',
      kind: 'personal',
      label: 'Claude Max',
      status: 'ready',
      online: true,
      last4: null,
      owner: { id: ME.person.id, name: ME.person.name },
      place: { kind: 'company', id: null, name: ME.company.name },
      machines: [],
      limits: null,
      budget: null,
      isOrchestrator: true,
      accounts: [],
      tier: 'Max',
      accountsDiffer: false,
      signedInOnce: true,
      leaseMachine: null,
    },
    context: 38,
    program: null,
    alarm: null,
    retry: null,
    failure: null,
  },
  agents: { total: 4, working: 1 },
  people: [],
  departments: [
    {
      id: SALES,
      name: 'Sales',
      templateKey: null,
      roleCode: 'SAL',
      about: '',
      agents: { total: 2, working: 0 },
      products: [],
      teams: [],
      people: [],
      employees: [],
      roles: [],
    },
    {
      id: DEV,
      name: 'Development',
      templateKey: null,
      roleCode: 'DEV',
      about: '',
      agents: { total: 2, working: 1 },
      products: [],
      teams: [],
      people: [],
      employees: [],
      roles: [],
    },
  ],
});

type ChromeSnapshot = {
  brand: Rect | null;
  logoParts: { dome: number; base: number; dot: number };
  tabsBar: Rect;
  tabLabels: string[];
  avatar: Rect;
  zoom: Rect;
  ticker: Rect;
  version: Rect;
  overflow: boolean;
};

async function openMapWith(page: Page, width: Width, lang: Lang, theme: ThemeChoice): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text());
  });
  await page.setViewportSize(SIZES[width]);
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: sampleOrg() }));
  await page.route('**/api/version', route => route.fulfill({ json: VERSION }));
  await page.goto('/');
  if (theme === 'egypt') {
    await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
  } else {
    await expect(page.locator('.map .dept')).toHaveCount(2);
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('.map-version')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return errors;
}

async function measureChrome(page: Page): Promise<ChromeSnapshot> {
  return page.evaluate(() => {
    const rectOf = (el: Element | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const brandEl = document.querySelector('.tb-brand');
    const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tabs > button')];
    return {
      brand: rectOf(brandEl),
      logoParts: {
        dome: document.querySelectorAll('.tb-brand svg .mk-dome').length,
        base: document.querySelectorAll('.tb-brand svg .mk-base').length,
        dot: document.querySelectorAll('.tb-brand svg .mk-dot').length,
      },
      tabsBar: rectOf(document.querySelector('.tabs'))!,
      tabLabels: tabButtons.map(btn => (btn.getAttribute('aria-label') || btn.textContent || '').trim()),
      avatar: rectOf(document.querySelector('.tb-right .avatar'))!,
      zoom: rectOf(document.querySelector('.map > .zoom'))!,
      ticker: rectOf(document.querySelector('.map > .ticker'))!,
      version: rectOf(document.querySelector('.map-version'))!,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

function expectClose(actual: number, expected: number, tolerance: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: got ${actual}, expected ${expected} (+/-${tolerance})`).toBeLessThanOrEqual(tolerance);
}

function shouldCapture(width: Width, lang: Lang, theme: ThemeChoice): boolean {
  if (width === 1440 && lang === 'ru') return true;
  if (width === 1440 && lang === 'en' && (theme === 'cyberpunk' || theme === 'egypt')) return true;
  if (width === 375 && lang === 'ru' && (theme === 'cyberpunk' || theme === 'egypt')) return true;
  return false;
}

test('map chrome and brand logo keep identical layout in Cyberpunk, Light and Ancient Egypt across RU/EN and 1440/375', async ({ browser }, info: TestInfo) => {
  const widths: Width[] = [1440, 375];
  const langs: Lang[] = ['ru', 'en'];
  const themes: ThemeChoice[] = ['cyberpunk', 'light', 'egypt'];

  for (const width of widths) {
    for (const lang of langs) {
      const words = MESSAGES[lang];
      const expectedTabs = [
        words.shell.tabs.map,
        words.shell.tabs.tasks,
        words.shell.tabs.people,
        words.shell.tabs.subscriptions,
        words.shell.tabs.machines,
      ];
      const results = new Map<ThemeChoice, ChromeSnapshot>();

      for (const theme of themes) {
        const context = await browser.newContext({ viewport: SIZES[width] });
        const page = await context.newPage();
        try {
          const errors = await openMapWith(page, width, lang, theme);
          const snap = await measureChrome(page);
          results.set(theme, snap);

          expect(errors, `${width} ${lang} ${theme} errors`).toEqual([]);
          expect(snap.overflow, `${width} ${lang} ${theme} overflow`).toBe(false);
          expect(snap.tabLabels, `${width} ${lang} ${theme} tabs`).toEqual(expectedTabs);
          expect(snap.tabLabels.some(l => l === words.settings.menu), `${width} ${lang} ${theme} no Settings tab`).toBe(false);
          expect(snap.logoParts, `${width} ${lang} ${theme} exact LogoMark parts`).toEqual({ dome: 1, base: 1, dot: 1 });
          if (theme === 'egypt') {
            await expect(page.locator('html')).toHaveAttribute('data-world', 'egypt');
            await expect(page.locator('html')).toHaveAttribute('data-surface', 'papyrus');
          } else {
            await expect(page.locator('html')).not.toHaveAttribute('data-world');
            await expect(page.locator('html')).not.toHaveAttribute('data-surface');
          }
          if (width === 1440) {
            expect(snap.brand, `${width} ${lang} ${theme} brand visible`).not.toBeNull();
          }

          if (shouldCapture(width, lang, theme)) {
            await capture(page, info, `${theme}-${lang}-${width}`);
          }

          /* Settings stays inside the top-right account menu in every theme. */
          await page.locator('.tb-right .avatar').click();
          await expect(page.locator('.account-menu').getByRole('button', { name: words.settings.menu, exact: true })).toBeVisible();
        } finally {
          await context.close();
        }
      }

      const base = results.get('cyberpunk')!;
      const tickerTol = width === 375 ? 4 : 2;
      for (const other of ['light', 'egypt'] as const) {
        const cur = results.get(other)!;
        const tag = `${width} ${lang} ${other} vs cyberpunk`;
        if (base.brand && cur.brand) {
          expectClose(cur.brand.x, base.brand.x, 1, `${tag} brand.x`);
          expectClose(cur.brand.y, base.brand.y, 1, `${tag} brand.y`);
          expectClose(cur.brand.width, base.brand.width, 1, `${tag} brand.width`);
          expectClose(cur.brand.height, base.brand.height, 1, `${tag} brand.height`);
        }
        expectClose(cur.tabsBar.y, base.tabsBar.y, 2, `${tag} tabs.y`);
        expectClose(cur.tabsBar.height, base.tabsBar.height, 2, `${tag} tabs.height`);
        if (width === 1440) {
          expectClose(cur.tabsBar.x + cur.tabsBar.width / 2, base.tabsBar.x + base.tabsBar.width / 2, 2, `${tag} tabs.centerX`);
        }
        expectClose(cur.avatar.x, base.avatar.x, 1, `${tag} avatar.x`);
        expectClose(cur.avatar.y, base.avatar.y, 1, `${tag} avatar.y`);
        expectClose(cur.avatar.width, base.avatar.width, 1, `${tag} avatar.width`);
        expectClose(cur.avatar.height, base.avatar.height, 1, `${tag} avatar.height`);
        expectClose(cur.zoom.x, base.zoom.x, 2, `${tag} zoom.x`);
        expectClose(cur.zoom.y, base.zoom.y, 2, `${tag} zoom.y`);
        expectClose(cur.zoom.height, base.zoom.height, 2, `${tag} zoom.height`);
        expectClose(cur.ticker.bottom, base.ticker.bottom, 2, `${tag} ticker.bottom`);
        expectClose(cur.ticker.height, base.ticker.height, tickerTol, `${tag} ticker.height`);
        expectClose(cur.ticker.x + cur.ticker.width / 2, base.ticker.x + base.ticker.width / 2, 2, `${tag} ticker.centerX`);
        expectClose(cur.version.bottom, base.version.bottom, tickerTol, `${tag} version.bottom`);
        expectClose(cur.version.right, base.version.right, 2, `${tag} version.right`);
      }
    }
  }
});
