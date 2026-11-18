import { expect, test } from '@playwright/test';
import { en } from '../../src/i18n/en';
import { createSceneRecorder } from '../moonfern/record';
import { releaseFrames } from '../moonfern/release-frames';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';
import { expectTaskCard, pickView, reportUnmocked, trackerFrames } from '../moonfern/tracker-scene';

/* The tracker as Maya meets Development's work: the list grouped by what each task needs now, with who does it, who answers
   for it, its goal and its date; a task's brief, related tasks and recent steps; then the same work as a board. */
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

  const title = 'Plant identification camera flow';
  await list.getByRole('listitem', { name: `#221 ${title}`, exact: true }).getByRole('button', { name: title, exact: true }).click();
  const card = await expectTaskCard(page, en, title);
  await page.waitForTimeout(3000);
  await card.getByRole('button', { name: en.window.close, exact: true }).click();
  await expect(card).toHaveCount(0);
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

test('tracker screenshots: tasks at desktop and phone widths', async ({ browser }, info) => {
  await trackerFrames(browser, info, 'tasks');
});

for (const view of ['map', 'starter', 'agent'] as const) {
  test(`tracker screenshots: ${view} at desktop and phone widths`, async ({ browser }, info) => {
    await releaseFrames(browser, info, view);
  });
}
