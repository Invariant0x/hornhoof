import { expect, type Page } from '@playwright/test';
import { fullDepartment, type Tree } from './full-department';
import { serveTree } from './tree-api';
import { taskRoute } from '../test/task-route';

export async function instrumentChipRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __chipRenders: string[] }).__chipRenders = [];
  });
  await page.route('**/src/ui/Chip.tsx*', async route => {
    const response = await route.fetch();
    const needle = '\tconst t = useT();\n\treturn';
    const source = await response.text();
    if (!source.includes(needle)) throw new Error('The Chip render instrumentation did not find its insertion point');
    const body = source.replace(needle, '\tconst t = useT();\n\t(globalThis.__chipRenders ??= []).push(e.name);\n\treturn');
    await route.fulfill({ response, body });
  });
}

export async function resetChipRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __chipRenders: string[] }).__chipRenders.length = 0;
  });
}

export async function chipRenderNames(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __chipRenders: string[] }).__chipRenders]);
}

export async function chipRenders(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __chipRenders: string[] }).__chipRenders.length);
}

export async function serveFullDepartment(page: Page): Promise<{ full: Tree; renameBrunoTask: (title: string) => void }> {
  const full = fullDepartment();
  let shown: Tree = full;
  await serveTree(page, { during: true });
  await page.route('**/api/org', route => route.fulfill({ json: shown.org }));
  await page.route('**/api/departments/d2/tree', route => route.fulfill({ json: { tree: shown.tree } }));
  return {
    full,
    renameBrunoTask(title: string) {
      const departments = full.org.departments.map((department, index) => index ? department : {
        ...department,
        /* Bruno has no current task: he gets his own task #62, whole as the server sends it, with the route the chip reads. */
        employees: department.employees.map(employee => employee.name === 'Bruno'
          ? { ...employee, task: { id: 't62', number: 62, title, echelons: taskRoute('development', employee.id) } }
          : employee),
      });
      shown = { ...full, org: { ...full.org, departments } };
    },
  };
}

export async function openDepartment(page: Page, tree = true): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
  if (tree) {
    await page.getByRole('button', { name: 'Tree', exact: true }).click();
    await expect(page.locator('.tv-labs .dept-chip')).toHaveCount(12);
  } else {
    await expect(page.locator('.dcanvas .dept-chip')).toHaveCount(12);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
