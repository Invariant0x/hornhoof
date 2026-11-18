import { expect, test } from '@playwright/test';
import type { Org } from '../../src/types';
import { MOONFERN_ORG } from '../moonfern/agents';
import { createSceneRecorder } from '../moonfern/record';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';

function withWorkingIds(base: Org, extraWorkingIds: string[], done: number): Org {
  const extra = new Set(extraWorkingIds);
  const departments = base.departments.map(d => {
    const employees = d.employees.map(e => {
      if (!extra.has(e.id)) return e;
      return { ...e, state: 'working' as const, status: 'working' as const };
    });
    return {
      ...d,
      employees,
      turnProgress: d.id === 'dept-dev' ? { turnNumber: 6, done, total: 40 } : null,
      agents: { total: employees.length, working: employees.filter(e => e.status === 'working').length },
    };
  });
  return {
    ...base,
    departments,
    agents: {
      total: departments.reduce((s, d) => s + d.agents.total, 0),
      working: departments.reduce((s, d) => s + d.agents.working, 0),
    },
  };
}

test('map.gif: Moonfern company map with pulses, moving working count and turn progress', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const initial = withWorkingIds(MOONFERN_ORG, [], 24);
  const api = await serveMoonfern(page, { initialOrg: initial });

  await page.goto('/');
  await expect(page.locator('.hub')).toBeVisible();
  const development = mapDepartment(page, 'Development');
  const staff = MOONFERN_ORG.departments.find(d => d.id === 'dept-dev')!.employees;
  await expect(development.locator('.cells > .cell')).toHaveCount(staff.length);
  await expect(development.locator('.cells > .cell.w')).toHaveCount(staff.filter(e => e.status === 'working').length);
  const progress = development.locator('.dept-turn');
  await expect(progress).toContainText('Ready for release: 24');
  await expect(page.locator('.map [data-worker-kind], .map .cells.calls')).toHaveCount(0);
  await page.waitForTimeout(850);
  await recorder.markReady();

  /* Initial wave of pulses from the hub and back from Design. */
  await page.waitForTimeout(500);
  await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-dev' } });
  await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dsn' }, to: { kind: 'orchestrator' } });

  /* Working count rises (25 -> 27) and Turn 6 task count advances (24 -> 25). */
  await page.waitForTimeout(1500);
  const step1 = withWorkingIds(MOONFERN_ORG, ['dev-8', 'ops-bugs'], 25);
  api.setOrg(step1);
  await pushStream(page, { type: 'working', working: step1.agents.working });
  await expect(development.locator('.cells > .cell.w')).toHaveCount(step1.departments.find(d => d.id === 'dept-dev')!.agents.working);
  await expect(progress).toContainText('Ready for release: 25');
  await pushStream(page, { type: 'task', id: 't-235', spot: { departmentId: 'dept-dev' } });
  await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-mkt' } });
  await pushStream(page, { type: 'pulse', from: { kind: 'person', id: 'p-maya' }, to: { kind: 'orchestrator' } });

  /* Working count rises again (27 -> 28) with cross-department pulses. */
  await page.waitForTimeout(2200);
  const step2 = withWorkingIds(MOONFERN_ORG, ['dev-8', 'ops-bugs', 'ops-prog'], 25);
  api.setOrg(step2);
  await pushStream(page, { type: 'working', working: step2.agents.working });
  await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-dev' }, to: { kind: 'orchestrator' } });
  await pushStream(page, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: 'dept-ops' } });
  await pushStream(page, { type: 'pulse', from: { kind: 'person', id: 'p-leo' }, to: { kind: 'department', id: 'dept-dsn' } });

  /* Return to exact starting counts so the ~8.8s animation loops cleanly. */
  await page.waitForTimeout(2200);
  api.setOrg(initial);
  await pushStream(page, { type: 'working', working: initial.agents.working });
  await pushStream(page, { type: 'task', id: 't-201', spot: { departmentId: 'dept-dev' } });
  await pushStream(page, { type: 'pulse', from: { kind: 'department', id: 'dept-mkt' }, to: { kind: 'orchestrator' } });

  await page.waitForTimeout(2200);
  watcher.assertClean();
  await recorder.finishGif('map');
});
