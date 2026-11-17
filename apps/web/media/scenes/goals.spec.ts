import { expect, test } from '@playwright/test';
import { createSceneRecorder, smoothDrag } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';
import { reportUnmocked } from '../moonfern/tracker-scene';

/* Every goal of the company as a graph: 500 testers at the top, what Development, Design and Marketing answer for under it,
   and their tasks; then the company goal's card with its number to reach. */
test('goals.gif: the company goals as a graph, and a goal card with its progress', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  await serveMoonfern(page);

  await page.goto('/tasks?show=company&view=graph');
  const canvas = page.getByRole('region', { name: 'Goals and tasks drawn as a tree' });
  await expect(canvas).toBeVisible();
  const root = canvas.locator('.tr-node.goal').filter({ hasText: '500 TestFlight testers by December' });
  await expect(root).toBeVisible();
  /* The graph fills the screen: the switch of views at the top, the tree under it. */
  await page.locator('.tr-views').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(500);
  await recorder.markReady();
  await page.waitForTimeout(1100);

  /* Closer to the company goal and the goals under it, as the wheel zooms at the pointer. */
  const box = await root.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -55);
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(1300);

  /* Along the tree to the tasks under the goals, and back. */
  await smoothDrag(page, canvas, -360, -40, 14, 45);
  await page.waitForTimeout(1300);
  await smoothDrag(page, canvas, 360, 40, 14, 45);
  await page.waitForTimeout(500);

  /* The company goal: why, who answers for it, 312 of 500 testers and the goals under it. */
  await root.click();
  await expect(page.getByText('312 of 500 testers').first()).toBeVisible();
  await page.waitForTimeout(2600);
  await page.keyboard.press('Escape');
  await page.mouse.move(8, 8);
  await page.waitForTimeout(900);

  reportUnmocked(watcher.errors);
  await recorder.finishGif('goals');
});
