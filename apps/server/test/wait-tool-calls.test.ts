import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { tasks } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { waitFor } from '../src/modules/tasks/external-wait.js';
import { waitCompany } from './wait-company.js';

/* #1981: a tool call that records a wait or an employee's work runs the background check of waits after its own move. That check
   reads a lot and may fail (the 5 s transaction timeout); the move is done by then, and the next minute's round does the check
   again, so the call does not fail for it. */
const quiet = vi.hoisted(() => ({ fails: false }));
vi.mock('../src/modules/tasks/wait-observations.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/modules/tasks/wait-observations.js')>();
  return {
    ...real,
    quietDepartment: (...args: Parameters<typeof real.quietDepartment>) => {
      if (quiet.fails) throw Object.assign(new Error('terminating connection due to transaction timeout'), { code: '25P04' });
      return real.quietDepartment(...args);
    },
  };
});

async function company() {
  const c = await waitCompany();
  const task = await c.task();
  const worker = await c.run(c.agent.id, task.id);
  return { ...c, taskRow: task, worker, deadline: new Date(Date.now() + 3_600_000).toISOString() };
}

describe('a background check that fails after a tool call', () => {
  it('does not fail track_work with an employee: the work is recorded, the failure logged, and the next round does the check', async () => {
    const c = await company();
    const logged = vi.spyOn(c.ctx.log, 'error');
    quiet.fails = true;
    try {
      const result = await c.worker.client.callTool({ name: 'track_work', arguments: { task: c.taskRow.number, work: 'Acceptance', nextCheck: c.deadline, employee: c.head.id } });
      expect(result.isError).toBeFalsy();
    } finally {
      quiet.fails = false;
    }
    const [row] = await c.db.select().from(tasks).where(eq(tasks.id, c.taskRow.id));
    expect(row!.externalWait).toMatchObject({ reason: 'Acceptance', work: true, on: { kind: 'employee', employee: c.head.id } });
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ error: expect.anything() as unknown }), expect.stringContaining('task waits'));
    const failed: unknown[] = [];
    await minuteRound(c.ctx, new Date(), () => error => { failed.push(error); });
    expect(failed).toEqual([]);
  });

  it('does not fail a wait on an employee either', async () => {
    const c = await company();
    const logged = vi.spyOn(c.ctx.log, 'error');
    quiet.fails = true;
    try {
      await expect(waitFor(c.ctx, c.agent.id, c.taskRow.id, { reason: 'Acceptance', until: c.deadline, on: { kind: 'employee', employee: c.head.id } })).resolves.toMatchObject({ task: { id: c.taskRow.id } });
    } finally {
      quiet.fails = false;
    }
    const [row] = await c.db.select().from(tasks).where(eq(tasks.id, c.taskRow.id));
    expect(row!.externalWait).toMatchObject({ reason: 'Acceptance' });
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ error: expect.anything() as unknown }), expect.stringContaining('task waits'));
  });

  it('still fails the call for what is its own: a task that is not the caller\'s', async () => {
    const c = await company();
    const stranger = await c.task(c.head.id);
    const result = await c.worker.client.callTool({ name: 'track_work', arguments: { task: stranger.number, work: 'Acceptance', nextCheck: c.deadline, employee: c.head.id } });
    expect(result.isError).toBe(true);
  });
});
