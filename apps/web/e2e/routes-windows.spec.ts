import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { openCompany } from './agent-windows-api';
import { SETTINGS } from './computer-strip-api';
import { serveRoutes } from './routes-api';
import { TASKS } from './api';

/* History keeps agent windows and task panels with their drafts, in each language, theme and width. */
test.use({ reducedMotion: 'reduce' });

for (const settings of SETTINGS) {
  const { lang, theme, width } = settings;
  const t = lang === 'en' ? en : ru;
  test(`history keeps agent windows ${lang} ${theme} ${width}`, async ({ page }) => {
    const company = await openCompany(page, settings);
    await company.openOrchestrator();
    const window = company.windowOf(company.words.orchestrator);
    await company.barButton(company.words.orchestrator, company.words.log).click();
    const draft = window.getByRole('textbox');
    await draft.fill('Keep this draft across history');
    await company.minimize(company.words.orchestrator);
    await company.tab(company.words.tabs[2]!).click();
    await expect(page).toHaveURL(/\/people$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(company.stripOf(company.words.orchestrator)).toBeVisible();
    await company.stripOf(company.words.orchestrator).click();
    await expect(draft).toHaveValue('Keep this draft across history');
    await page.goForward();
    await expect(page).toHaveURL(/\/people$/);
    await expect(window).toBeVisible();
    await expect(draft).toHaveValue('Keep this draft across history');
    expect(company.errors).toEqual([]);
  });

  test(`task panels keep their section ${lang} ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ lang, theme }) => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', theme); }, settings);
    await serveRoutes(page);
    await page.route('**/api/tasks?status=open&department=d2', route => route.fulfill({ json: { tasks: TASKS } }));
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    await page.goto('/improvements');
    const improvement = page.getByRole('article', { name: 'Check card numbers before sending them' });
    await improvement.getByRole('button', { name: '#3 Checkout step 3' }).click();
    const task = page.getByRole('complementary', { name: '#3 Checkout step 3', exact: true });
    await expect(page).toHaveURL(/\/tasks\/t3$/);
    await expect(task).toBeVisible();
    await expect(improvement).toBeVisible();
    const comment = task.getByRole('textbox', { name: t.tasks.comment, exact: true });
    await comment.fill('Keep this task draft');
    await page.getByRole('button', { name: t.shell.account, exact: true }).click();
    await page.getByRole('button', { name: t.about.menu, exact: true }).click();
    await expect(page.getByRole('dialog', { name: t.about.title, exact: true })).toBeVisible();
    await expect(task).toBeVisible();
    await expect(improvement).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(comment).toHaveValue('Keep this task draft');
    await page.screenshot({ path: info.outputPath(`task-improvement-${lang}-${theme}-${width}.png`), animations: 'disabled' });
    await task.getByRole('button', { name: t.window.close, exact: true }).click();
    await expect(page).toHaveURL(/\/improvements$/);
    await page.goBack();
    await expect(task).toBeVisible();
    await expect(improvement).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/improvements$/);

    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.map, exact: true }).click();
    await page.getByRole('button', { name: /^Development/ }).click();
    await page.getByRole('button', { name: t.dept.tasksButton, exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\?department=d2$/);
    /* The tracker's heading names the department and the view it shows. */
    const department = page.getByRole('heading', { level: 1, name: `Development / ${t.tracker.views.list}`, exact: true });
    await page.locator('.tr-main').getByRole('listitem', { name: '#1 Checkout step 1', exact: true }).locator('.tr-title').click();
    const departmentTask = page.getByRole('complementary', { name: '#1 Checkout step 1', exact: true });
    await expect(page).toHaveURL(/\/tasks\/t1$/);
    await expect(departmentTask).toBeVisible();
    await expect(department).toBeVisible();
    const departmentComment = departmentTask.getByRole('textbox', { name: t.tasks.comment, exact: true });
    await departmentComment.fill('Keep this department task draft');
    await page.getByRole('button', { name: t.shell.account, exact: true }).click();
    await page.getByRole('button', { name: t.about.menu, exact: true }).click();
    await expect(page.getByRole('dialog', { name: t.about.title, exact: true })).toBeVisible();
    await expect(departmentTask).toBeVisible();
    await expect(department).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(departmentComment).toHaveValue('Keep this department task draft');
    await page.screenshot({ path: info.outputPath(`task-department-${lang}-${theme}-${width}.png`), animations: 'disabled' });
    await departmentTask.getByRole('button', { name: t.window.close, exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\?department=d2$/);
    await expect(department).toBeVisible();
    expect(errors).toEqual([]);
  });
}
