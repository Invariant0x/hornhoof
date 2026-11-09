import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type Language } from '../src/i18n';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { box, detail, openTaskRow as openTask, serveApi, TASKS } from './api';

/* A task or an agent's window slides over a page: the page keeps its width and place, the panel runs to the bottom of the
   window, scrolls by itself and leaves the page scrolled where it was. */

test.use({ locale: 'en-US' });

test('a tab closes the task, history restores it, and the agent window stays on the right', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTasks(page);
  await openTask(page, 1);
  expect((await box(panelOf(page, 1))).x).toBe(16);
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(panelOf(page, 1)).toHaveCount(0);
  await expect(page.locator('.map .dept')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\/t1$/);
  await expect(panelOf(page, 1)).toBeVisible();
  await panelOf(page, 1).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Write to the orchestrator' }).click();
  const window = await box(page.getByRole('complementary', { name: 'Orchestrator' }));
  expect(window.x + window.width).toBe(1424);
});

const SIZES = [
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
];

/* Opens Hornhoof and goes to a page by the buttons a person clicks, until its heading shows. */
async function openPage(page: Page, heading: string, ...buttons: (string | RegExp)[]) {
  await serveApi(page);
  await page.goto('/');
  for (const name of buttons) await page.getByRole('button', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}
async function openTasks(page: Page) {
  await openPage(page, 'Tasks', /^Tasks/);
  await expect(page.getByText('Nothing waits for you.')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Development' })).toBeChecked();
  await expect(row(page, 1)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
const openImprovements = (page: Page) => openPage(page, 'Improvements', 'Account', 'Improvements');

const row = (page: Page, n: number) => page.getByRole('row', { name: `#${n} Checkout step ${n}`, exact: true });
const panelOf = (page: Page, n: number) => page.getByRole('complementary', { name: `#${n} Checkout step ${n}` });

/* What scrolls on a page is its main part under the header, not the document. */
const pageScroll = (page: Page) => page.getByRole('main').evaluate(el => el.scrollTop);
async function scrollPage(page: Page, top: number) {
  await page.getByRole('main').evaluate((el, y) => el.scrollTo(0, y), top);
  await expect.poll(() => pageScroll(page)).toBe(top);
}

/* Each panel that opens over a page: the page, what on it must keep its width and place, and how the panel opens. */
const PANELS: { name: string; go: (page: Page) => Promise<void>; content: (page: Page) => Locator; open: (page: Page) => Promise<Locator> }[] = [
  {
    name: 'a task from the list',
    go: openTasks,
    content: page => row(page, 1),
    open: async page => {
      await openTask(page, 1);
      await expect(panelOf(page, 1).getByRole('heading', { name: 'Checkout step 1' })).toBeVisible();
      return panelOf(page, 1);
    },
  },
  {
    name: "the orchestrator's window",
    go: openTasks,
    content: page => row(page, 1),
    open: async page => {
      await page.getByRole('button', { name: 'Write to the orchestrator' }).click();
      const panel = page.getByRole('complementary', { name: 'Orchestrator' });
      await expect(panel).toBeVisible();
      return panel;
    },
  },
  {
    name: 'a task from an improvement',
    go: openImprovements,
    content: page => page.getByRole('article', { name: 'Check card numbers before sending them' }),
    open: async page => {
      await page.getByRole('button', { name: '#3 Checkout step 3' }).click();
      await expect(panelOf(page, 3).getByRole('heading', { name: 'Checkout step 3' })).toBeVisible();
      return panelOf(page, 3);
    },
  },
];

for (const size of SIZES) {
  test.describe(`at ${size.width}×${size.height}`, () => {
    test.use({ viewport: size });

    for (const panel of PANELS) {
      test(`${panel.name} leaves the page as wide and where it was`, async ({ page }) => {
        await panel.go(page);
        const before = await box(panel.content(page));
        await panel.open(page);
        const after = await box(panel.content(page));
        expect({ x: after.x, width: after.width }).toEqual({ x: before.x, width: before.width });
      });

      test(`${panel.name} runs to the bottom of the window`, async ({ page }) => {
        await panel.go(page);
        const open = await box(await panel.open(page));
        expect(open.y + open.height).toBe(size.height);
      });
    }
  });
}

test.describe('scrolling', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opening and closing the panel keeps the list scrolled where it was', async ({ page }) => {
    await openTasks(page);
    await scrollPage(page, 900);
    const scrolled = await pageScroll(page);
    expect(scrolled).toBeGreaterThan(0);
    const n = 12;
    await openTask(page, n);
    await expect(panelOf(page, n)).toBeVisible();
    expect(await pageScroll(page)).toBe(scrolled);

    await panelOf(page, n).getByRole('button', { name: 'Close' }).click();
    await expect(panelOf(page, n)).toHaveCount(0);
    expect(await pageScroll(page)).toBe(scrolled);
  });

  test('Esc closes the panel and leaves the list where it was', async ({ page }) => {
    await openTasks(page);
    await scrollPage(page, 900);
    const scrolled = await pageScroll(page);
    await openTask(page, 12);
    await expect(panelOf(page, 12)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panelOf(page, 12)).toHaveCount(0);
    expect(await pageScroll(page)).toBe(scrolled);
  });

  test('the panel scrolls by itself and the page under it stays put', async ({ page }) => {
    await openTasks(page);
    await scrollPage(page, 300);
    const scrolled = await pageScroll(page);
    await openTask(page, 5);
    const panel = panelOf(page, 5);
    const heading = panel.getByRole('heading', { name: 'Checkout step 5' });
    await expect(heading).toBeVisible();
    const top = (await box(heading)).y;
    const inside = await box(panel);
    await page.mouse.move(inside.x + inside.width / 2, inside.y + inside.height / 2);
    /* Past the panel's end too, where a wheel could carry on to the page. */
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 800);
    await expect.poll(async () => (await box(heading)).y).toBeLessThan(top);
    expect(await pageScroll(page)).toBe(scrolled);
  });
});

const MESSAGES: Record<Language, Messages> = { en, ru };
const CHECKED_LOCALES = [...LANGUAGES]
  .map(entry => ({ id: entry.id, score: MESSAGES[entry.id].tasks.independentPart.length }))
  .sort((a, b) => b.score - a.score)
  .filter((entry, index, all) => index === 0 || index === all.length - 1)
  .map(entry => entry.id);
const LONG_PART = `contract/${'x'.repeat(180)}`;

for (const lang of CHECKED_LOCALES) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 1440]) {
      test(`independent part wraps without sideways scroll: ${lang}/${theme}/${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript(language => localStorage.setItem('hh-lang', language), lang);
        await serveApi(page);
        const base = TASKS[0]!;
        await page.route('**/api/tasks/t1', route => route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            task: {
              ...detail(base),
              independentPart: {
                title: 'Contract tests', brief: 'Test first.', body: LONG_PART,
                executor: { id: 'b1', name: 'Bruno', kind: 'worker', role: null },
                task: { id: 't31', number: 31, title: 'Contract tests', status: 'open' },
              },
            },
          }),
        }));
        await page.goto('/');
        await page.getByRole('button', { name: lang === 'ru' ? 'Задачи' : 'Tasks', exact: true }).click();
        await openTask(page, 1);
        const panel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
        const part = panel.getByRole('region', { name: MESSAGES[lang].tasks.independentPart });
        await expect(part).toBeVisible();
        await expect(part.getByText(LONG_PART)).toBeVisible();
        for (const element of [panel, part]) {
          const dimensions = await element.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
          expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
        }
        await page.screenshot({ path: info.outputPath(`independent-part-${lang}-${theme}-${width}.png`), fullPage: true });
      });
    }
  }
}
