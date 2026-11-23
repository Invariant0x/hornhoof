import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { jobs } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { pump } from '../src/modules/conversation/queue.js';
import { createTask, report, submit } from '../src/modules/tasks/engine.js';
import { afterJob, wakeAll } from '../src/modules/tasks/wake.js';
import type { Db } from '../src/db/client.js';
import { type FakeNode, ownDatabases } from './helpers.js';
import { recorded } from './recorded-fixture.js';
import { BASE } from './development-echelons-fixture.js';
import { lineOf, online, stateOf } from './map-state-fixture.js';

/* A server that stops in the middle of a write: a trigger of the database refuses it, which changes more than rows, so each test
   opens a database of its own. */
ownDatabases();

/* From here on the database refuses every change to the table's rows that the condition names, as a server that stops
   right there writes nothing more. What it gives back takes the refusal away again. */
async function stopAt(db: Db, table: 'tasks' | 'map_returns', when = 'true'): Promise<() => Promise<unknown>> {
  await db.execute(sql.raw(`create or replace function hh_stop() returns trigger language plpgsql as $$ begin raise exception 'The server stopped here.'; end $$`));
  await db.execute(sql.raw(`create trigger hh_stop before update on ${table} for each row when (${when}) execute function hh_stop()`));
  return () => db.execute(sql.raw(`drop trigger hh_stop on ${table}`));
}

/* The next turn the node was sent. */
async function sentTo(node: FakeNode): Promise<{ jobId: string; prompt: string }> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m;
}

/* A task that is open and goes to work once its turn does. */
const AT_WORK = `old.status = 'open' and new.status = 'working'`;

describe('a turn the queue takes', () => {
  /* The first work on the line came back, Bruno's handed in or Hana's reported done, and the next work waits for the queue. */
  async function returned(level: 'member' | 'department') {
    const c = await online();
    const { ctx, orchestrator, hana, bruno, top, member, run, end } = c;
    if (level === 'member') {
      const api = await member('Checkout API', bruno.id);
      const first = await run(bruno.id, api.id);
      await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
      await end(first.id);
      return { ...c, up: hana, down: bruno, next: await member('Checkout page', bruno.id) };
    }
    const first = await run(hana.id, top.id);
    await report(ctx, hana.id, top.id, { done: true, summary: 'Payments are live.', ...(await recorded(ctx, top.id, hana.id)) });
    await end(first.id);
    const next = (await createTask(ctx, { agentId: orchestrator.id }, { title: 'Refunds', brief: '', body: '', departmentId: top.departmentId, assigneeAgentId: hana.id })).task;
    return { ...c, up: orchestrator, down: hana, next };
  }

  it.each(['member', 'department'] as const)('begins the new cycle of a %s line with the turn it takes, so a server that stops once the turn went out leaves the old return out', async level => {
    const { ctx, db, config, up, down, next, org, end, builtin } = await returned(level);
    expect(stateOf(await org(), up, down)).toBe('yellow');
    await stopAt(db, 'tasks', AT_WORK);
    await wakeAll(ctx, [{ agentId: down.id, taskId: next.id, why: 'assigned' }]);
    const turn = await sentTo(builtin);
    expect(stateOf(await org(), up, down)).toBe('blue');
    await end(turn.jobId, 'failed');
    expect(stateOf(await org(), up, down)).toBe('quiet');
    const again = await buildApp({ db, config });
    try {
      expect(stateOf(await org(undefined, again), up, down)).toBe('quiet');
    } finally {
      await again.close();
    }
  });

  it.each(['member', 'department'] as const)('takes no turn when the new cycle of its %s line cannot be kept, and sends it with its cycle on the next try', async level => {
    const { ctx, db, up, down, next, org, builtin } = await returned(level);
    const before = builtin.queued();
    const goOn = await stopAt(db, 'map_returns');
    await wakeAll(ctx, [{ agentId: down.id, taskId: next.id, why: 'assigned' }]);
    /* Nothing went out: the turn still waits, and the line still shows the result that came back. */
    expect(await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.taskId, next.id))).toEqual([{ status: 'queued' }]);
    expect(builtin.queued()).toBe(before);
    expect(stateOf(await org(), up, down)).toBe('yellow');
    await goOn();
    await pump(ctx, down.id);
    await sentTo(builtin);
    const now = await org();
    expect(stateOf(now, up, down)).toBe('blue');
    expect(lineOf(now, up.id, down.id)!.workEpoch).toBe(2);
  });

  it("begins the cycle of a task that goes out inside a head's turn with that turn, also when its own task keeps no line on", async () => {
    const { ctx, db, config, acme, sub, orchestrator, hana, top, run, end, org, builtin } = await online();
    const first = await run(hana.id, top.id);
    await report(ctx, hana.id, top.id, { done: false, summary: 'Waiting for the provider.' });
    await end(first.id);
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
    const refunds = (await createTask(ctx, { agentId: orchestrator.id }, { title: 'Refunds', brief: '', body: '', departmentId: top.departmentId, assigneeAgentId: hana.id })).task;
    /* Hana is busy, so the turn on the blocked department task and the one on the new task wait, and go out as one. */
    const [busy] = await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, kind: 'conversation', prompt: 'Plan the turn.', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    await wakeAll(ctx, [
      { agentId: hana.id, taskId: top.id, why: 'assigned' },
      { agentId: hana.id, taskId: refunds.id, why: 'assigned' },
    ]);
    await stopAt(db, 'tasks', AT_WORK);
    await end(busy!.id);
    /* The next turn goes out, and the server stops before the task that went with it is at work. */
    await expect(afterJob(ctx, busy!.id)).rejects.toMatchObject({ cause: { message: 'The server stopped here.' } });
    const turn = await sentTo(builtin);
    expect(turn.prompt).toContain('Refunds');
    expect(stateOf(await org(), orchestrator, hana)).toBe('blue');
    await end(turn.jobId, 'failed');
    const again = await buildApp({ db, config });
    try {
      expect(stateOf(await org(undefined, again), orchestrator, hana)).toBe('quiet');
    } finally {
      await again.close();
    }
  });
});
