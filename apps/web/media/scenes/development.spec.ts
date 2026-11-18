import { expect, test } from '@playwright/test';
import type { Department, Employee, EmployeeStatus, EmployeeTask, Org, WorkLine } from '../../src/types';
import { MOONFERN_ORG } from '../moonfern/agents';
import { BASE_MS, isoMinutes } from '../moonfern/clock';
import { createSceneRecorder, smoothDrag } from '../moonfern/record';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { employeeTask } from '../moonfern/route';
import { prepareScenePage, pushStream } from '../moonfern/stream';

type Patch = {
  status?: EmployeeStatus;
  task?: EmployeeTask | null;
  tool?: string | null;
  context?: number;
};

const task = (number: number, title: string, stage = 0, gateCount = 3, _bounces = 0): EmployeeTask => employeeTask(`t-${number}`, number, title, stage, gateCount);

function buildDevSnapshot(minutesOffset: number, patches: Record<string, Patch>): Org {
  const nowIso = isoMinutes(minutesOffset);
  const nowMs = BASE_MS + minutesOffset * 60_000;
  const departments: Department[] = MOONFERN_ORG.departments.map(d => {
    if (d.id !== 'dept-dev') return d;
    const employees: Employee[] = d.employees.map(emp => {
      const p = patches[emp.id];
      const status = p?.status ?? emp.status;
      const working = status === 'working';
      const nextTask = p && 'task' in p ? (p.task ?? null) : emp.task;
      const tool = p && 'tool' in p ? p.tool ?? null : emp.program?.tool ?? null;
      return {
        ...emp,
        status,
        state: working ? 'working' : 'sleeping',
        task: nextTask,
        context: p?.context ?? emp.context,
        program: working
          ? {
              state: tool ? 'tool' : 'thinking',
              since: nowMs - 120_000,
              tool,
              screenAt: nowMs - 8_000,
              signAt: nowMs - 5_000,
              retry: null,
              reportedAt: nowMs - 2_000,
            }
          : null,
      };
    });
    const head = employees.find(e => e.kind === 'head')!;
    const workLines: WorkLine[] = employees
      .filter(e => e.id !== head.id)
      .map(e => ({
        upstreamAgentId: head.id,
        downstreamAgentId: e.id,
        working: e.status === 'working',
        workEpoch: 4,
        returnedEpoch: e.status === 'handed' ? 4 : null,
        returnedAt: e.status === 'handed' ? nowIso : null,
      }));
    return {
      ...d,
      employees,
      workLines,
      current: head.task ? { id: head.task.id, number: head.task.number, title: head.task.title } : null,
      agents: { total: employees.length, working: employees.filter(e => e.status === 'working').length },
    };
  });

  return {
    ...MOONFERN_ORG,
    serverNow: nowIso,
    departments,
    agents: {
      total: departments.reduce((sum, d) => sum + d.agents.total, 0),
      working: departments.reduce((sum, d) => sum + d.agents.working, 0),
    },
  };
}

test('development.gif: Development structure and staff map, with task #221 advancing across gates', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const api = await serveMoonfern(page);

  await page.goto('/');
  await mapDepartment(page, 'Development').click();
  const structure = page.getByRole('region', { name: 'Department structure', exact: true });
  await expect(structure.getByRole('region', { name: 'Beta build way', exact: true })).toBeVisible();
  await recorder.markReady();
  await page.waitForTimeout(1100);

  /* The staff map shows the live handoff lines and the people at each gate. */
  await page.getByRole('button', { name: 'Staff map', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Department schema', exact: true });
  await expect(canvas.getByRole('group', { name: 'Performance', exact: true })).toBeVisible();
  await page.waitForTimeout(450);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await smoothDrag(page, canvas, 90, 48, 4, 25);
  await page.waitForTimeout(200);

  const agent = (id: string) => ({ kind: 'agent' as const, id, departmentId: 'dept-dev' });

  /* Snapshot 0: Iris works on #221 in Developer, Tessa is free, Priya needs a decision, Owen is queued. */
  await page.waitForTimeout(450);
  await pushStream(page, { type: 'pulse', from: agent('dev-head'), to: agent('dev-perf') });
  await page.waitForTimeout(1050);

  /* Snapshot 1: Iris hands #221 to Vera (Code reviewer, gate 1); Tessa picks up #235; Victor needs a decision; Dana's line updates. */
  const snap1 = buildDevSnapshot(3, {
    'dev-head': { task: task(221, 'Route camera flow through code review', 0, 0), context: 0.61 },
    'dev-1': { status: 'handed', task: task(221, 'Plant identification camera flow', 1, 3), context: 0.66 },
    'rev-claude': { status: 'working', tool: 'Read', task: task(221, 'Plant identification camera flow', 1, 3), context: 0.49 },
    'dev-8': { status: 'working', tool: 'Edit', task: task(235, 'Widget refresh budget on iOS 18', 0, 3), context: 0.34 },
    'dev-arch': { status: 'waiting', task: task(219, 'Sync schema for offline watering logs', 0, 3), context: 0.51 },
  });
  await page.clock.setSystemTime(new Date(snap1.serverNow!));
  api.setOrg(snap1);
  await pushStream(page, { type: 'org' });
  await pushStream(page, { type: 'pulse', from: agent('rev-codex'), to: agent('dev-3') });
  await page.waitForTimeout(1300);

  /* Pan once smoothly across the pipeline so Code reviewer, Security engineer and Test engineer fill the frame. */
  await smoothDrag(page, canvas, -420, 0, 9, 36);

  /* Snapshot 2: Vera hands #221 on to Petra (Security engineer, gate 2); Hana needs a decision; Kiran finishes; Dana updates. */
  const snap2 = buildDevSnapshot(6, {
    'dev-head': { task: task(221, 'Check signed camera upload permissions', 0, 0), context: 0.63 },
    'dev-1': { status: 'working', tool: 'Bash', task: task(243, 'Low-light exposure hint banner', 0, 3), context: 0.28 },
    'rev-claude': { status: 'handed', task: task(221, 'Plant identification camera flow', 2, 3), context: 0.53 },
    'dev-sec': { status: 'working', tool: 'Bash', task: task(221, 'Plant identification camera flow', 2, 3), context: 0.55 },
    'dev-8': { status: 'working', tool: 'Edit', task: task(235, 'Widget refresh budget on iOS 18', 0, 3), context: 0.38 },
    'rev-kimi': { status: 'waiting', task: task(217, 'Review species search tokenizer', 1, 3), context: 0.40 },
    'rev-google': { status: 'idle', task: null, context: 0.19 },
  });
  await page.clock.setSystemTime(new Date(snap2.serverNow!));
  api.setOrg(snap2);
  await pushStream(page, { type: 'org' });
  await page.waitForTimeout(1300);

  /* Snapshot 3: Petra hands #221 to Gideon (Test engineer, last gate); Owen unblocks #227; Gideon reports up to Dana. */
  const snap3 = buildDevSnapshot(9, {
    'dev-head': { task: task(221, 'Verify TestFlight camera smoke suite and report', 0, 0), context: 0.65 },
    'dev-1': { status: 'working', tool: 'Bash', task: task(243, 'Low-light exposure hint banner', 0, 3), context: 0.33 },
    'rev-claude': { status: 'working', tool: 'Read', task: task(226, 'Batch photo upload compression', 1, 3), context: 0.36 },
    'dev-sec': { status: 'handed', task: task(221, 'Plant identification camera flow', 3, 3), context: 0.58 },
    'dev-test': { status: 'working', tool: 'Bash', task: task(221, 'Plant identification camera flow', 3, 3), context: 0.59 },
    'dev-7': { status: 'working', tool: 'Edit', task: task(227, 'Shareable plant care card for friends', 0, 3), context: 0.29 },
    'dev-8': { status: 'working', tool: 'Edit', task: task(235, 'Widget refresh budget on iOS 18', 0, 3), context: 0.42 },
  });
  await page.clock.setSystemTime(new Date(snap3.serverNow!));
  api.setOrg(snap3);
  await pushStream(page, { type: 'org' });
  await page.waitForTimeout(500);
  await pushStream(page, { type: 'pulse', from: agent('dev-test'), to: agent('dev-head') });
  await page.waitForTimeout(950);

  /* Restore Snapshot 0 as we pan smoothly back +420px so FLASH_MS (1400ms) finishes and Frame Last matches Frame 0. */
  await page.clock.setSystemTime(new Date(MOONFERN_ORG.serverNow!));
  api.setOrg(MOONFERN_ORG);
  await pushStream(page, { type: 'org' });
  await smoothDrag(page, canvas, 420, 0, 9, 36);
  await page.getByRole('button', { name: 'Department structure', exact: true }).click();
  await expect(structure).toBeVisible();
  await page.waitForTimeout(1150);

  watcher.assertClean();
  await recorder.finishGif('development');
});
