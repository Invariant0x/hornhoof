import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { PersonView } from '../src/types';
import { ME, serveApi } from './api';
import { messagesFor } from './look-steps';

/* The final look of the confirmation (style book 1.9, section 4 "Confirmation", #1807), as the Head of Design asked to see
   it: an ordinary and a dangerous action, a long name, the wait and a failure, the focus when it opens; at 375 and 1440 px,
   in English, Russian and right to left, in Light and Cyberpunk. No shipped language is written right to left yet, so
   that look is English with the page turned. */
const LONG = 'Александра-Маргарита Константинопольская-Преображенская';
const LONG_EN = 'Maximiliana-Evangelina Montgomery-Featherstonehaugh';

const person = (name: string): PersonView => ({
  ...ME.person, id: 'p2', name, title: 'Editor', isOwner: false, isCeoDelegate: false, access: { whole: true, departments: [], teams: [] },
});

type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; theme: 'light' | 'cyberpunk'; width: 375 | 1440 };
const LOOKS: Look[] = [];
for (const width of [1440, 375] as const) for (const theme of ['light', 'cyberpunk'] as const) {
  LOOKS.push({ lang: 'en', dir: 'ltr', theme, width }, { lang: 'ru', dir: 'ltr', theme, width }, { lang: 'en', dir: 'rtl', theme, width });
}
const lookName = ({ lang, dir, theme, width }: Look) => `${lang}${dir === 'rtl' ? '-rtl' : ''}-${theme}-${width}`;

/* The people page with one person to delete or rename; deleting waits until the test lets it answer, or fails. */
async function people(page: Page, look: Look, name: string) {
  const sent: string[] = [];
  const answer: { release?: () => void; fail: boolean } = { fail: false };
  await serveApi(page);
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, look);
  await page.route('**/api/people', route => route.fulfill({ json: { people: [person(name)] } }));
  await page.route('**/api/people/p2**', async route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: { person: person(name) } });
    sent.push(method);
    if (method === 'DELETE') {
      await new Promise<void>(resolve => (answer.release = resolve));
      if (answer.fail) return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'This person runs the company server. Move the server to another machine first.' } } });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { person: { ...person(name), ...(route.request().postDataJSON() as object) } } });
  });
  await page.setViewportSize({ width: look.width, height: look.width === 375 ? 812 : 900 });
  await page.goto('/people');
  if (look.dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await page.evaluate(async () => { await document.fonts.ready; });
  return { sent, answer };
}

/* What the window must hold at any width: inside the screen, no sideways scroll, nothing cut, buttons from 44 px with the
   action first and Cancel after it, the group on the end edge. */
async function whole(page: Page, dialog: Locator, dir: Look['dir']) {
  const box = dialog.locator('.dialog');
  const frame = (await box.boundingBox())!;
  const view = page.viewportSize()!;
  expect(frame.x).toBeGreaterThanOrEqual(15.5);
  expect(frame.x + frame.width).toBeLessThanOrEqual(view.width - 15.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await box.evaluate(element => [...element.querySelectorAll('h2, p, button')].every(e => e.scrollWidth <= e.clientWidth + 1))).toBe(true);
  const [action, cancel] = await dialog.getByRole('button').all();
  const [a, c] = [(await action!.boundingBox())!, (await cancel!.boundingBox())!];
  expect(Math.min(a.height, c.height)).toBeGreaterThanOrEqual(44);
  expect(a.x + a.width <= c.x + 1 || a.y + a.height <= c.y + 1 || c.x + c.width <= a.x + 1).toBe(true);
  const inner = await box.evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const left = rect.left + element.clientLeft;
    return { left: left + parseFloat(style.paddingLeft), right: left + element.clientWidth - parseFloat(style.paddingRight) };
  });
  if (a.y === c.y) {
    if (dir === 'ltr') expect(Math.abs(c.x + c.width - inner.right), 'Cancel ends the group on the end edge').toBeLessThanOrEqual(1);
    else expect(Math.abs(c.x - inner.left), 'Cancel ends the group on the end edge, the left one').toBeLessThanOrEqual(1);
  }
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`confirm-${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(`confirm-${name}.png`, { path, contentType: 'image/png' });
}

for (const look of LOOKS) {
  test(`shows a dangerous and an ordinary confirmation whole, in ${lookName(look)}`, async ({ page }, info) => {
    const t = await messagesFor(look.lang);
    const name = look.lang === 'ru' ? LONG : look.dir === 'rtl' ? LONG_EN : 'Hana';
    const { sent, answer } = await people(page, look, name);
    const dialog = page.getByRole('alertdialog');

    /* Opened from the keyboard, as a person who tabs: the focus ring stands on Cancel of a dangerous action. */
    const remove = page.getByRole('button', { name: t.people.deleteLabel(name), exact: true });
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveAccessibleName(t.confirm.deletePerson.title);
    expect(await dialog.locator('p bdi').first().evaluate(e => getComputedStyle(e).fontWeight)).toBe('600');
    const cancel = dialog.getByRole('button', { name: t.common.cancel, exact: true });
    await expect(cancel).toBeFocused();
    expect(await cancel.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('solid');
    const action = dialog.locator('.entry-actions > button').first();
    await expect(action).toHaveAccessibleName(t.confirm.deletePerson.yes);
    expect(await action.evaluate(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color])).toEqual(
      await page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.cssText = 'background: var(--red); color: var(--on-red)';
        document.body.append(probe);
        const out = [getComputedStyle(probe).backgroundColor, getComputedStyle(probe).color];
        probe.remove();
        return out;
      }),
    );
    await whole(page, dialog, look.dir);
    await shot(page, info, `danger-focus-${lookName(look)}`);

    /* The action runs: a turning ring and its words, both buttons wait, the group keeps its width. */
    const group = (await dialog.locator('.entry-actions').boundingBox())!;
    await action.click();
    await expect(action).toHaveAttribute('aria-busy', 'true');
    await expect(action).toBeDisabled();
    await expect(cancel).toBeDisabled();
    expect(await action.evaluate(e => getComputedStyle(e.querySelector('.spinner')!).borderTopColor === getComputedStyle(e).color)).toBe(true);
    expect((await dialog.locator('.entry-actions').boundingBox())!.width).toBeCloseTo(group.width, 0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await shot(page, info, `working-${lookName(look)}`);

    /* It fails: the reason stands above the buttons, the window stays and its buttons come back. */
    answer.fail = true;
    answer.release?.();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(action).toBeEnabled();
    await whole(page, dialog, look.dir);
    await shot(page, info, `failure-${lookName(look)}`);
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(remove).toBeFocused();
    expect(sent).toEqual(['DELETE']);

    /* An ordinary action: the focus opens on its own button. */
    await page.getByRole('button', { name: t.people.editLabel(name), exact: true }).click();
    await page.getByLabel(t.common.name, { exact: true }).fill(`${name} Ray`);
    const save = page.getByRole('button', { name: t.common.save, exact: true });
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveAccessibleName(t.confirm.renamePerson.title);
    const rename = dialog.getByRole('button', { name: t.confirm.renamePerson.yes, exact: true });
    await expect(rename).toBeFocused();
    expect(await rename.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('solid');
    await whole(page, dialog, look.dir);
    await shot(page, info, `ordinary-focus-${lookName(look)}`);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual(['DELETE']);
  });
}
