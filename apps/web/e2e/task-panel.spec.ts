import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type Language } from '../src/i18n';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { box, detail, openTaskAction, openTaskCard, serveApi, TASKS, writeToOrchestrator } from './api';

/* A task or an agent's window slides over a page: the page keeps its place, the panel runs to the bottom of the window,
   scrolls by itself and leaves the page scrolled where it was. On the tracker a task's card stands at the end side, and from
   1100 px the tracker's work narrows to make room for it beside it (style book, PROPOSAL Tracker). */

test.use({ locale: 'en-US' });

test('a tab closes the task, history restores it, and the task and the agent window stay on the right', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTasks(page);
  await openTask(page, 1);
  /* The card is the mockup's drawer, at the very end of the screen. */
  const card = await box(panelOf(page, 1));
  expect(card.x + card.width).toBe(1440);
  await page.getByRole('navigation').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(panelOf(page, 1)).toHaveCount(0);
  await expect(page.locator('.map .dept')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\/t1$/);
  await expect(panelOf(page, 1)).toBeVisible();
  await panelOf(page, 1).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Tasks', exact: true }).click();
  await writeToOrchestrator(page);
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
/* The tracker at the department of the tasks, as its list. */
async function openTasks(page: Page) {
  await openPage(page, 'My tasks', /^Tasks/);
  /* On a phone the lists open as a drawer first. */
  const lists = page.getByRole('button', { name: 'Lists', exact: true });
  if (await lists.isVisible()) await lists.click();
  await page.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: /^Development/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Development' })).toBeVisible();
  await expect(row(page, 1)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
const openImprovements = (page: Page) => openPage(page, 'Improvements', 'Account', 'Improvements');

const row = (page: Page, n: number) => page.locator('.tr-main').getByRole('listitem', { name: `#${n} Checkout step ${n}`, exact: true });
/* A task opens from its title in the list. */
const openTask = (page: Page, n: number) => row(page, n).locator('.tr-title').click();
const panelOf = (page: Page, n: number) => page.getByRole('complementary', { name: `#${n} Checkout step ${n}` });

/* What scrolls on a page is its main part under the header, not the document. */
const pageScroll = (page: Page) => page.getByRole('main').evaluate(el => el.scrollTop);
/* Scrolls the page down until the card of task n is in sight, so opening it moves nothing. */
async function scrollTo(page: Page, n: number) {
  await row(page, n).scrollIntoViewIfNeeded();
  await expect.poll(() => pageScroll(page)).toBeGreaterThan(0);
}

/* Where something on the page starts and how wide it is. */
type Place = { x: number; width: number };
const placeOf = async (locator: Locator): Promise<Place> => {
  const { x, width } = await box(locator);
  return { x, width };
};

/* Each panel that opens over a page: the page, what on it must keep its width and place, and how the panel opens. */
const PANELS: { name: string; go: (page: Page) => Promise<void>; content: (page: Page) => Promise<Place>; open: (page: Page) => Promise<Locator> }[] = [
  {
    name: 'a task from the list',
    go: openTasks,
    /* The tracker's view tabs keep their place and width, from List to Graph: the card opens over the work, as the mockup's
       drawer does, and narrows nothing. */
    content: async page => {
      await expect(page.locator('.tr-views label').last()).toBeVisible();
      return page.locator('.tr-views').evaluate(views => {
        const boxes = [...views.querySelectorAll(':scope > label')].map(tab => tab.getBoundingClientRect());
        const x = Math.min(...boxes.map(b => b.left));
        return { x, width: Math.max(...boxes.map(b => b.right)) - x };
      });
    },
    open: async page => {
      await openTask(page, 1);
      await expect(panelOf(page, 1).getByRole('heading', { name: 'Checkout step 1' })).toBeVisible();
      return panelOf(page, 1);
    },
  },
  {
    name: "the orchestrator's window",
    go: openTasks,
    content: page => placeOf(row(page, 1)),
    open: async page => {
      await writeToOrchestrator(page);
      const panel = page.getByRole('complementary', { name: 'Orchestrator' });
      await expect(panel).toBeVisible();
      return panel;
    },
  },
  {
    name: 'a task from an improvement',
    go: openImprovements,
    content: page => placeOf(page.getByRole('article', { name: 'Check card numbers before sending them' })),
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
        const before = await panel.content(page);
        await panel.open(page);
        expect(await panel.content(page)).toEqual(before);
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
    const n = 12;
    await scrollTo(page, n);
    const scrolled = await pageScroll(page);
    expect(scrolled).toBeGreaterThan(0);
    await openTask(page, n);
    await expect(panelOf(page, n)).toBeVisible();
    expect(await pageScroll(page)).toBe(scrolled);

    await panelOf(page, n).getByRole('button', { name: 'Close' }).click();
    await expect(panelOf(page, n)).toHaveCount(0);
    expect(await pageScroll(page)).toBe(scrolled);
  });

  test('Esc closes the panel and leaves the list where it was', async ({ page }) => {
    await openTasks(page);
    await scrollTo(page, 12);
    const scrolled = await pageScroll(page);
    await openTask(page, 12);
    await expect(panelOf(page, 12)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panelOf(page, 12)).toHaveCount(0);
    expect(await pageScroll(page)).toBe(scrolled);
  });

  test('the panel scrolls by itself and the page under it stays put', async ({ page }) => {
    await openTasks(page);
    await scrollTo(page, 5);
    const scrolled = await pageScroll(page);
    await openTask(page, 5);
    const panel = panelOf(page, 5);
    const heading = panel.getByRole('heading', { name: 'Checkout step 5' });
    await expect(heading).toBeVisible();
    await panel.getByRole('button', { name: en.tasks.moreDescription, exact: true }).click();
    await panel.evaluate(el => el.querySelector('.ac-body')!.scrollTop = 0);
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
const ranked = LANGUAGES.map(({ id }) => {
  const { tasks, tracker, window } = MESSAGES[id];
  const copy = [window.close, tracker.groups.working, tracker.card.executor, tracker.card.responsible, tracker.card.due, tracker.card.facts,
    tasks.moreDescription, tasks.showLess, tasks.log, tasks.earlierSteps, tasks.taskActions, tasks.details,
    tasks.backToActions, tasks.independentPart, tasks.events.comment(''), tracker.groups.notStarted];
  return { id, score: copy.reduce((sum, line) => sum + line.length, 0) };
}).sort((a, b) => a.score - b.score);
const rtl = LANGUAGES.find(({ id }) => /^(ar|fa|he|ps|sd|ug|ur|yi)(-|$)/.test(id));
const CHECKED_LOCALES = new Set([ranked[0]!.id, ranked.at(-1)!.id, ...(rtl ? [rtl.id] : [])]);
const LONG_PART = `contract/${'x'.repeat(180)}`;

for (const lang of CHECKED_LOCALES) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [390, 1440]) {
      test(`the task wraps on its face and in Details: ${lang}/${theme}/${width}`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ language, skin }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', skin); }, { language: lang, skin: theme === 'light' ? 'light' : 'cyberpunk' });
        await serveApi(page);
        const base = TASKS[0]!;
        await page.route('**/api/tasks/t1', route => route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            task: {
              ...detail(base),
              title: LONG_PART,
              brief: `Test first. ${LONG_PART}`,
              body: `Test the API.\n\n${LONG_PART}`,
              executor: { ...base.assignee!, name: LONG_PART },
              responsible: { id: 'p1', name: 'Ivan' },
              dueAt: '2099-11-20T00:00:00.000Z',
              log: Array.from({ length: 5 }, (_, i) => ({ kind: 'comment', text: `Checkpoint ${i + 1}.`, data: {}, by: null, at: base.createdAt })),
              independentPart: {
                title: 'Contract tests', brief: 'Test first.', body: LONG_PART,
                executor: { id: 'b1', name: 'Bruno', kind: 'worker', role: null },
                task: { id: 't31', number: 31, title: 'Contract tests', status: 'open' },
              },
            },
          }),
        }));
        await page.goto('/');
        await page.getByRole('button', { name: t.shell.tabs.tasks, exact: true }).click();
        await openTaskCard(page, 1);
        const panel = page.getByRole('complementary', { name: `#1 ${LONG_PART}` });
        await expect(panel.getByRole('heading', { name: LONG_PART })).toBeVisible();
        const trigger = panel.getByRole('button', { name: t.tasks.taskActions });
        const target = await box(trigger);
        /* 44 px for a finger on a phone, the card's 32 px for a mouse. */
        expect(target.width).toBe(width <= 760 ? 44 : 32);
        expect(target.height).toBe(width <= 760 ? 44 : 32);
        await panel.getByRole('button', { name: t.tasks.moreDescription, exact: true }).click();
        await expect(panel.locator('.tp-body').getByText(LONG_PART)).toBeVisible();
        await panel.getByRole('button', { name: t.tasks.earlierSteps, exact: true }).click();
        await expect(panel.getByRole('list', { name: t.tasks.log, exact: true }).getByRole('listitem')).toHaveCount(5);
        await page.screenshot({ path: info.outputPath(`task-card-${lang}-${theme}-${width}.png`), fullPage: true });
        await openTaskAction(panel, t, t.tasks.details);
        const part = panel.getByRole('region', { name: t.tasks.independentPart });
        await expect(part).toBeVisible();
        await expect(part.getByText(LONG_PART)).toBeVisible();
        for (const element of [panel, panel.locator('.ac-body'), part]) {
          const dimensions = await element.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
          expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
        }
        await page.screenshot({ path: info.outputPath(`independent-part-${lang}-${theme}-${width}.png`), fullPage: true });
      });
    }
  }
}
