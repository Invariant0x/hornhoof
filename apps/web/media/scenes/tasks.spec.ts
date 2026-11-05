import { expect, test } from '@playwright/test';
import { createSceneRecorder, smoothScrollBody } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { INITIAL_MOONFERN_REQUESTS, MOONFERN_TASKS, MOONFERN_TURNS } from '../moonfern/tasks';

test('tasks.gif: designer choice with three images, commit approval, question and Turn 6 tasks', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const api = await serveMoonfern(page);

  await page.goto('/');
  await page.getByRole('button', { name: /Tasks/ }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await expect(page.locator('.req-option img')).toHaveCount(3);
  await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>('.req-option img')];
    await Promise.all(imgs.map(img => (img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; }))));
  });
  await recorder.markReady();

  /* Hold on the designer's three plant-card options at the top. */
  await page.waitForTimeout(1600);

  /* Scroll smoothly so the commit approval, the question and Turn 6's tasks below are all in view. */
  await smoothScrollBody(page, 372, 10, 44);
  await page.waitForTimeout(1250);

  /* Approve Dana's commit for the watering reminder engine. */
  const approvalCard = page.locator('.req-approval');
  await approvalCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await approvalCard.getByRole('button', { name: 'Approve', exact: true }).click();

  await expect(page.locator('.req-approval')).toHaveCount(0);
  await expect(page.getByText('25 of 40 tasks done')).toBeVisible();
  await page.waitForTimeout(450);

  /* Scroll down so Turn 6 progress and the turn's task rows stand clearly in frame. */
  await smoothScrollBody(page, 790, 10, 44);
  await page.waitForTimeout(1500);

  /* Restore requests, tasks and turn progress and scroll smoothly back to top so loop frames match. */
  await page.mouse.move(8, 8);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  api.setRequests(structuredClone(INITIAL_MOONFERN_REQUESTS));
  api.setTasks(structuredClone(MOONFERN_TASKS));
  api.setTurns(structuredClone(MOONFERN_TURNS));
  await pushStream(page, { type: 'requests' });
  await pushStream(page, { type: 'task', id: 't-218', spot: { departmentId: 'dept-dev' } });
  await smoothScrollBody(page, 0, 12, 42);
  await expect(page.locator('.req-approval')).toHaveCount(1);
  await page.waitForTimeout(650);

  watcher.assertClean();
  await recorder.finishGif('tasks');
});
