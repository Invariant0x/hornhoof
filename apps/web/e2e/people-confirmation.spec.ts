import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PersonView } from '../src/types';
import { ME, serveApi } from './api';

const PERSON: PersonView = {
  ...ME.person, id: 'p2', name: 'Morgan', title: 'Editor', isOwner: false, isCeoDelegate: false,
  access: { whole: false, departments: [], teams: [] },
};

async function people(page: Page) {
  const changes: { method: string; path: string; body?: object }[] = [];
  await serveApi(page);
  await page.route('**/api/people', route => route.fulfill({ json: { people: [PERSON] } }));
  await page.route('**/api/people/p2**', async route => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET') return route.fulfill({ json: { person: PERSON } });
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as object | undefined;
    changes.push({ method, path, body });
    if (method === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ json: { person: { ...PERSON, ...body } } });
  });
  await page.goto('/people');
  return changes;
}

const question = (page: Page) => page.getByRole('alertdialog', { name: 'Are you sure?' });

async function answer(page: Page, choice: 'Yes' | 'No') {
  await question(page).getByRole('button', { name: choice, exact: true }).click();
}

async function asksBeforeWriting(page: Page, trigger: Locator, method: 'PATCH' | 'DELETE') {
  const request = page.waitForRequest(req => new URL(req.url()).pathname === '/api/people/p2' && req.method() === method);
  await trigger.click();
  expect(await Promise.race([page.getByRole('alertdialog').waitFor().then(() => 'question'), request.then(() => 'request')])).toBe('question');
  expect(await question(page).count()).toBe(1);
  await expect(question(page)).toContainText('Morgan');
}

test('confirms permanent removal of a named person', async ({ page }) => {
  const changes = await people(page);
  const remove = page.getByRole('button', { name: 'Delete Morgan' });
  await asksBeforeWriting(page, remove, 'DELETE');
  await expect(question(page)).toHaveAccessibleDescription(/cannot be undone/);
  await answer(page, 'No');
  expect(changes).toEqual([]);
  await remove.click();
  await answer(page, 'Yes');
  await expect.poll(() => changes.map(change => [change.method, change.path])).toEqual([['DELETE', '/api/people/p2']]);
  await expect(page.getByRole('cell', { name: 'Morgan' })).toHaveCount(0);
});

test('confirms disabling a person', async ({ page }) => {
  const changes = await people(page);
  const disable = page.getByRole('button', { name: 'Disable Morgan' });
  await asksBeforeWriting(page, disable, 'PATCH');
  await answer(page, 'No');
  expect(changes).toEqual([]);
  await disable.click();
  await answer(page, 'Yes');
  await expect.poll(() => changes).toEqual([{ method: 'PATCH', path: '/api/people/p2', body: { status: 'disabled' } }]);
});

test('confirms the name and authority changes before saving a person', async ({ page }) => {
  const changes = await people(page);
  await page.getByRole('button', { name: 'Edit Morgan' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Morgan Vale');
  await page.getByRole('switch', { name: 'Deputy CEO' }).check();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await asksBeforeWriting(page, save, 'PATCH');
  await expect(question(page)).toContainText('Morgan Vale');
  await expect(question(page)).toContainText(/deputy/i);
  await answer(page, 'No');
  expect(changes).toEqual([]);
  await save.click();
  await answer(page, 'Yes');
  await expect.poll(() => changes.map(change => [change.method, change.path])).toEqual([
    ['PATCH', '/api/people/p2'],
    ['PUT', '/api/people/p2/ceo-delegate'],
  ]);
  expect(changes[0]?.body).toMatchObject({ name: 'Morgan Vale', access: { whole: true } });
  expect(changes[1]?.body).toEqual({ isCeoDelegate: true });
});
