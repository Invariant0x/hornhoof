import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks } from '../src/db/schema.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import { waitFor } from '../src/modules/tasks/external-wait.js';
import { waitCompany } from './wait-company.js';

async function employeeDependency(legacy: boolean) {
  const c = await waitCompany();
  const task = await c.task();
  const worker = await c.run(c.agent.id, task.id);
  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  if (legacy) {
    await waitFor(c.ctx, c.agent.id, task.id, { reason: 'Acceptance', until: deadline, on: { kind: 'employee', employee: c.head.id } });
  } else {
    const result = await worker.client.callTool({ name: 'track_work', arguments: { task: task.number, work: 'Acceptance', nextCheck: deadline, employee: c.head.id } });
    expect(result.isError).toBeFalsy();
  }
  return { ...c, taskRow: task, worker };
}

describe.each([
  { model: 'stored employee wait', legacy: true, source: 'wait_unavailable', status: 'open' },
  { model: 'tracked employee work', legacy: false, source: 'work_check', status: 'working' },
])('$model', ({ legacy, source, status }) => {
  it.each([
    ['removed', 'removed'], ['off', 'switched off'], ['subscription', 'no plan'],
  ] as const)('clears the pending check and wakes the holder once when the employee is %s', async (kind, reason) => {
    const c = await employeeDependency(legacy);
    const now = new Date();
    await c.db.update(agents).set(kind === 'removed' ? { removedAt: now } : kind === 'off' ? { switchedOffAt: now } : { subscriptionId: null }).where(eq(agents.id, c.head.id));
    await Promise.all([checkWaitHealth(c.ctx, now), checkWaitHealth({ ...c.ctx }, now)]);
    await checkWaitHealth(c.ctx, new Date(now.getTime() + 60_000));
    const [task] = await c.db.select().from(tasks).where(eq(tasks.id, c.taskRow.id));
    expect(task).toMatchObject({ status, externalWait: null });
    const messages = await c.messages(c.agent.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data).toMatchObject({ notification: { source } });
    expect(messages[0]!.data).toMatchObject({ text: expect.stringContaining(c.head.name) });
    expect(messages[0]!.data).toMatchObject({ text: expect.stringContaining(reason) });
    expect(messages[0]!.data).toMatchObject({ text: expect.stringContaining('Acceptance') });
  });

  it('keeps the record readable while the employee is enabled and has a plan', async () => {
    const c = await employeeDependency(legacy);
    await checkWaitHealth(c.ctx);
    const [task] = await c.db.select().from(tasks).where(eq(tasks.id, c.taskRow.id));
    expect(task).toMatchObject({ status, externalWait: { reason: 'Acceptance', on: { employee: c.head.id, name: c.head.name } } });
    const detail = await c.worker.client.callTool({ name: 'task', arguments: { task: c.taskRow.number } }) as { content: { text: string }[] };
    expect(JSON.parse(detail.content[0]!.text)).toMatchObject({ time: { waitsOn: [{ kind: legacy ? 'external' : 'work', reason: 'Acceptance', who: { id: c.head.id } }] } });
    expect(await c.messages(c.agent.id)).toEqual([]);
  });
});
