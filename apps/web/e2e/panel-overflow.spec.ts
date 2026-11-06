import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { MachineView, NoteView, PersonView, ShownCommand } from '../src/types';
import { openAgent } from './agent-window-panels-api';
import { serveApi, TASKS } from './api';
import { serveRoutes } from './routes-api';

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

async function capture(page: Page, info: TestInfo, name: string) {
  const file = `${PHASE}-${name}.png`;
  const path = SCREENSHOT_DIR ? `${SCREENSHOT_DIR}/${file}` : info.outputPath(file);
  await page.screenshot({ path });
  await info.attach(file, { path, contentType: 'image/png' });
}

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
          const text = first.locator('.entry-main > p').first();
          await expect(text.locator('b')).toHaveText('#1');
          await expect(text).toContainText(LONG_TEXT);
          const baselines = await text.evaluate(paragraph => {
            const range = document.createRange();
            range.setStart(paragraph.querySelector('b')!.firstChild!, 0);
            range.setEnd(paragraph.querySelector('b')!.firstChild!, 1);
            const numberY = range.getBoundingClientRect().y;
            range.setStartAfter(paragraph.querySelector('b')!);
            range.setEnd(paragraph, paragraph.childNodes.length);
            return { numberY, textY: range.getClientRects()[0]!.y };
          });
          expect(baselines.numberY, 'the note number shares the first text baseline').toBe(baselines.textY);
          const newNote = notebook.getByRole('textbox', { name: m.notebook.newNote, exact: true });
          await expect(newNote).toHaveCSS('border-radius', '0px');
          await expect(newNote).toHaveCSS('background-color', theme === 'light' ? 'rgb(238, 242, 246)' : 'rgb(33, 43, 55)');
          await expect(newNote).toHaveCSS('border-top-color', theme === 'light' ? 'rgb(169, 183, 197)' : 'rgb(61, 76, 92)');
          await expect(newNote).toHaveCSS('color', theme === 'light' ? 'rgb(15, 27, 39)' : 'rgb(227, 234, 241)');
          expect(await newNote.evaluate(el => getComputedStyle(el, '::placeholder').color)).toBe(theme === 'light' ? 'rgb(76, 90, 104)' : 'rgb(147, 160, 174)');
          const actions = first.locator('.entry-actions');
          await expect(actions).toHaveAttribute('role', 'group');
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
        await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: { ...task, body: LONG_TEXT, parent: null, after: [], executor: task.assignee, gates: [], createdBy: null, subtasks: [], log: [], requests: [] } } }));
        await page.goto('/tasks');
        const row = page.locator('button.trow').first();
        const brief = row.locator('.trow-brief');
        await expect(brief).toBeVisible();
        if (width === 375) {
          const version = page.locator('.version-mark');
          await expect(version).toHaveCSS('position', 'static');
          const versionBox = (await version.boundingBox())!;
          const briefBox = (await brief.boundingBox())!;
          expect(versionBox.y, 'the version follows the page instead of covering text').toBeGreaterThanOrEqual(briefBox.y + briefBox.height);
        }
        await capture(page, info, `tasks-${look}`);
        await expectWrappedText(brief);
        await expectInside(row, [brief]);
        await row.click();
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
        const invite = page.getByRole('button', { name: m.people.invitePerson, exact: true });
        await expect(invite).toHaveCSS('min-height', '44px');
        const headerBox = (await page.locator('.people-head').boundingBox())!;
        const inviteBox = (await invite.boundingBox())!;
        expect(inviteBox.x + inviteBox.width, 'the page action shares the content end').toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
        expect(inviteBox.x + inviteBox.width, 'the page action is not left-aligned').toBe(headerBox.x + headerBox.width);
        await capture(page, info, `people-${look}`);
        const cells = row.locator('td');
        const nameCell = cells.first();
        await expect(nameCell).toHaveClass('pname-cell');
        await expect(nameCell).not.toHaveAttribute('data-label');
        await expect(actions).not.toHaveAttribute('data-label');
        const rowBox = (await row.boundingBox())!;
        const nameCellBox = (await nameCell.boundingBox())!;
        expect(nameCellBox.width, 'the name is the full-width record heading').toBe(rowBox.width);
        const status = cells.nth(3).locator('.status');
        await expect(status).toHaveCSS('display', 'inline-block');
        await expect(status).toHaveCSS('max-inline-size', '100%');
        const statusBox = (await status.boundingBox())!;
        expect(statusBox.width, 'the status frame hugs its word').toBeLessThan(rowBox.width);
        for (const [index, column] of (['title', 'access', 'status'] as const).entries()) {
          const cell = cells.nth(index + 1);
          await expect(cell).toHaveAttribute('data-label', m.people.columns[column]);
          await expect(cell).toHaveCSS('align-items', 'baseline');
          const pseudo = await cell.evaluate(el => {
            const style = getComputedStyle(el, '::before');
            return { content: style.content, size: style.fontSize, weight: style.fontWeight, color: style.color };
          });
          expect(pseudo.content).toBe(`"${m.people.columns[column]}"`);
          expect(pseudo.size, 'record label size is width-independent').toBe('12px');
          expect(pseudo.weight, 'record label weight is width-independent').toBe('400');
          expect(pseudo.color).toBe(theme === 'light' ? 'rgb(76, 90, 104)' : 'rgb(147, 160, 174)');
        }
        await expect(actions).toHaveCSS('margin-block-start', '8px');
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
        await page.goto('/settings');
        const dialog = page.getByRole('dialog', { name: m.settings.title, exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: m.settings.remove, exact: true }).click();
        const actions = dialog.locator('.settings-actions');
        const question = actions.locator('.entry-main');
        const group = actions.locator('.entry-actions');
        await expect(group).toHaveAttribute('role', 'group');
        await expect(dialog.getByRole('button', { name: m.common.done, exact: true })).toHaveCSS('min-height', '44px');
        const copy = dialog.getByRole('button', { name: m.common.copy, exact: true });
        await expect(copy).toHaveCSS('min-height', '44px');
        const copyBox = (await copy.boundingBox())!;
        const groupBox = (await group.boundingBox())!;
        expect(copyBox.x + copyBox.width, 'Copy shares the confirmation end').toBe(groupBox.x + groupBox.width);
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
        await expect(copy).toHaveCSS('min-height', '44px');
        const codeBox = (await code.boundingBox())!;
        const copyBox = (await copy.boundingBox())!;
        const commandBox = (await command.boundingBox())!;
        expect(copyBox.y, 'Copy stands below the command').toBeGreaterThanOrEqual(codeBox.y + codeBox.height);
        expect(Math.abs(copyBox.x + copyBox.width - (commandBox.x + commandBox.width - 12)), 'Copy shares the command end within the border').toBeLessThanOrEqual(1);
        const cancel = panel.getByRole('button', { name: m.subs.cancelCommand, exact: true });
        await expect(cancel).toHaveCSS('min-height', '44px');
        await capture(page, info, `command-${look}`);
        await expectWrappedText(code);
        await expectInside(command, [code, copy]);
        await cancel.click();
        await expect(panel).toHaveCount(0);
        expect(hidden).toEqual(['POST']);
        expect(errors).toEqual([]);
      });
    }
  }
}
