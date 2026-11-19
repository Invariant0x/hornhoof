import { expect, test } from '@playwright/test';
import { createSceneRecorder } from '../moonfern/record';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';
import { routeTerminalReplay } from '../moonfern/terminal';

test('terminal.gif: developer window replaying terminal.rec with side panels visible', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);

  let releaseReplay!: () => void;
  const startGate = new Promise<void>(resolve => {
    releaseReplay = resolve;
  });

  const replay = await routeTerminalReplay(page, { startAfter: startGate });
  await serveMoonfern(page, { terminalAgentIds: ['dev-1'] });

  await page.goto('/');
  await mapDepartment(page, 'Development').click();
  const schema = page.getByRole('region', { name: 'Department schema', exact: true });
  await expect(schema).toBeVisible();
  await page.waitForTimeout(850);

  /* Open Card: Iris first so the left 400px panel sits clear of .xterm while terminal.rec streams. */
  await schema.getByRole('button').filter({ has: page.getByText('Iris', { exact: true }) }).click();
  const win = page.getByRole('complementary', { name: /^Iris/ });
  await expect(win).toBeVisible();
  await expect(win.locator('.xterm')).toBeVisible();

  await win.getByRole('button', { name: 'Card', exact: true }).click();
  await expect(win.getByRole('complementary', { name: 'Card: Iris', exact: true })).toBeVisible();

  await recorder.markReady();
  releaseReplay();

  /* Let the live terminal stream unobstructed alongside Card: Iris, then slide out Task (#221) too. */
  await page.waitForTimeout(5400);
  const taskToggle = win.getByRole('button', { name: 'Task', exact: true });
  await taskToggle.click();
  await page.waitForTimeout(2300);

  /* Close Task (#221) and reset terminal screen to initial prompt so first and last frames match. */
  await taskToggle.click();
  replay.resetToPrompt();
  await page.waitForTimeout(700);

  watcher.assertClean();
  await recorder.finishGif('terminal');
});
