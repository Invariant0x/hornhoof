import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ELSEWHERE, FAIL_MS, HEADED_ORG, NO_DECISIONS, openTracker, RING_DELAY_MS, shownEmpty, SLOW_MS, type Look } from './empty-sections';
import { stretch } from './pseudo-text';
import { TASKS } from './tasks-board/api';

/* Pictures of the tracker's empty sections and their loading for Design's look at #1638 (Design #1633): Mine in each state, a
   board column with no card and a company with no task at all, on a phone and on a wide screen, in three themes, in English,
   Russian, the long pseudo translation and right to left. They run on request, through empty-sections-shots.config.ts, and
   go to HH_OUT when a run keeps its files there. */
test.describe.configure({ timeout: 120_000 });
const OUT = `${process.env.HH_OUT ?? 'e2e/results'}/empty-sections-shots`;
mkdirSync(OUT, { recursive: true });

/* Development has a head, so the person may make a task where the spec offers it. */
const NONE = { '/api/org': HEADED_ORG, '/api/requests': NO_DECISIONS, '/api/wait-cards': { cards: [], next: null }, '/api/goals': { goals: [] } };
const TONGUES = [
  { name: 'en', look: { lang: 'en' } },
  { name: 'ru', look: { lang: 'ru' } },
  { name: 'pseudo', look: { lang: 'en' }, pseudo: true },
  { name: 'rtl', look: { lang: 'ru', dir: 'rtl' } },
] as const;

type Place = { name: string; path: string; tasks: unknown[]; held?: boolean; run?: number; shown(page: Page): Promise<void> };

const shownList = async (page: Page) => { await expect(page.locator('.tr-list:not(.tr-held) .tr-row, .tr-board').first()).toBeVisible(); };
const shownBlock = async (page: Page) => { await expect(shownEmpty(page).first()).toBeVisible(); };
const busy = async (page: Page) => { await expect(page.locator('.tr-held .spinner')).toBeVisible(); };
const said = (kind: string) => async (page: Page) => { await expect(page.locator(`.tr-held-rows > .load-fail${kind}`)).toBeVisible(); };

const PLACES: Place[] = [
  { name: 'mine-empty', path: '/tasks', tasks: ELSEWHERE, shown: shownBlock },
  { name: 'mine-loading', path: '/tasks', tasks: ELSEWHERE, held: true, run: RING_DELAY_MS, shown: busy },
  { name: 'mine-slow', path: '/tasks', tasks: ELSEWHERE, held: true, run: SLOW_MS, shown: said('.slow') },
  { name: 'mine-failed', path: '/tasks', tasks: ELSEWHERE, held: true, run: FAIL_MS, shown: said(':not(.slow)') },
  { name: 'mine-data', path: '/tasks', tasks: TASKS, shown: shownList },
  /* Mine holds tasks while nothing waits for the person. */
  { name: 'mine-mixed', path: '/tasks', tasks: TASKS.filter(task => task.status !== 'waiting'), shown: shownList },
  { name: 'board-column', path: '/tasks?department=d2&view=board', tasks: TASKS, shown: shownList },
  { name: 'company-first', path: '/tasks', tasks: [], shown: shownBlock },
];

for (const place of PLACES) {
  for (const width of [375, 1440]) {
    for (const theme of ['cyberpunk', 'light', 'matrix']) {
      for (const tongue of TONGUES) {
        test(`${place.name} ${width} ${theme} ${tongue.name}`, async ({ page, browserName }) => {
          const look: Look = { ...tongue.look, width, theme };
          const answers = { ...NONE, '/api/tasks': { tasks: place.tasks } };
          await openTracker(page, place.path, look, answers, place.held ? ['/api/tasks'] : []);
          /* Only a held place moves the clock, once the page asked for what it holds. Any other place moves none: its loads
             end as their answers come, while a ring that showed would hold them for its least time, which the paused clock
             never ends, should the page ask while the clock moves. */
          if (place.run) await page.clock.runFor(place.run);
          await place.shown(page);
          if ('pseudo' in tongue) await stretch(page.locator('.tr-main'));
          await page.screenshot({ path: `${OUT}/${browserName}-${place.name}-${width}-${theme}-${tongue.name}.png`, fullPage: true, animations: 'disabled' });
        });
      }
    }
  }
}
