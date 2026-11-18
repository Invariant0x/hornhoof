import { expect, test } from '@playwright/test';
import { en } from '../../src/i18n/en';
import { createSceneRecorder } from '../moonfern/record';
import { MOONFERN_PIPELINE } from '../moonfern/pipelines';
import { expectBetaBoard } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';
import { pickView, reportUnmocked, trackerFrames } from '../moonfern/tracker-scene';

/* Development's board by state, then by the stages of its pipeline "Beta build way": each task stands in the stage of
   whoever holds it, from Build through Review and Security to the TestFlight smoke test. */
test('board.gif: a department board by state, then by the stages of its pipeline', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  await serveMoonfern(page);

  await page.goto('/tasks?department=dept-dev&view=board');
  const board = page.getByRole('region', { name: 'Board', exact: true });
  await expect(board.getByRole('region', { name: en.tracker.statuses.working, exact: true })).toBeVisible();
  await recorder.markReady();
  await page.waitForTimeout(2000);

  /* The pipeline sits under its department in the lists on the left. */
  const side = page.getByRole('navigation', { name: 'Task lists' });
  const pipeline = side.getByRole('button', { name: en.tracker.side.defaultPipeline(MOONFERN_PIPELINE.name), exact: true });
  await expect(pipeline).toBeVisible();
  await page.waitForTimeout(500);
  await pipeline.click();
  const smoke = await expectBetaBoard(board, en);
  await page.waitForTimeout(3600);

  /* Back to the whole department, as the loop began. */
  await side.getByRole('button', { name: 'Development', exact: true }).click();
  await pickView(page, 'Board');
  await expect(smoke).toHaveCount(0);
  await expect(board.getByRole('region', { name: en.tracker.statuses.working, exact: true })).toBeVisible();
  await page.mouse.move(8, 8);
  await page.waitForTimeout(1200);

  reportUnmocked(watcher.errors);
  await recorder.finishGif('board');
});

test('tracker screenshots: board at desktop and phone widths', async ({ browser }, info) => {
  await trackerFrames(browser, info, 'board');
});
