import { expect, test } from '@playwright/test';
import type { SubView } from '../../src/types';
import { MOONFERN_SUBSCRIPTIONS } from '../moonfern/agents';
import { isoMinutes } from '../moonfern/clock';
import { createSceneRecorder, smoothScrollBody } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, triggerPoll } from '../moonfern/stream';

function tweakSubscriptions(
  base: SubView[],
  deltas: Record<string, [number, number]>,
  toggleBusyIds: string[],
): SubView[] {
  const toggle = new Set(toggleBusyIds);
  return base.map(s => {
    const [d5, d7] = deltas[s.id] ?? [0, 0];
    return {
      ...s,
      limits: s.limits
        ? {
            ...s.limits,
            windows: s.limits.windows.map(w => ({
              ...w,
              utilization:
                w.utilization === null
                  ? null
                  : Math.min(0.95, Math.max(0.05, Number((w.utilization + (w.name === 'five_hour' ? d5 : d7)).toFixed(2)))),
            })),
          }
        : null,
      agents: (s.agents ?? []).map(a =>
        toggle.has(a.id)
          ? { ...a, busy: !a.busy, since: !a.busy ? isoMinutes(-3) : null }
          : a,
      ),
    };
  });
}

test('subscriptions.gif: seven plans with live 5h/7d bars, Sam Rivera filter, Maya Chen Orchestrator card', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const api = await serveMoonfern(page);

  await page.goto('/');
  await page.getByRole('button', { name: 'Subscriptions & API', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Subscriptions & API', exact: true })).toBeVisible();
  await expect(page.locator('table.dt tbody tr.rm')).toHaveCount(7);
  await expect(page.locator('table.dt')).toContainText('Maya Chen');
  await expect(page.locator('table.dt')).toContainText('Leo Park');
  await expect(page.locator('table.dt')).toContainText('Sam Rivera');

  const initialScroll = await page.evaluate(() => document.querySelector<HTMLElement>('.body')?.scrollTop ?? 0);
  expect(initialScroll).toBe(0);

  await recorder.markReady();

  /* Hold on the full seven-plan table at the top. */
  await page.waitForTimeout(850);

  /* Live poll 1: 5 hours and 7 days bars nudge upward and working agent counts change. */
  api.setSubscriptions(
    tweakSubscriptions(
      MOONFERN_SUBSCRIPTIONS,
      {
        'sub-maya-claude': [0.04, 0.02],
        'sub-leo-claude': [0.03, 0.02],
        'sub-maya-codex': [0.04, 0.01],
        'sub-sam-codex': [0.03, 0.02],
        'sub-sam-glm': [0.05, 0.02],
        'sub-leo-kimi': [0.03, 0.01],
      },
      ['ops-bugs', 'ops-prog', 'dev-8', 'biz-analyst'],
    ),
  );
  await triggerPoll(page);
  await page.waitForTimeout(850);

  /* Filter by owner chip "Sam Rivera", then clear it. */
  await page.getByRole('group', { name: 'Owner' }).getByRole('button', { name: /^Sam Rivera/ }).click();
  await expect(page.locator('table.dt tbody tr.rm')).toHaveCount(2);
  await page.waitForTimeout(1050);

  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('table.dt tbody tr.rm')).toHaveCount(7);
  await page.waitForTimeout(550);

  /* Live poll 2: another small shift in 5h/7d bars and active agent counts. */
  api.setSubscriptions(
    tweakSubscriptions(
      MOONFERN_SUBSCRIPTIONS,
      {
        'sub-maya-claude': [0.06, 0.03],
        'sub-leo-claude': [0.05, 0.02],
        'sub-leo-google': [0.04, 0.02],
        'sub-sam-glm': [0.03, 0.01],
      },
      ['dev-5', 'ops-watch', 'dev-7'],
    ),
  );
  await triggerPoll(page);
  await page.waitForTimeout(700);

  /* Open Maya Chen's Claude max plan (the Orchestrator one) and frame its card cleanly. */
  const mayaClaudeBtn = page.locator('table.dt tbody tr.rm', { hasText: 'Orchestrator' }).locator('button.rowbtn');
  await mayaClaudeBtn.click();
  const detailRow = page.locator('table.dt tbody tr.det');
  await expect(detailRow).toHaveCount(1);
  await expect(detailRow).toContainText('Orchestrator');
  await expect(detailRow).toContainText('Maya Chen');
  await expect(detailRow).toContainText('maya-macbook-pro');

  const scrollTarget = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.body')!;
    const det = document.querySelector<HTMLElement>('table.dt tbody tr.det')!;
    const rect = det.getBoundingClientRect();
    return body.scrollTop + Math.max(0, Math.ceil(rect.bottom - 882));
  });
  await smoothScrollBody(page, scrollTarget, 10, 42);

  const openBox = await detailRow.boundingBox();
  expect(openBox).not.toBeNull();
  expect(openBox!.y).toBeGreaterThanOrEqual(52);
  expect(openBox!.y + openBox!.height).toBeLessThanOrEqual(896);

  await page.waitForTimeout(2600);

  /* Close Maya's card, return smoothly to scrollTop = 0 and restore starting limits and counts. */
  await mayaClaudeBtn.click();
  await expect(detailRow).toHaveCount(0);
  api.setSubscriptions(MOONFERN_SUBSCRIPTIONS);
  await triggerPoll(page);
  await smoothScrollBody(page, 0, 10, 42);

  const finalScroll = await page.evaluate(() => document.querySelector<HTMLElement>('.body')?.scrollTop ?? 0);
  expect(finalScroll).toBe(0);
  await page.waitForTimeout(750);

  watcher.assertClean();
  await recorder.finishGif('subscriptions');
});
