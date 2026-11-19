import { expect, test } from '@playwright/test';
import { createSceneRecorder } from '../moonfern/record';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveOakLane } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';

test('home.gif: Oak Lane home map, Home devices at work, Tasks with two requests and one approved', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const oak = await serveOakLane(page);

  await page.goto('/');
  await expect(page.locator('.hub')).toBeVisible();
  const devices = mapDepartment(page, 'Home devices');
  await expect(devices).toBeVisible();
  await page.waitForTimeout(850);
  await recorder.markReady();

  /* 1. Oak Lane home map with live pulses. */
  await page.waitForTimeout(450);
  await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'oak-hom' } });
  await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'oak-hhd' } });
  await page.waitForTimeout(1650);

  /* 2. Fly into the Home devices department at work. */
  await devices.click();
  await expect(page.getByRole('region', { name: 'Department schema', exact: true })).toBeVisible();
  await page.waitForTimeout(750);
  await pushStream(page, {
    type: 'pulse',
    from: { kind: 'agent', id: 'oak-hom-head', departmentId: 'oak-hom' },
    to: { kind: 'agent', id: 'oak-hom-smart', departmentId: 'oak-hom' },
  });
  await page.waitForTimeout(1750);

  /* 3. Open the tracker and approve the router update from the list of requests waiting for Nina. */
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Tasks/ }).click();
  await page.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: /^Waits for me/ }).click();
  const requests = page.locator('.req');
  await expect(requests).toHaveCount(2);
  await page.waitForTimeout(1550);

  await page.getByRole('button', { name: 'Yes, update tonight at 23:30', exact: true }).click();
  await expect(requests).toHaveCount(1);
  await page.waitForTimeout(1350);

  /* 4. Return to the Oak Lane Map with initial state so first and last frames match cleanly. */
  await oak.reset();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.hub')).toBeVisible();
  await page.waitForTimeout(950);

  watcher.assertClean();
  await recorder.finishGif('home');
});
