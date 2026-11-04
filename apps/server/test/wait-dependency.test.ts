import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks } from '../src/db/schema.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import { waitCompany } from './wait-company.js';

async function employeeWait() {
  const c = await waitCompany();
  const task = await c.task();
  const worker = await c.run(c.agent.id, task.id);
  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Acceptance', until: deadline, on: { kind: 'employee', employee: c.head.id } } });
  expect(result.isError).toBeFalsy();
  return { ...c, taskRow: task };
}

describe('an employee dependency becomes unavailable', () => {
  it.each([
    ['removed', 'removed'], ['off', 'switched off'], ['subscription', 'no plan'],
  ] as const)('ends the wait and wakes its holder exactly once when the dependency is %s', async (kind, reason) => {
    const c = await employeeWait();
    const now = new Date();
    await c.db.update(agents).set(kind === 'removed' ? { removedAt: now } : kind === 'off' ? { switchedOffAt: now } : { subscriptionId: null }).where(eq(agents.id, c.head.id));
    await Promise.all([checkWaitHealth(c.ctx, now), checkWaitHealth({ ...c.ctx }, now)]);
    await checkWaitHealth(c.ctx, new Date(now.getTime() + 60_000));
    const [task] = await c.db.select().from(tasks).where(eq(tasks.id, c.taskRow.id));
    expect(task!.externalWait).toBeNull();
    const messages = await c.messages(c.agent.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data).toMatchObject({ notification: { source: 'wait_unavailable' } });
    expect(messages[0]!.data).toMatchObject({ text: expect.stringContaining(c.head.name) });
    expect(messages[0]!.data).toMatchObject({ text: expect.stringContaining(reason) });
    expect(messages[0]!.data).toMatchObject({ text: expect.stringContaining('Acceptance') });
  });

  it('keeps waiting for an enabled employee with a plan', async () => {
    const c = await employeeWait();
    await checkWaitHealth(c.ctx);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, c.taskRow.id)))[0]!.externalWait).not.toBeNull();
    expect(await c.messages(c.agent.id)).toEqual([]);
  });
});
