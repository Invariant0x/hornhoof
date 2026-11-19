import { expect, test } from '@playwright/test';
import { createSceneRecorder, smoothDrag } from '../moonfern/record';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { buildDevelopmentTreeSnapshots } from '../moonfern/tree';

test('tree.gif: readable Development work tree filling width, idle pickup, merges, verdicts and card', async ({ page }) => {
  const snapshots = buildDevelopmentTreeSnapshots();
  const first = snapshots[0]!;

  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page, first.now);
  const api = await serveMoonfern(page, { initialOrg: first.org, initialTree: first.tree });

  await page.goto('/');
  await mapDepartment(page, 'Development').click();
  await expect(page.getByRole('region', { name: 'Department schema', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  const scroll = page.getByRole('region', { name: 'Work tree', exact: true });
  await expect(scroll).toBeVisible();
  await page.waitForTimeout(250);

  /* Zoom out once from 100% to 83% via ZoomBar and nudge top-left so the tree fills ~90% of the canvas width
     with crisp agent names, #task numbers, wait badges and merge trunks. */
  const dragAnchor = { xRatio: 0.985, yRatio: 0.45 };
  await page.locator('.dview').getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(page.locator('.dview .zv')).toHaveText('83%');
  await smoothDrag(page, scroll, -90, -56, 4, 25, dragAnchor);
  await page.mouse.move(8, 8);
  await page.waitForTimeout(150);

  await recorder.markReady();

  async function advanceTo(index: number, taskId: string) {
    const snap = snapshots[index]!;
    await page.clock.setSystemTime(new Date(snap.now));
    api.setOrg(snap.org);
    api.setTree(snap.tree);
    await pushStream(page, { type: 'task', id: taskId, spot: { departmentId: 'dept-dev' } });
    await pushStream(page, { type: 'org' });
  }

  /* Snapshot 0 (14:20): Tessa is idle, Owen waits for #221, Priya asks a question, Iris and Liam work. */
  await page.waitForTimeout(1000);

  /* Snapshot 1 (14:24): idle Tessa picks up #235, Liam merges #226 up into turn-6 and cuts #241. */
  await advanceTo(1, 't-226');
  await page.waitForTimeout(1000);

  /* Snapshot 2 (14:28): Iris merges #221 up into turn-6, Owen unblocks #227, turn review #242 opens. */
  await advanceTo(2, 't-221');
  await page.waitForTimeout(800);

  /* Pan gently down so the four reviewers come into view, then post clean verdicts on review #242. */
  await smoothDrag(page, scroll, 0, -260, 6, 32, dragAnchor);
  await page.mouse.move(8, 8);
  await advanceTo(3, 'r-242');
  await page.waitForTimeout(950);

  /* Pan smoothly back to the top lanes, open Iris's window and slide out Card: Iris. */
  await smoothDrag(page, scroll, 0, 260, 6, 32, dragAnchor);
  await page.mouse.move(8, 8);
  await page.locator('.tv-labs').getByRole('button', { name: /Iris/ }).click();
  /* The name opens the window. It carries the mark of Iris's program, so the button's name starts with Iris and goes on. */
  await page.getByRole('dialog', { name: /^Iris/ }).getByRole('button', { name: /^Iris/ }).click();
  const agentWin = page.getByRole('complementary', { name: /^Iris/ });
  await expect(agentWin).toBeVisible();
  await agentWin.getByRole('button', { name: 'Card', exact: true }).click();
  await expect(agentWin.getByRole('complementary', { name: 'Card: Iris', exact: true })).toBeVisible();
  await page.waitForTimeout(1050);

  /* Close Iris's window and restore Snapshot 0 so the first and last frames match cleanly. */
  await agentWin.getByRole('button', { name: 'Close', exact: true }).and(agentWin.locator('.window-close')).click();
  await expect(agentWin).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | SVGElement | null)?.blur?.());
  await page.mouse.move(8, 8);
  await advanceTo(0, 't-201');
  await page.waitForTimeout(450);

  watcher.assertClean();
  await recorder.finishGif('tree');
});
