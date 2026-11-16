import { expect, test, type Locator, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { MachineView, NoteView, PersonView, ShownCommand } from '../src/types';
import { openAgent } from './agent-window-panels-api';
import { detail as taskDetail, serveApi, TASKS } from './api';
import { serveRoutes } from './routes-api';
import { captureWith } from './capture';

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const PHASE = process.env.HH_PANEL_PHASE ?? 'after';
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
const LONG_URL = `https://example.invalid/reports/${'Evidence'.repeat(20)}`;
const LONG_TEXT = `Keep the full delivery report at ${LONG_URL}`;
const NOTES: NoteView[] = [
  { number: 1, text: LONG_TEXT, by: { kind: 'person', id: 'p-long', name: 'Alexandria Example Long Display Name' }, updatedAt: '2026-11-04T00:00:00.000Z' },
  { number: 2, text: 'Short note.', by: { kind: 'orchestrator' }, updatedAt: '2026-11-04T00:00:00.000Z' },
];

test.use({ hasTouch: true });

const capture = captureWith(PHASE, SCREENSHOT_DIR);

async function expectInside(container: Locator, elements: Locator[]) {
  const outer = await container.boundingBox();
  expect(outer).not.toBeNull();
  for (const element of elements) {
    const rect = await element.boundingBox();
    expect(rect, 'the measured element is visible').not.toBeNull();
    expect(rect!.x, 'left edge stays inside').toBeGreaterThanOrEqual(outer!.x - 1);
    expect(rect!.x + rect!.width, 'right edge stays inside').toBeLessThanOrEqual(outer!.x + outer!.width + 1);
  }
}

async function expectWrappedText(element: Locator) {
  await expect(element).toHaveCSS('white-space', 'normal');
  await expect(element).toHaveCSS('overflow-wrap', 'anywhere');
  expect(await element.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      {
        const look = `${lang}-${theme}-${width}`;
        test(`Notebook content and its whole action group fit: ${look}`, async ({ page }, info) => {
          const m = MESSAGES[lang];
          const { errors, openPanel } = await openAgent(page, { lang, theme, width }, 'orchestrator');
          const removed: string[] = [];
          await page.route('**/api/notebook', route => route.fulfill({ json: { notes: NOTES } }));
          await page.route('**/api/notebook/1', route => {
            if (route.request().method() !== 'DELETE') return route.fallback();
            removed.push(route.request().url());
            return route.fulfill({ status: 204 });
          });
          const notebook = await openPanel('notebook');
          const body = notebook.locator('.ac-body');
          const list = notebook.locator('.notebook ul');
          await expect(list).toBeVisible();
          await capture(page, info, `notebook-${look}`);
          const first = list.locator('li').nth(0);
          const second = list.locator('li').nth(1);
          await expect(first).toHaveClass(/(^| )entry( |$)/);
          await expect(first.locator('.entry-main')).toHaveCount(1);
          const actions = first.locator('.entry-actions');
          await expect(actions).toHaveAttribute('role', 'group');
          const text = first.locator('.entry-main > span');
          const change = first.getByRole('button', { name: m.notebook.changeNote(1), exact: true });
          const remove = first.getByRole('button', { name: m.notebook.removeNote(1), exact: true });
          await expect(change).toHaveCSS('min-height', '44px');
          await expect(remove).toHaveCSS('min-height', '44px');
          await expectInside(body, [notebook.locator('.notebook'), first, text, change, remove]);
          await expectWrappedText(text);
          const textBox = (await text.boundingBox())!;
          const changeBox = (await change.boundingBox())!;
          const removeBox = (await remove.boundingBox())!;
          expect(changeBox.y, 'the action group starts below the full note').toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);
          expect(removeBox.y, 'actions share one row').toBe(changeBox.y);
          expect(removeBox.x).toBeGreaterThan(changeBox.x);
          const secondChangeBox = (await second.getByRole('button', { name: m.notebook.changeNote(2), exact: true }).boundingBox())!;
          expect(changeBox.x, 'all action groups use one edge').toBe(secondChangeBox.x);

          await change.click();
          await expect(notebook.getByRole('textbox', { name: m.notebook.note(1), exact: true })).toBeVisible();
          const save = notebook.getByRole('button', { name: m.notebook.save, exact: true });
          await save.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(save).toBeFocused();
          await expect(save).toHaveCSS('clip-path', 'none');
          await expect(save).toHaveCSS('outline-width', '2px');
          await expect(save).toHaveCSS('outline-style', 'solid');
          await notebook.getByRole('button', { name: m.notebook.cancel, exact: true }).click();
          await change.focus();
          await page.keyboard.press('Enter');
          await expect(notebook.getByRole('textbox', { name: m.notebook.note(1), exact: true })).toBeVisible();
          await notebook.getByRole('button', { name: m.notebook.cancel, exact: true }).click();
          if (width === 375) {
            await change.tap();
            await expect(notebook.getByRole('textbox', { name: m.notebook.note(1), exact: true })).toBeVisible();
            await notebook.getByRole('button', { name: m.notebook.cancel, exact: true }).tap();
          }
          await remove.click();
          await expect.poll(() => removed.length).toBe(1);
          expect(errors).toEqual([]);
        });
      }

      const look = `${lang}-${theme}-${width}`;
      test(`Task text wraps without clipping and still opens: ${look}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
        const task = { ...TASKS[0]!, brief: LONG_TEXT };
        await serveApi(page);
        const current = { version: '0.7.0', commit: 'panel-overflow-test' };
        await page.route('**/api/version', route => route.fulfill({ json: current }));
        await page.route('**/api/updates', route => route.fulfill({ json: { current, available: false, latest: null, updater: { status: null, waiting: null } } }));
        await page.route('**/api/tasks?status=all', route => route.fulfill({ json: { tasks: [task, ...TASKS.slice(1)] } }));
        await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: { ...taskDetail(task), body: LONG_TEXT, executor: task.assignee, createdBy: null } } }));
        await page.goto('/tasks?department=d2');
        const row = page.locator('.tr-main').getByRole('listitem', { name: '#1 Checkout step 1', exact: true });
        const title = row.locator('.tr-title');
        await expect(title).toBeVisible();
        await capture(page, info, `tasks-${look}`);
        await expectInside(row, [title]);
        await title.click();
        const detail = page.getByRole('complementary', { name: /#1 Checkout step 1/ });
        await expect(detail.locator('.tp-brief')).toHaveText(LONG_TEXT);
        const actions = detail.locator('.ac-actions .entry-actions');
        await expect(actions).toHaveAttribute('role', 'group');
        for (const button of await actions.getByRole('button').all()) await expect(button).toHaveCSS('min-height', '44px');
        await capture(page, info, `task-detail-${look}`);
        await expectWrappedText(detail.locator('.tp-brief'));
        await expectInside(detail.locator('.ac-body'), [detail.locator('.tp-brief')]);
        expect(errors).toEqual([]);
      });
    }
  }
}

const LONG_HOST = `build-${'x'.repeat(140)}.example.internal`;
const LONG_PERSON: PersonView = { id: 'p2', name: `Alexandria${'VeryLong'.repeat(20)}`, email: 'long@acme.test', title: 'COO', status: 'active', isOwner: false, access: { whole: true, departments: [], teams: [] } };
const LONG_MACHINE: MachineView = {
  id: 'm1', hostname: LONG_HOST, owner: { id: 'p1', name: 'Ivan' }, os: 'linux', arch: 'x86_64', online: false,
  lastSeenAt: null, load: null, plans: [], lendsTests: true, running: { agents: [], parts: [] },
};
const LONG_COMMAND: ShownCommand = { id: 'cmd1', kind: 'machine', plans: [], machine: null, command: LONG_URL, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

async function prepareRoutes(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await serveRoutes(page);
  return errors;
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      const look = `${lang}-${theme}-${width}`;
      const m = MESSAGES[lang];

      test(`People names and row actions stay inside: ${look}`, async ({ page }, info) => {
        const errors = await prepareRoutes(page, lang, theme, width);
        await page.route('**/api/people', route => route.fulfill({ json: { people: [LONG_PERSON] } }));
        await page.goto('/people');
        const row = page.locator('.ptable tbody tr').first();
        await expect(row.locator('xpath=ancestor::div[contains(@class, "fit")]')).toHaveCount(1);
        const name = row.locator('.pname');
        const actions = row.locator('.row-actions');
        const group = actions.locator('.entry-actions');
        await expect(group).toHaveAttribute('role', 'group');
        const edit = group.getByRole('button', { name: m.people.editLabel(LONG_PERSON.name), exact: true });
        await expect(edit).toHaveCSS('min-height', '44px');
        await expect(name).toBeVisible();
        await expect(row.locator('xpath=ancestor::table')).toHaveAttribute('data-fit', 'entries');
        await capture(page, info, `people-${look}`);
        const cells = row.locator('td');
        for (const [index, column] of (['name', 'title', 'access', 'status', 'actions'] as const).entries()) {
          await expect(cells.nth(index)).toHaveAttribute('data-label', m.people.columns[column]);
        }
        if (width === 375) expect(await cells.first().evaluate(el => getComputedStyle(el, '::before').content)).toBe(`"${m.people.columns.name}"`);
        await expectWrappedText(name);
        await expectInside(row, [name, actions]);
        await expectInside(actions, [edit]);
        await edit.click();
        await expect(page.getByRole('heading', { name: m.people.editHeading(LONG_PERSON.name) })).toBeVisible();
        expect(errors).toEqual([]);
      });

      test(`A long machine confirmation keeps its whole action group below: ${look}`, async ({ page }, info) => {
        const errors = await prepareRoutes(page, lang, theme, width);
        await page.route('**/api/machines', route => route.fulfill({ json: { machines: [LONG_MACHINE] } }));
        await page.goto('/machines/m1');
        const card = page.getByRole('article', { name: LONG_HOST, exact: true });
        await expect(card).toBeVisible();
        await card.getByRole('button', { name: m.machines.disconnectLabel(LONG_HOST), exact: true }).click();
        const ask = card.locator('.ask');
        const question = ask.locator('.entry-main');
        const group = ask.locator('.entry-actions');
        await expect(group).toHaveAttribute('role', 'group');
        const buttons = group.getByRole('button');
        for (const button of await buttons.all()) await expect(button).toHaveCSS('min-height', '44px');
        await capture(page, info, `machine-confirm-${look}`);
        await expectWrappedText(question);
        await expectInside(ask, [question, ...await buttons.all()]);
        const questionBox = (await question.boundingBox())!;
        const yesBox = (await buttons.nth(0).boundingBox())!;
        const noBox = (await buttons.nth(1).boundingBox())!;
        expect(yesBox.y).toBeGreaterThanOrEqual(questionBox.y + questionBox.height - 1);
        expect(noBox.y).toBe(yesBox.y);
        await buttons.nth(1).click();
        await expect(ask).toHaveCount(0);
        expect(errors).toEqual([]);
      });

      test(`Settings link and remove actions stay readable: ${look}`, async ({ page }, info) => {
        const errors = await prepareRoutes(page, lang, theme, width);
        await page.route('**/api/link', route => route.fulfill({ json: { link: { name: 'evidence', url: LONG_URL }, domain: 'example.invalid' } }));
        await page.goto('/settings/company');
        const dialog = page.getByRole('dialog', { name: m.settings.title, exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: m.settings.remove, exact: true }).click();
        /* The actions that hold the question: the settings show other actions beside the link's. */
        const actions = dialog.locator('.settings-actions').filter({ has: page.locator('.entry-main') });
        const question = actions.locator('.entry-main');
        const group = actions.locator('.entry-actions');
        await expect(group).toHaveAttribute('role', 'group');
        const buttons = group.getByRole('button');
        for (const button of await buttons.all()) await expect(button).toHaveCSS('min-height', '44px');
        await capture(page, info, `settings-remove-${look}`);
        await expectWrappedText(question);
        await expectInside(actions, [question, ...await buttons.all()]);
        const questionBox = (await question.boundingBox())!;
        const yesBox = (await buttons.nth(0).boundingBox())!;
        const noBox = (await buttons.nth(1).boundingBox())!;
        expect(yesBox.y).toBeGreaterThanOrEqual(questionBox.y + questionBox.height - 1);
        expect(noBox.y).toBe(yesBox.y);
        await buttons.nth(1).click();
        await expect(dialog.getByRole('button', { name: m.settings.remove, exact: true })).toBeVisible();
        expect(errors).toEqual([]);
      });

      test(`A long command and its actions fit the panel: ${look}`, async ({ page }, info) => {
        const errors = await prepareRoutes(page, lang, theme, width);
        await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [LONG_COMMAND] } }));
        const hidden: string[] = [];
        await page.route('**/api/nodes/commands/cmd1/hide', route => {
          hidden.push(route.request().method());
          return route.fulfill({ json: {} });
        });
        await page.goto('/machines');
        const panel = page.locator('.panel').filter({ has: page.locator('.command-box') });
        const command = panel.locator('.command');
        const code = command.locator('code');
        const copy = command.getByRole('button');
        await expect(code).toHaveText(LONG_URL);
        await capture(page, info, `command-${look}`);
        await expectWrappedText(code);
        await expectInside(command, [code, copy]);
        await panel.getByRole('button', { name: m.subs.cancelCommand, exact: true }).click();
        await expect(panel).toHaveCount(0);
        expect(hidden).toEqual(['POST']);
        expect(errors).toEqual([]);
      });
    }
  }
}
