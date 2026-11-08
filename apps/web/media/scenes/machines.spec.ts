import { expect, test } from '@playwright/test';
import type { MachineView } from '../../src/types';
import { MOONFERN_MACHINES } from '../moonfern/agents';
import { isoMinutes } from '../moonfern/clock';
import { GIB } from '../moonfern/machines';
import { createSceneRecorder, smoothScrollBody } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, triggerPoll } from '../moonfern/stream';

function tweakMachines(
  base: MachineView[],
  loadDelta: Record<string, number>,
  memDeltaGb: Record<string, number>,
  toggleBusyIds: string[],
): MachineView[] {
  const toggle = new Set(toggleBusyIds);
  return base.map(m => ({
    ...m,
    load: m.load
      ? {
          ...m.load,
          load: Math.max(0.4, Number((m.load.load + (loadDelta[m.id] ?? 0)).toFixed(1))),
          memFree: Math.round(m.load.memFree + (memDeltaGb[m.id] ?? 0) * GIB),
        }
      : null,
    running: {
      ...m.running,
      agents: m.running.agents.map(a =>
        toggle.has(a.id)
          ? { ...a, busy: !a.busy, since: !a.busy ? isoMinutes(-2) : null }
          : a,
      ),
    },
  }));
}

test('machines.gif: pool strip at top, live load and working counts, Claude chip filter, studio-server card', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const api = await serveMoonfern(page);

  await page.goto('/');
  await page.getByRole('button', { name: 'Machines', exact: true }).click();

  const pool = page.getByRole('region', { name: 'All machines together' });
  await expect(pool).toBeVisible();
  await expect(pool).toContainText('10 of 10');
  await expect(pool).toContainText('112');
  await expect(pool).toContainText('of 296 GB');
  await expect(page.locator('table.dt tbody tr.rm')).toHaveCount(10);

  const initialScroll = await page.evaluate(() => document.querySelector<HTMLElement>('.body')?.scrollTop ?? 0);
  expect(initialScroll).toBe(0);
  const poolBox = await pool.boundingBox();
  expect(poolBox).not.toBeNull();
  expect(poolBox!.y).toBeGreaterThanOrEqual(50);

  await recorder.markReady();

  /* Hold at the very top so the pool strip and all ten machines are readable. */
  await page.waitForTimeout(750);

  /* Live poll 1: load bars, free memory and working counts shift slightly across the pool. */
  api.setMachines(
    tweakMachines(
      MOONFERN_MACHINES,
      {
        'm-gpu-tower': 1.2,
        'm-leo-mini': 0.9,
        'm-maya-mbp': 1.1,
        'm-old-thinkpad': -0.7,
        'm-rpi': 0.8,
        'm-studio-server': 1.3,
      },
      {
        'm-gpu-tower': -1.8,
        'm-leo-mini': -0.9,
        'm-maya-mbp': -1.4,
        'm-old-thinkpad': 0.6,
        'm-studio-server': -1.6,
      },
      ['dev-8', 'ops-bugs', 'ops-prog', 'biz-analyst'],
    ),
  );
  await triggerPoll(page);
  await page.waitForTimeout(750);

  /* Filter by the Claude provider chip, then clear it. */
  await page.getByRole('group', { name: 'Provider' }).getByRole('button', { name: /^Claude/ }).click();
  await expect(page.locator('table.dt tbody tr.rm')).toHaveCount(6);
  await page.waitForTimeout(950);

  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('table.dt tbody tr.rm')).toHaveCount(10);
  await page.waitForTimeout(450);

  /* Live poll 2: another subtle change in load, free memory and working counts. */
  api.setMachines(
    tweakMachines(
      MOONFERN_MACHINES,
      {
        'm-gpu-tower': 0.6,
        'm-leo-air': 1.1,
        'm-office-nuc': -0.8,
        'm-sam-ws': 1.0,
        'm-studio-server': 0.8,
      },
      {
        'm-leo-air': -0.8,
        'm-office-nuc': 0.5,
        'm-sam-ws': -1.2,
        'm-studio-server': -1.1,
      },
      ['dev-5', 'ops-watch', 'dev-7', 'biz-analyst'],
    ),
  );
  await triggerPoll(page);
  await page.waitForTimeout(600);

  /* Open studio-server ("Company server here") and smoothly scroll its card into view. */
  const studioRowBtn = page.getByRole('button', { name: 'Open the card of studio-server', exact: true });
  await studioRowBtn.click();
  const detailRow = page.locator('table.dt tbody tr.det');
  await expect(detailRow).toHaveCount(1);
  await expect(detailRow).toContainText('Company server here');
  await expect(detailRow).toContainText('Running now');
  await expect(detailRow).toContainText('Plans on this machine');

  /* Stage 1: place studio-server's row and card header right below the top bar so Running now and Plans are in full view. */
  const cardTopScroll = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.body')!;
    const det = document.querySelector<HTMLElement>('table.dt tbody tr.det')!;
    const row = det.previousElementSibling as HTMLElement | null;
    const topEdge = (row ?? det).getBoundingClientRect().top;
    return body.scrollTop + Math.max(0, Math.round(topEdge - 64));
  });
  await smoothScrollBody(page, cardTopScroll, 10, 38);
  await page.waitForTimeout(1550);

  /* Stage 2: studio-server's card is ~980px tall (with Connection to the server below), so glide down to show its bottom too. */
  const cardBottomScroll = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.body')!;
    const det = document.querySelector<HTMLElement>('table.dt tbody tr.det')!;
    const rect = det.getBoundingClientRect();
    return body.scrollTop + Math.max(0, Math.ceil(rect.bottom - 884));
  });
  await smoothScrollBody(page, cardBottomScroll, 8, 38);

  const bottomBox = await detailRow.boundingBox();
  expect(bottomBox).not.toBeNull();
  expect(bottomBox!.y + bottomBox!.height).toBeLessThanOrEqual(896);
  await page.waitForTimeout(1100);

  /* Glide back to studio-server's row header, close the card, return to scrollTop = 0 and restore initial figures. */
  await smoothScrollBody(page, cardTopScroll, 6, 35);
  await studioRowBtn.click();
  await expect(detailRow).toHaveCount(0);
  api.setMachines(MOONFERN_MACHINES);
  await triggerPoll(page);
  await smoothScrollBody(page, 0, 10, 38);

  const finalScroll = await page.evaluate(() => document.querySelector<HTMLElement>('.body')?.scrollTop ?? 0);
  expect(finalScroll).toBe(0);
  await page.waitForTimeout(650);

  watcher.assertClean();
  await recorder.finishGif('machines');
});
