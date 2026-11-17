import { expect, test } from '@playwright/test';
import { createSceneRecorder } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';
import { pickView, reportUnmocked } from '../moonfern/tracker-scene';

/* The tracker as Maya meets Development's work: the list grouped by what each task needs now, with who does it, who answers
   for it, its goal and its date; a task's card with its why, its time and its parts; then the same work as a board. */
test('tasks.gif: the tracker shows a department as a list, a card and a board', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  await serveMoonfern(page);

  await page.goto('/tasks?department=dept-dev');
  const list = page.getByRole('region', { name: 'List', exact: true });
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem').first()).toBeVisible();
  await recorder.markReady();
  await page.waitForTimeout(1700);

  /* The camera flow: why it exists, who answers for it, when it is due, how long it is in work and its three parts. */
  await list.getByRole('listitem', { name: '#221 Plant identification camera flow', exact: true }).locator('.tr-title').first().click();
  await expect(page.getByText('Naming a plant from a photo is why people install Moonfern.').first()).toBeVisible();
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  /* The same work as a board: a column for each state, cards moved by the work itself. */
  await pickView(page, 'Board');
  await page.waitForTimeout(2600);

  /* Back to the list, as the loop began. */
  await pickView(page, 'List');
  await page.mouse.move(8, 8);
  await page.waitForTimeout(900);

  reportUnmocked(watcher.errors);
  await recorder.finishGif('tasks');
});
