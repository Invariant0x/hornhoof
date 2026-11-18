import { expect, test } from '@playwright/test';
import { createSceneRecorder } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';
import { reportUnmocked, trackerFrames } from '../moonfern/tracker-scene';

/* Development's board by state, then by the stages of its pipeline "Beta build way": each task stands in the stage of
   whoever holds it, from Build through Review and Security to the TestFlight smoke test. */
test('board.gif: a department board by state, then by the stages of its pipeline', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  await serveMoonfern(page);

  await page.goto('/tasks?department=dept-dev&view=board');
  const board = page.getByRole('region', { name: 'Board', exact: true });
  await expect(board).toBeVisible();
  await expect(board.locator('.tr-col').first()).toBeVisible();
  await recorder.markReady();
  await page.waitForTimeout(2000);

  /* The pipeline sits under its department in the lists on the left. */
  const side = page.getByRole('navigation', { name: 'Task lists' });
  const pipeline = side.getByRole('button', { name: /^Beta build way/ });
  if (!(await pipeline.isVisible())) await side.getByRole('button', { name: 'Show what is in Development' }).click();
  await page.waitForTimeout(500);
  await pipeline.click();
  await expect(board.getByRole('region', { name: /TestFlight smoke test/ })).toBeVisible();
  await page.waitForTimeout(3600);

  /* Back to the whole department, as the loop began. */
  await side.getByRole('button', { name: /^Development/ }).first().click();
  await expect(board.getByRole('region', { name: /TestFlight smoke test/ })).toHaveCount(0);
  await page.mouse.move(8, 8);
  await page.waitForTimeout(1200);

  reportUnmocked(watcher.errors);
  await recorder.finishGif('board');
});

test('tracker screenshots: board at desktop and phone widths', async ({ browser }, info) => {
  await trackerFrames(browser, info, 'board');
});
