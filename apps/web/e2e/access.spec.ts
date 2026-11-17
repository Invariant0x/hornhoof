import { expect, test, type Page } from '@playwright/test';
import { ME, TASKS } from './api';
import { fullDepartment, type Tree } from './full-department';
import { serveTree } from './tree-api';
import type { Me, PersonView } from '../src/types';

const REGULAR: Me = { ...ME, person: { ...ME.person, id: 'p3', name: 'Sasha', email: 'sasha@acme.com', title: 'Product lead', scopeKind: 'listed', isOwner: false } };
const DEPUTY: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', scopeKind: 'company', isOwner: false, isCeoDelegate: true }, canDecideCompany: true };
const DENIED = { status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', message: 'Hidden resource details.' } }) };
const OWN_TASK = TASKS[0]!;

function person(me: Me, departments: string[]): PersonView {
  return {
    id: me.person.id, name: me.person.name, email: me.person.email, title: me.person.title, status: me.person.status, isOwner: me.person.isOwner,
    isCeoDelegate: me.person.isCeoDelegate,
    access: { whole: me.person.scopeKind === 'company', departments: departments.map(id => ({ id, name: 'Development' })), teams: [] },
  };
}

/* What a person of part of the company reads: every employee, and Bruno opening when he is theirs. */
function restricted(full: Tree, me: Me, departmentAccess: boolean, opensBruno: boolean): Tree {
  const department = full.org.departments[0]!;
  return {
    ...full,
    org: {
      ...full.org,
      departments: [{ ...department, employees: department.employees.map(employee => ({ ...employee, opens: employee.id === 'a1' && opensBruno })), people: departmentAccess ? [person(me, ['d2'])] : [] }],
    },
  };
}

async function serveAccess(page: Page, me: Me, shown: Tree, options: { agentStatus?: 200 | 403; taskStatus?: 200 | 403 } = {}) {
  await serveTree(page, { during: true });
  await page.route('**/api/me', route => route.fulfill({ json: me }));
  await page.route('**/api/org', route => route.fulfill({ json: shown.org }));
  await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: shown.tree } }));
  await page.route('**/api/tasks?status=all', route => route.fulfill({ json: { tasks: [OWN_TASK] } }));
  if (options.agentStatus === 403) {
    await page.route('**/api/agents/a1', route => route.fulfill(DENIED));
    await page.route('**/api/agents/a1/events?last=300', route => route.fulfill(DENIED));
  }
  if (options.taskStatus === 403) await page.route('**/api/tasks/secret', route => route.fulfill(DENIED));
}

async function openOwnChip(page: Page) {
  await page.goto('/departments/d2');
  const chip = page.locator('.dcanvas .dept-chip').filter({ has: page.locator('.mn', { hasText: /^Bruno$/ }) });
  await expect(chip).toBeVisible();
  await chip.locator('.schip').click();
}

const roles = [
  { name: 'own plan in an accessible department', me: REGULAR, departmentAccess: true, status: 200, allowed: true },
  { name: 'another plan in an accessible department', me: REGULAR, departmentAccess: true, status: 403, allowed: false },
  { name: 'own plan in an inaccessible department', me: REGULAR, departmentAccess: false, status: 403, allowed: false },
  { name: 'department owner follows the same rule', me: REGULAR, departmentAccess: true, status: 403, allowed: false },
  { name: 'deputy CEO sees the agent', me: DEPUTY, departmentAccess: true, status: 200, allowed: true },
  { name: 'CEO sees the agent', me: ME, departmentAccess: true, status: 200, allowed: true },
] as const;

for (const role of roles) {
  test(`${role.name}: agent window follows both access conditions`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
    const full = fullDepartment(), shown = role.me.person.scopeKind === 'company' ? full : restricted(full, role.me, role.departmentAccess, role.allowed);
    await serveAccess(page, role.me, shown, { agentStatus: role.status });
    /* Every department opens for everyone; an employee who is not theirs says so and opens no window, with no refusal. */
    await openOwnChip(page);
    if (role.allowed) {
      await expect(page.getByRole('complementary', { name: /Bruno/ })).toBeVisible();
    } else {
      await expect(page.getByText('Bruno: everyone sees the work, and only the people of this department open the window.').first()).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Insufficient permissions' })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('Hidden resource details.');
      await expect(page.getByRole('complementary')).toHaveCount(0);
    }
  });
}

test('a person of part of the company sees every employee and the whole work in schema, tree and task lists', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  const full = fullDepartment(), shown = restricted(full, REGULAR, true, true);
  await serveAccess(page, REGULAR, shown);
  await page.goto('/departments/d2');
  await expect(page.locator('.dcanvas .dept-chip')).toHaveCount(12);
  await expect(page.locator('.dcanvas')).toContainText('Timur');
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  await expect(page.locator('.tv-labs .dept-chip')).toHaveCount(12);
  await expect(page.locator('.tv-in')).toContainText('Timur');
  await expect(page.locator('.tv-in')).toContainText('Checkout step 63');
  /* The tracker (#1152) lists a department's work when the person picks the department among its lists. */
  await page.getByRole('navigation').getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: /^Development/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Development' })).toBeVisible();
  await expect(page.locator('.tr-main').getByRole('listitem', { name: `#${OWN_TASK.number} ${OWN_TASK.title}`, exact: true })).toBeVisible();
  await expect(page.locator('.tr-main')).not.toContainText('Hidden task of another agent');
});

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 1440]) {
      test(`direct closed URLs show no payload: ${lang}, ${theme}, ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const full = fullDepartment(), shown = restricted(full, REGULAR, true, true);
        await serveAccess(page, REGULAR, shown, { taskStatus: 403 });
        const heading = lang === 'en' ? 'Insufficient permissions' : 'Недостаточно прав';
        await page.goto('/tasks/secret');
        await expect(page.getByRole('heading', { name: heading })).toBeVisible();
        await expect(page.locator('body')).not.toContainText('Hidden resource details.');
        await page.screenshot({ path: info.outputPath(`direct-task-${lang}-${theme}-${width}.png`) });
        await page.goto('/departments/d3');
        await expect(page.getByRole('heading', { name: heading })).toBeVisible();
        await expect(page.locator('body')).not.toContainText('Development');
      });
    }
  }
}
