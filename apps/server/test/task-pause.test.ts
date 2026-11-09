import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blocked, cancel, comment, loadTask, silentTurn, submit } from '../src/modules/tasks/engine.js';
import { checkExternalWaits, waitFor } from '../src/modules/tasks/external-wait.js';
import { setPaused } from '../src/modules/tasks/pause.js';
import { startRun } from '../src/modules/testruns/runs.js';
import { taskForWake } from '../src/modules/tasks/wake-state.js';
import { as } from './helpers.js';
import { BASE, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Keep totals.', evidence: 'Focused checks passed.', review: { baseCommit: BASE } };
const refused = (work: Promise<unknown>) => work.then(() => null, (error: { status: number; message: string }) => error);

describe('a paused task wakes nobody until it is resumed', () => {
  it('holds back every wake of its executor and refuses its work, then wakes it once on resume', async () => {
    const f = await fixture();
    await setPaused(f.ctx, { agentId: f.head.id }, f.task.id, true, 'The CEO stopped this work until turn 17 closes.');
    for (const why of ['assigned', 'go_on', 'reminder', 'comment', 'message', 'wait_ended', 'tests', 'answered'] as const) {
      expect(await taskForWake(f.db, { agentId: f.author.id, taskId: f.task.id, why, ...(why === 'message' ? { to: f.author.id } : {}) } as never), why).toBeNull();
    }
    const said = await comment(f.ctx, { agentId: f.head.id }, f.task.id, 'Any news?');
    expect(said.wakes).toEqual([]);
    expect(await refused(submit(f.ctx, f.author.id, f.task.id, code))).toMatchObject({ status: 409, message: expect.stringContaining('paused') });
    expect(await refused(blocked(f.ctx, f.author.id, f.task.id, 'Nothing to do.'))).toMatchObject({ status: 409 });
    expect(await refused(waitFor(f.ctx, f.author.id, f.task.id, { reason: 'Waiting.', until: new Date(Date.now() + 60_000).toISOString() }))).toMatchObject({ status: 409 });
    expect(await refused(startRun(f.ctx, { id: randomUUID(), agentId: f.author.id, companyId: f.task.companyId, taskId: f.task.id } as never, { task: f.task.number } as never))).toMatchObject({ status: 409, message: expect.stringContaining('paused') });
    const quiet = await silentTurn(f.ctx, f.author.id, await loadTask(f.db, f.task.id));
    expect(quiet.wakes).toEqual([]);
    expect((await loadTask(f.db, f.task.id)).silent).toBe(0);

    const resumed = await setPaused(f.ctx, { agentId: f.head.id }, f.task.id, false, '');
    expect(resumed.wakes).toEqual([{ agentId: f.author.id, taskId: f.task.id, why: 'assigned', text: expect.stringContaining('resumed') }]);
    expect((await loadTask(f.db, f.task.id)).paused).toBeNull();
    expect(await taskForWake(f.db, { agentId: f.author.id, taskId: f.task.id, why: 'go_on' })).not.toBeNull();
    await submit(f.ctx, f.author.id, f.task.id, code);
  });

  it('ends a standing wait so no deadline can wake the paused executor', async () => {
    const f = await fixture();
    await waitFor(f.ctx, f.author.id, f.task.id, { reason: 'Waiting for the run.', until: new Date(Date.now() + 60_000).toISOString() });
    await setPaused(f.ctx, { agentId: f.head.id }, f.task.id, true, 'Hold.');
    expect((await loadTask(f.db, f.task.id)).externalWait).toBeNull();
    expect(await checkExternalWaits(f.ctx, new Date(Date.now() + 3_600_000))).toBe(0);
  });

  it('pauses the open work under the task and resumes it with the task', async () => {
    const f = await fixture();
    const { task: child } = await f.create({ title: 'Keep tax totals', parentId: f.task.id });
    await setPaused(f.ctx, { agentId: f.head.id }, f.task.id, true, 'Hold.');
    expect((await loadTask(f.db, child.id)).paused).toMatchObject({ reason: 'Hold.', root: f.task.id });
    expect(await refused(setPaused(f.ctx, { agentId: f.head.id }, child.id, false, ''))).toMatchObject({ status: 409 });
    await setPaused(f.ctx, { agentId: f.head.id }, f.task.id, false, '');
    expect((await loadTask(f.db, child.id)).paused).toBeNull();
  });

  it('lets only the head, the orchestrator or the CEO pause, and clears the pause when the task closes', async () => {
    const f = await fixture();
    expect(await refused(setPaused(f.ctx, { agentId: f.author.id }, f.task.id, true, 'Mine.'))).toMatchObject({ status: 403 });
    const put = await f.app.inject({ method: 'PUT', url: `/api/tasks/${f.task.id}/paused`, payload: { paused: true, reason: 'Hold for the release.' }, ...as(f.ceoToken) });
    expect(put.statusCode).toBe(200);
    expect(put.json().task).toMatchObject({ paused: { reason: 'Hold for the release.' }, mayPause: true });
    await cancel(f.ctx, { agentId: f.head.id }, f.task.id, 'Not needed any more.');
    expect((await loadTask(f.db, f.task.id)).paused).toBeNull();
    expect(await refused(setPaused(f.ctx, { agentId: f.head.id }, f.task.id, true, 'Hold.'))).toMatchObject({ status: 409 });
  });
});
