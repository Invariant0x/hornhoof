import { expect, test, type Page } from '@playwright/test';
import type { Messages } from '../src/i18n/en';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { PersonView } from '../src/types';
import { box, serveApi } from './api';

type Box = Awaited<ReturnType<typeof box>>;

const WHOLE = { whole: true, departments: [], teams: [] };
/* The CEO, a person the CEO may mark as the delegate, the delegate, and a delegate switched off: each of the others has
   the mark in a row of three buttons, the last one with Enable for Disable. */
const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: WHOLE },
  { id: 'p2', name: 'Dana', email: 'dana@acme.com', title: 'COO', status: 'active', isOwner: false, isCeoDelegate: false, access: WHOLE },
  { id: 'p3', name: 'Ruth', email: 'ruth@acme.com', title: 'CFO', status: 'active', isOwner: false, isCeoDelegate: true, access: WHOLE },
  { id: 'p4', name: 'Mia', email: 'mia@acme.com', title: 'CTO', status: 'disabled', isOwner: false, isCeoDelegate: true, access: WHOLE },
];
/* How many buttons share the mark's line: all three on a wide screen; on a phone the row wraps, and one at least. */
const SIZES = [{ width: 1440, beside: 3 }, { width: 375, beside: 1 }];
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const ROUTES: Record<string, unknown> = {
  '/api/people': { people: PEOPLE },
  '/api/version': { version: '0.5.0', commit: 'task-170' },
  '/api/updates': { current: { version: '0.5.0', commit: 'task-170' }, available: false, latest: null, updater: { status: null, waiting: null } },
};

/* Two boxes share a line of the row when they overlap from top to bottom. */
const sameLine = (a: Box, b: Box) => a.y < b.y + b.height && b.y < a.y + a.height;

async function rowOf(page: Page, t: Messages, { name, status }: PersonView) {
  const tick = page.getByRole('checkbox', { name: t.people.ceoDelegateLabel(name), exact: true });
  const mark = tick.locator('xpath=ancestor::label[1]');
  const names = [t.people.editLabel(name), t.people.newLinkLabel(name), status === 'disabled' ? t.people.enableLabel(name) : t.people.disableLabel(name)];
  const edit = page.getByRole('button', { name: names[0], exact: true });
  /* Where a button's words start inside it, which is where the mark's tick should start inside the mark. */
  const textLeft = await edit.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left - el.getBoundingClientRect().left;
  });
  const buttons = await Promise.all(names.map(n => box(page.getByRole('button', { name: n, exact: true }))));
  return { mark: await box(mark), tick: await box(tick), textLeft, buttons };
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const { width, beside: least } of SIZES) {
      test(`the CEO delegate mark lines up with the row's buttons in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await serveApi(page);
        await page.route('**/api/**', route => {
          const url = new URL(route.request().url());
          const path = url.pathname + url.search;
          return path in ROUTES ? route.fulfill({ json: ROUTES[path] }) : route.fallback();
        });
        await page.goto('/');
        await page.getByRole('button', { name: t.shell.tabs.people, exact: true }).click();
        /* The rows as people see them, taken before the checks so that a failing run shows them too. */
        await page.locator('table.ptable').screenshot({ path: info.outputPath(`people-${width}-${lang}-${theme}.png`) });
        /* The words take their own font only once it has loaded, and with it their width. */
        await page.evaluate(async () => { await document.fonts.ready; });
        for (const person of PEOPLE.filter(p => !p.isOwner)) {
          const name = person.name;
          const { mark, tick, textLeft, buttons } = await rowOf(page, t, person);
          /* Inside, the mark keeps a button's padding and holds its tick in the middle. */
          expect(Math.abs(tick.x - mark.x - textLeft), `${name}: space before the tick`).toBeLessThanOrEqual(1);
          expect(Math.abs(tick.y + tick.height / 2 - (mark.y + mark.height / 2)), `${name}: tick in the middle of the mark`).toBeLessThanOrEqual(1);
          const beside = buttons.filter(b => sameLine(mark, b));
          expect(beside.length, `${name}: buttons on the mark's line`).toBeGreaterThanOrEqual(least);
          for (const b of beside) {
            expect(Math.abs(mark.y - b.y), `${name}: top of the mark against a button`).toBeLessThanOrEqual(1);
            expect(Math.abs(mark.y + mark.height - (b.y + b.height)), `${name}: bottom of the mark against a button`).toBeLessThanOrEqual(1);
          }
          /* The gap after the mark is the gap between two buttons that share a line. */
          const pair = buttons.findIndex((b, i) => i + 1 < buttons.length && sameLine(b, buttons[i + 1]!));
          expect(pair, `${name}: two buttons that share a line`).toBeGreaterThanOrEqual(0);
          const between = buttons[pair + 1]!.x - (buttons[pair]!.x + buttons[pair]!.width);
          expect(Math.abs(beside[0]!.x - (mark.x + mark.width) - between), `${name}: gap after the mark`).toBeLessThanOrEqual(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }
}
