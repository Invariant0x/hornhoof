import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, pendingWakes, tasks } from '../src/db/schema.js';
import { released } from './turn-tag-close-fixture.js';

/* The tag that closes a turn opens the next, and the next takes its department's queue in as it opens. */
describe('the turn that opens after a release takes the queue in', () => {
  it('gives the first queued task the one slot the release freed, wakes its head, and keeps the one behind it queued', async () => {
    const f = await released();
    const departmentId = f.task.departmentId!;
    const [head] = await f.db.select().from(agents).where(eq(agents.id, f.head.id));
    await f.db.insert(agents).values({ companyId: f.task.companyId, kind: 'worker', name: 'Solo', roleKey: 'DEV-BE', departmentId, model: '', subscriptionId: head!.subscriptionId });
    await f.db.update(departments).set({ slotCap: 1 }).where(eq(departments.id, departmentId));
    const queued = async (title: string, number: number) =>
      (await f.db.insert(tasks).values({ companyId: f.task.companyId, number, title, departmentId, queuedAt: new Date(Date.now() + number) }).returning())[0]!;
    const first = await queued('First in line', 9001);
    const second = await queued('Second in line', 9002);

    await f.round();

    const [next] = (await f.departmentTurns()).filter(t => t.status === 'open');
    expect(next!.number).toBeGreaterThan(f.turn.number);
    expect(await f.db.select().from(tasks).where(eq(tasks.id, first.id)).then(r => r[0])).toMatchObject({ assigneeAgentId: f.head.id, queuedAt: null });
    expect(await f.db.select().from(tasks).where(eq(tasks.id, second.id)).then(r => r[0])).toMatchObject({ assigneeAgentId: null });
    expect((await f.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, first.id))).map(w => [w.agentId, w.why])).toEqual([[f.head.id, 'assigned']]);
  });
});
