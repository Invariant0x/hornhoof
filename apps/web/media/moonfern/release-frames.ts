import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
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

const viewWords: Record<View, (t: Messages) => string[]> = {
  map: t => [...shellWords(t), ...departments(t), t.map.orchestrator, t.map.agentsWorking, t.map.teams(1), t.map.wholeCompany],
  starter: t => [...shellWords(t), t.templates.development.name, t.dept.tasksButton, t.dept.about, t.dept.hire, t.dept.reportLine, t.dept.gate(1),
    t.dept.agents(1), ...Object.values(t.tasks.echelons.stages)],
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

  /* The department opens on its staff schema, with the one-shot stages of its default route as frames of idle diamonds. */
  await mapDepartment(page, t.templates.development.name).click();
  const schema = page.getByRole('region', { name: t.dept.schema, exact: true });
  const stage = schema.locator('.frame-calls').first();
  await expect(stage.locator('[data-worker-kind="ghost"]').first()).toBeVisible();
  await expect(stage.locator('[data-worker-kind="ghost"]:not(.idle)')).toHaveCount(0);
  await save('starter-department');
  await centreIn(page, schema, stage);
  await expect(stage).toBeInViewport({ ratio: 1 });
  await save('starter-stage');
}

/* Pan the schema by presses on its empty background until a part of it stands in the middle of the screen. Each pull stays
   inside the schema, so a far part takes a few of them. WebKit selects the page's words under a pull, and a press on a
   selection drags the selection instead of the schema, so none is left before a pull or in the picture. */
async function centreIn(page: Page, schema: Locator, part: Locator) {
  const unselect = () => page.evaluate(() => getSelection()?.removeAllRanges());
  for (let pull = 0; pull < 12; pull++) {
    await unselect();
    const [area, box] = await Promise.all([schema.boundingBox(), part.boundingBox()]);
    if (!area || !box) throw new Error('the schema or its part has no box');
    const clamp = (d: number, room: number) => Math.max(-room, Math.min(room, Math.round(d)));
    const by = {
      x: clamp(area.x + area.width / 2 - (box.x + box.width / 2), area.width * 0.6),
      y: clamp(area.y + area.height / 2 - (box.y + box.height / 2), area.height * 0.6),
    };
    if (Math.abs(by.x) < 4 && Math.abs(by.y) < 4) break;
    const start = await page.evaluate(({ area: { x, y, width, height }, by }) => {
      const bare = (px: number, py: number) => ['dcanvas', 'world'].some(name => document.elementFromPoint(px, py)?.classList.contains(name));
      const [left, right] = [x + 8 + Math.max(0, -by.x), x + width - 8 - Math.max(0, by.x)];
      const [top, bottom] = [y + 8 + Math.max(0, -by.y), y + height - 8 - Math.max(0, by.y)];
      for (let py = bottom; py >= top; py -= 12) {
        for (let px = left; px <= right; px += 12) if (bare(px, py)) return { x: px, y: py };
      }
      return null;
    }, { area, by });
    if (!start) throw new Error('the schema shows no bare background to pull it by');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + by.x, start.y + by.y, { steps: 4 });
    await page.mouse.up();
  }
  await unselect();
}

async function agentFrames(page: Page, t: Messages, save: Save) {
  await mapDepartment(page, t.templates.development.name).click();
  const schema = page.getByRole('region', { name: t.dept.schema, exact: true });
  await schema.getByRole('button').filter({ has: page.getByText('Iris', { exact: true }) }).click();
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
