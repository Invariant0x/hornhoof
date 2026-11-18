import { expect, test } from '@playwright/test';
import { createSceneRecorder } from '../moonfern/record';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { buildDevelopmentTreeSnapshots } from '../moonfern/tree';

test('speed.gif: Speed side panel beside Development schema, switching from Speed tab to Idle tab and back', async ({ page }) => {
  const snapshots = buildDevelopmentTreeSnapshots();
  const first = snapshots[0]!;

  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page, first.now);
  const api = await serveMoonfern(page, { initialOrg: first.org, initialTree: first.tree });

  await page.goto('/');
  await mapDepartment(page, 'Development').click();
  await page.getByRole('button', { name: 'Staff map', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Department schema' })).toBeVisible();
  await page.getByRole('button', { name: 'Show everything', exact: true }).click();
  await page.waitForTimeout(850);

  await page.getByRole('button', { name: 'Speed', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Speed', exact: true });
  await expect(panel).toBeVisible();
  await recorder.markReady();

  async function advanceTo(index: number, taskId: string) {
    const snap = snapshots[index]!;
    await page.clock.setSystemTime(new Date(snap.now));
    api.setOrg(snap.org);
    api.setTree(snap.tree);
    await pushStream(page, { type: 'task', id: taskId, spot: { departmentId: 'dept-dev' } });
    await pushStream(page, { type: 'org' });
  }

  /* Speed tab: per-agent working, waiting, idle, interrupted and queued durations move across snapshots. */
  await page.waitForTimeout(1300);
  await advanceTo(1, 't-226');
  await page.waitForTimeout(1300);
  await advanceTo(2, 't-221');
  await page.waitForTimeout(1200);

  /* Switch to the Idle tab: current waits with since-when and ended stretches below. */
  await panel.getByRole('tab', { name: 'Idle', exact: true }).click();
  await expect(panel.getByText('Current waits and interruptions')).toBeVisible();
  await expect(panel.getByText('Ended')).toBeVisible();
  await page.waitForTimeout(1400);

  /* Advance clock once more so active wait duration updates live on the Idle tab. */
  await advanceTo(3, 'r-242');
  await page.waitForTimeout(1450);

  /* Switch back to Speed tab and restore Snapshot 0 so the first and last frames match cleanly. */
  await panel.getByRole('tab', { name: 'Speed', exact: true }).click();
  await advanceTo(0, 't-201');
  await page.waitForTimeout(1450);

  watcher.assertClean();
  await recorder.finishGif('speed');
});
