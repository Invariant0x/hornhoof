import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { Messages } from '../../src/i18n';
import { MOONFERN_ORG } from './agents';
import { FRAME_SIZES, FRAME_THEMES, frameLanguages } from './frame-languages';
import { mapDepartment } from './scene-locators';
import { serveMoonfern } from './serve';
import { prepareScenePage } from './stream';

type Save = (name: string) => Promise<Buffer>;
type View = 'map' | 'starter' | 'agent';
const shellWords = (t: Messages) => [t.shell.tabs.map, t.shell.tabs.tasks, t.shell.tabs.people, t.shell.tabs.subscriptions, t.shell.tabs.machines];
const departments = (t: Messages) => MOONFERN_ORG.departments.map(dept => t.templates[dept.templateKey!].name);
const starterRoutes = ['development-changes', 'development-docs', 'development-release'] as const;

const viewWords: Record<View, (t: Messages) => string[]> = {
  map: t => [...shellWords(t), ...departments(t), t.map.orchestrator, t.map.agentsWorking, t.map.teams(1), t.map.wholeCompany],
  starter: t => [...shellWords(t), t.templates.development.name, t.dept.products, t.tracker.side.pipelines, t.dept.members, t.dept.noModelYet,
    t.dept.status.off, t.dept.tasksButton, t.dept.about, t.dept.hire, t.workers.slot(1), t.workers.slot(2), t.workers.slot(3), t.workers.judge, t.workers.idle,
    ...starterRoutes.flatMap(key => {
      const pipeline = t.pipelineCatalog[key];
      return [pipeline.name, ...Object.values(pipeline.stages)];
    })],
  agent: t => [...shellWords(t), t.window.card, t.window.stop, t.window.showTerminal, t.window.chat.earlier, t.window.chat.steps(2), t.window.chat.send],
};

async function mapFrames(page: Page, t: Messages, save: Save) {
  const development = mapDepartment(page, t.templates.development.name);
  const staff = MOONFERN_ORG.departments.find(dept => dept.id === 'dept-dev')!.employees;
  await expect(development.locator('.cells > .cell')).toHaveCount(staff.length);
  await expect(page.locator('.map [data-worker-kind], .map .cells.calls')).toHaveCount(0);
  await page.getByRole('button', { name: t.map.showAll, exact: true }).click();
  await expect(development).toBeInViewport();
  await save('map');
}

async function starterFrames(page: Page, t: Messages, save: Save) {
  await page.getByLabel(t.setup.companyName, { exact: true }).fill('Moonfern');
  const kits = page.getByRole('group', { name: t.companyTemplates.heading });
  await kits.getByText(t.companyTemplates.startup.name, { exact: true }).click();
  await page.getByRole('button', { name: t.common.next, exact: true }).click();
  await page.getByLabel(t.setup.yourName, { exact: true }).fill('Maya Chen');
  await page.getByLabel(t.common.email, { exact: true }).fill('maya@example.com');
  await page.getByLabel(t.common.password, { exact: true }).fill('moonfern-demo-password');
  await page.getByRole('button', { name: t.common.next, exact: true }).click();
  await page.getByText(t.setup.modes.later.label, { exact: true }).click();
  const submitted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/setup' && request.method() === 'POST');
  await page.getByRole('button', { name: t.setup.finish, exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({ template: 'startup', orchestrator: { mode: 'later' } });
  await page.getByRole('dialog', { name: t.firstContact.title }).getByRole('button', { name: t.firstContact.close }).click();

  await mapDepartment(page, t.templates.development.name).click();
  const structure = page.getByRole('region', { name: t.dept.structure, exact: true });
  await expect(structure.getByText('Product 1', { exact: true })).toBeVisible();
  const guides = structure.getByRole('region', { name: t.pipelineCatalog['development-docs'].name, exact: true });
  const stage = guides.locator('.dv-stage').filter({ has: page.getByRole('heading', { name: t.pipelineCatalog['development-docs'].stages['Check examples'], exact: true }) });
  await expect(stage.getByRole('img', { name: t.workers.permanent, exact: true })).toBeVisible();
  await expect(stage.locator('[data-worker-kind="ghost"].idle')).toHaveCount(4);
  await expect(stage.getByText(t.dept.noModelYet, { exact: true })).toBeVisible();
  expect(await structure.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await save('starter-department');
  await stage.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await save('starter-stage');
}

async function agentFrames(page: Page, t: Messages, save: Save) {
  await mapDepartment(page, t.templates.development.name).click();
  await page.getByRole('region', { name: t.dept.structure }).getByRole('button', { name: 'Iris', exact: true }).click();
  const agent = page.getByRole('complementary', { name: /^Iris/ });
  await expect(agent.getByRole('log', { name: t.window.chat.conversation })).toContainText('Working on #221');
  await expect(agent.getByRole('button', { name: t.window.computerClose })).toHaveCount(0);
  await expect(agent.getByText(t.window.machineAccess('maya-macbook-pro'), { exact: false })).toHaveCount(0);
  await save('agent-window');
}

export async function releaseFrames(browser: Browser, info: TestInfo, view: View) {
  const draw = { map: mapFrames, starter: starterFrames, agent: agentFrames }[view];
  for (const { id, t } of await frameLanguages(viewWords[view])) {
    for (const theme of FRAME_THEMES) {
      for (const size of FRAME_SIZES) {
        const context = await browser.newContext({
          baseURL: info.project.use.baseURL, viewport: size, timezoneId: 'UTC', reducedMotion: 'reduce',
        });
        try {
          const page = await context.newPage();
          const watcher = await prepareScenePage(page, undefined, id, theme);
          await serveMoonfern(page, { setupNeeded: view === 'starter' });
          await page.goto(view === 'starter' ? '/?code=mf9k2x7p' : '/');
          await expect(page.locator('html')).toHaveAttribute('lang', id);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await draw(page, t, async name => {
            await page.evaluate(() => document.fonts.ready);
            return page.screenshot({ path: info.outputPath(`${name}-${id}-${theme}-${size.width}.png`) });
          });
          watcher.assertClean();
        } finally {
          await context.close();
        }
      }
    }
  }
}
