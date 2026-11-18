import { expect, test } from '@playwright/test';
import type { Org } from '../../src/types';
import { MOONFERN_DEPARTMENTS, MOONFERN_ORG } from '../moonfern/agents';
import { isoMinutes } from '../moonfern/clock';
import { MAYA_VIEW } from '../moonfern/people';
import { createSceneRecorder } from '../moonfern/record';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';

test('build.gif: CEO writes to orchestrator, ticks structure card, clicks Build, departments appear', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);

  /* Start with Operations alone, before the rest of Moonfern's structure is built. */
  const opsOnly = MOONFERN_DEPARTMENTS.filter(d => d.id === 'dept-ops');
  const initialOrg: Org = {
    ...MOONFERN_ORG,
    people: [MAYA_VIEW],
    departments: opsOnly,
    turn: null,
    agents: { total: opsOnly[0]!.agents.total, working: 1 },
    workLines: [],
  };

  const api = await serveMoonfern(page, {
    initialOrg,
    initialRequests: [],
    initialTurns: [],
    initialTasks: [],
    onMessage: async (_agentId, text) => {
      await api.appendOrchestratorEvent(
        {
          seq: 1,
          kind: 'message',
          data: { from: 'person', text },
          jobId: 'job-build',
          person: { id: MAYA_VIEW.id, name: MAYA_VIEW.name },
          at: isoMinutes(0),
        },
        { busy: true, runningJobId: 'job-build' },
      );
      setTimeout(() => {
        void (async () => {
          await api.appendOrchestratorEvent({
            seq: 2,
            kind: 'text',
            data: {
              text: 'Moonfern needs Development for the iOS app and care engine, Design for plant cards and App Store visuals, Marketing for the beta launch, and Business development for nursery partners.',
            },
            jobId: 'job-build',
            person: null,
            at: isoMinutes(0),
          });
          await api.appendOrchestratorEvent(
            {
              seq: 3,
              kind: 'proposal',
              data: {
                proposalId: 'prop-moonfern-1',
                brief: 'Departments for Moonfern',
                items: [
                  { template: 'development', checked: true, note: 'iOS app, species recognizer and watering schedule engine.' },
                  { template: 'design', checked: false, note: 'Plant cards, icons and App Store screenshots.' },
                  { template: 'marketing', checked: true, note: 'Beta landing page, care guides and launch channels.' },
                  { template: 'business_development', checked: false, note: 'Indie plant shops and botanical garden partnerships.' },
                ],
              },
              jobId: 'job-build',
              person: null,
              at: isoMinutes(0),
            },
            { busy: false, runningJobId: null },
          );
        })();
      }, 550);
    },
    onBuild: async () => {
      api.setOrg({ ...MOONFERN_ORG, turn: null });
      await api.appendOrchestratorEvent({
        seq: 4,
        kind: 'applied',
        data: {
          proposalId: 'prop-moonfern-1',
          created: [
            { id: 'dept-dev', template: 'development', name: null, products: [] },
            { id: 'dept-dsn', template: 'design', name: null, products: [] },
            { id: 'dept-mkt', template: 'marketing', name: null, products: [] },
            { id: 'dept-biz', template: 'business_development', name: null, products: [] },
          ],
        },
        jobId: null,
        person: { id: MAYA_VIEW.id, name: MAYA_VIEW.name },
        at: isoMinutes(1),
      });
      await pushStream(page, { type: 'org' });
    },
  });

  await page.goto('/');
  await expect(page.locator('.hub')).toBeVisible();
  await expect(mapDepartment(page, 'Operations')).toBeVisible();
  /* Wait for the initial map centering transition to settle before starting the loop. */
  await page.waitForTimeout(850);
  await recorder.markReady();

  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Open the orchestrator' }).click();
  const input = page.locator('#input-orchestrator');
  await expect(input).toBeVisible();
  await page.waitForTimeout(250);

  await input.click();
  await input.pressSequentially(
    'We are building Moonfern, a plant care app with photo ID and watering reminders.',
    { delay: 11 },
  );
  await page.waitForTimeout(180);
  await input.press('Enter');

  const card = page.locator('.t-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Create departments (2)' })).toBeVisible();
  await page.waitForTimeout(500);

  /* Visibly tick Design and Business development so all four are checked and button reads Create departments (4). */
  await card.locator('input[data-template="design"]').check();
  await page.waitForTimeout(420);
  await card.locator('input[data-template="business_development"]').check();
  const buildBtn = card.getByRole('button', { name: 'Create departments (4)' });
  await expect(buildBtn).toBeVisible();
  await page.waitForTimeout(450);

  await buildBtn.click();
  const window = page.getByRole('complementary', { name: 'Orchestrator', exact: true });
  const created = ['Development', 'Design', 'Marketing', 'Business development'];
  for (const name of created) await expect(window.getByText(`Created: ${name}`, { exact: true })).toBeVisible();
  await page.waitForTimeout(1050);

  /* Close the orchestrator window so all five departments stand clearly around the hub. */
  await window.getByRole('button', { name: 'Close', exact: true }).click();
  for (const name of created) await expect(mapDepartment(page, name)).toBeVisible();
  await page.waitForTimeout(1550);

  /* Reset back to the initial centered Operations map so the first and last frames match cleanly. */
  api.setOrg(initialOrg);
  api.setOrchestratorEvents([], { busy: false, runningJobId: null });
  await pushStream(page, { type: 'org' });
  await expect(mapDepartment(page, 'Development')).toHaveCount(0);
  await page.waitForTimeout(950);

  watcher.assertClean();
  await recorder.finishGif('build');
});
