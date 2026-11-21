import { randomUUID } from 'node:crypto';
import { TaskWaitView } from '@hornhoof/protocol/waits';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, tasks, taskWaits, testRuns, turns, waitPolicies } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { ask, createTask, updateTask, type Task } from '../src/modules/tasks/engine.js';
import { afterSourceKey } from '../src/modules/tasks/wait-state.js';
import { aclCompany, leaks, type AclCompany } from './agent-view-company.js';

const HOUR = 3_600_000;

const policy = (c: AclCompany, kind: 'after' | 'person' = 'after') => c.db.insert(waitPolicies).values({
  companyId: c.companyId, departmentId: c.dev.id, kind, stage: '', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: c.ids.ceo,
});

const comesAfter = async (c: AclCompany, title: string, holder: { id: string }, after: Task[]) =>
  (await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title, brief: '', body: '', departmentId: c.dev.id, productId: c.product.id, assigneeAgentId: holder.id, executor: true, after: after.map(t => t.id), independentNone: 'One piece.' })).task;

/* Work of the own agent of an assistant, which no one of the company sees but that assistant's owner. Nobody gives it work
   through the company's tasks, so it is put there as it is. */
const apartWork = async (c: AclCompany, title: string) => {
  const [ava] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'assistant', name: 'Ava', model: '' }).returning();
  const [open] = await c.db.select(idOnly(turns)).from(turns).where(eq(turns.status, 'open'));
  const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 900, turnId: open?.id ?? null, title, departmentId: c.sales.id, assigneeAgentId: ava!.id, createdByPersonId: c.ids.ceo }).returning();
  return { task: task!, agent: ava! };
};

type View = TaskWaitView;
const waitsOn = async (c: AclCompany, task: Pick<Task, 'id'>, token: string): Promise<View[]> => (await c.get(`/api/tasks/${task.id}`, token)).json().task.waits as View[];
const timeWaits = async (c: AclCompany, task: Task, token = c.tokens.ceo) =>
  (await c.get(`/api/tasks/${task.id}`, token)).json().task.time.waitsOn;
const SINCE = '2026-11-17T21:45:00.000Z';
const UNTIL = '2099-11-17T22:35:00.000Z';

async function keepExternal(c: AclCompany, task: Task, extra: Partial<NonNullable<Task['externalWait']>> = {}) {
  const externalWait = { operation: randomUUID(), reason: 'Check the deployment', since: SINCE, until: UNTIL, ...extra };
  await c.db.update(tasks).set({ externalWait }).where(eq(tasks.id, task.id));
  await c.db.insert(taskWaits).values({ companyId: c.companyId, taskId: task.id, kind: 'external', sourceKey: `wait_for:${externalWait.operation}`, sourceRevision: 0, state: 'legacy_needs_plan', ownerAgentId: task.assigneeAgentId, createdAt: new Date(SINCE) });
}

describe('what a task is waiting for', () => {
  it('shows the external reason only to someone who can read what the holder wrote', async () => {
    const c = await aclCompany();
    const task = await c.work('Deploy', c.crew.owned);
    await keepExternal(c, task);
    expect(await timeWaits(c, task)).toEqual([{ kind: 'external', reason: 'Check the deployment', who: null, since: SINCE, until: UNTIL }]);
    expect(await timeWaits(c, task, c.tokens.wes)).toEqual([{ kind: 'external', reason: null, who: null, since: SINCE }]);
  });

  it('names the employee asked to act even when someone else owns the wait', async () => {
    const c = await aclCompany();
    const task = await c.work('Deploy', c.crew.mine);
    await keepExternal(c, task, { on: { kind: 'employee', employee: c.crew.owned.id, name: c.crew.owned.name } });
    expect(await timeWaits(c, task)).toMatchObject([{ kind: 'external', who: { kind: 'agent', id: c.crew.owned.id, name: c.crew.owned.name } }]);
  });

  it('names the reviewer from the review itself and never names the executor as the target', async () => {
    const c = await aclCompany();
    const task = await c.work('Review', c.crew.mine);
    const review = { companyId: c.companyId, taskId: task.id, kind: 'review' as const, sourceRevision: 0, state: 'legacy_needs_plan' as const, ownerAgentId: c.crew.mine.id, createdAt: new Date(SINCE) };
    await c.db.insert(taskWaits).values({ ...review, sourceKey: `review:${task.id}:review:${randomUUID()}:${c.crew.owned.id}` });
    expect(await timeWaits(c, task)).toEqual([{ kind: 'review', reason: null, who: { kind: 'agent', id: c.crew.owned.id, name: c.crew.owned.name }, since: SINCE }]);
    await c.db.update(taskWaits).set({ sourceKey: `review:${task.id}:review:${randomUUID()}:${c.crew.mine.id}` }).where(eq(taskWaits.taskId, task.id));
    expect(await timeWaits(c, task)).toMatchObject([{ kind: 'review', who: null }]);
  });

  it('names the current recipient of a question even when its wait has a different owner', async () => {
    const c = await aclCompany();
    const task = await c.work('Ask', c.crew.mine);
    await ask(c.app.ctx, c.crew.mine.id, task.id, { kind: 'question', text: 'Which currency?', topic: 'task' });
    await c.db.update(taskWaits).set({ ownerPersonId: c.ids.ceo }).where(eq(taskWaits.taskId, task.id));
    expect(await timeWaits(c, task, c.tokens.olga)).toMatchObject([{ kind: 'person', who: { kind: 'person', id: c.ids.olga } }]);
  });

  it('names only the person asked on a named question in both tracker responses', async () => {
    const c = await aclCompany();
    const task = await c.work('Choose the currency', c.crew.mine);
    const { request } = await ask(c.app.ctx, c.crew.mine.id, task.id, { kind: 'question', text: 'Which currency?', recipientPersonId: c.ids.olga });
    const decisions = await c.get('/api/requests', c.tokens.ceo);
    expect(decisions.json().requests).toContainEqual(expect.objectContaining({ id: request.id, canAnswer: false, ownerPersonId: c.ids.olga }));
    const named = { kind: 'person', request: true, who: { kind: 'person', id: c.ids.olga } };
    expect(await timeWaits(c, task)).toMatchObject([named]);
    const list = await c.get('/api/tasks?status=all', c.tokens.ceo);
    expect(list.json().tasks.find((row: Task) => row.id === task.id).time.waitsOn).toMatchObject([named]);
  });

  it.each([['tests', 'run'], ['work', 'work']] as const)('uses the number of a %s run even when two records name it', async (kind, shownKind) => {
    const c = await aclCompany();
    const task = await c.work('Test the release', c.crew.mine);
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.crew.mine.subscriptionId!, agentId: c.crew.mine.id, taskId: task.id, prompt: 'Test it', timeoutMs: 60_000 }).returning();
    const [run] = await c.db.insert(testRuns).values({ companyId: c.companyId, agentId: c.crew.mine.id, taskId: task.id, jobId: job!.id, kind, number: 108, command: 'test', timeoutMs: 60_000 }).returning();
    await c.db.insert(taskWaits).values({ companyId: c.companyId, taskId: task.id, kind: 'run', sourceKey: `run:${run!.id}`, sourceRevision: 0, state: 'legacy_needs_plan', ownerAgentId: c.crew.mine.id, createdAt: new Date(SINCE) });
    const expected = [{ kind: shownKind, reason: '108', who: null, since: SINCE }];
    expect(await timeWaits(c, task)).toEqual(expected);
    await keepExternal(c, task, { run: run!.id, reason: 'Rerun 108 on turn-32 9900330a, then release_turn' });
    const bound = [{ ...expected[0], until: UNTIL }];
    expect(await timeWaits(c, task)).toEqual(bound);
    const list = await c.get('/api/tasks?status=all', c.tokens.ceo);
    expect(list.json().tasks.find((row: Task) => row.id === task.id).time.waitsOn).toEqual(bound);
  });
});

describe('what people read of the waits on a task', () => {
  it('says who answers by when, soonest first, and nothing of its source, proof or route', async () => {
    const c = await aclCompany();
    await policy(c);
    const first = await c.work('First', c.crew.mine);
    const second = await c.work('Second', c.crew.owned);
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [first, second]);
    await c.db.update(taskWaits).set({ nextActionAt: new Date(Date.now() + 10 * HOUR) }).where(eq(taskWaits.sourceKey, afterSourceKey(first.id)));
    const res = await c.get(`/api/tasks/${follow.id}`, c.tokens.ceo);
    const shown = res.json().task.waits as View[];
    expect(shown.map(w => w.owner)).toEqual([{ agentId: c.crew.owned.id }, { agentId: c.crew.mine.id }]);
    for (const wait of shown) expect(TaskWaitView.safeParse(wait).success).toBe(true);
    expect(shown[0]).toMatchObject({ kind: 'after', state: 'active', level: 0, generation: 1, taskId: follow.id, stage: null });
    const body = JSON.stringify(shown);
    for (const word of ['sourceKey', 'proofRef', 'plan', 'finalDecision', 'fallbackToCeo', afterSourceKey(first.id)]) expect(body).not.toContain(word);
  });

  it('shows a wait no one planned as just that: its owner, and no date', async () => {
    const c = await aclCompany();
    const first = await c.work('First', c.crew.mine);
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [first]);
    expect(await waitsOn(c, follow, c.tokens.ceo)).toMatchObject([{ state: 'legacy_needs_plan', owner: { agentId: c.crew.mine.id }, ownerDueAt: null, headDueAt: null, decisionDueAt: null, nextActionAt: null }]);
  });

  it("keeps out the wait for a task the reader does not see, an assistant's own agent's: no line, no number and no name of it", async () => {
    const c = await aclCompany();
    const { task: hidden, agent } = await apartWork(c, 'Own secret');
    /* Another department's work is the company's, which everyone sees. */
    const far = await c.work('Far first', c.crew.far, c.sales.id);
    const seen = await c.work('Seen first', c.crew.mine);
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [hidden, far, seen]);
    const res = await c.get(`/api/tasks/${follow.id}`, c.tokens.ann);
    expect(res.json().task.waits).toHaveLength(2);
    expect(res.json().task.time.waitsOn).toHaveLength(2);
    expect(res.json().task.time.waitsOn).toEqual(expect.arrayContaining([far, seen].map(task => ({ kind: 'after', who: null, reason: `#${task.number}`, since: expect.any(String) }))));
    expect(res.json().task.waitsFor).toEqual([far.number, seen.number]);
    expect(leaks(res, [agent])).toEqual([]);
    for (const word of ['Own secret', hidden.id, afterSourceKey(hidden.id)]) expect(res.body).not.toContain(word);
    expect(await waitsOn(c, follow, c.tokens.ceo)).toHaveLength(2);
    const line = (await c.get(`/api/tasks?department=${c.dev.id}`, c.tokens.ann)).json().tasks.find((t: { id: string }) => t.id === follow.id);
    expect([line.waits.length, line.time.waitsOn.length]).toEqual([2, 2]);
  });

  it('names an employee who owns a wait to everyone, and leaves out a person other than themselves', async () => {
    const c = await aclCompany();
    const shared = (await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Shared', brief: '', body: '', departmentId: c.dev.id, productId: c.product.id, assigneeAgentId: c.crew.other.id, executor: true, reviewerAgentId: c.crew.mine.id })).task;
    await c.db.update(tasks).set({ createdByAgentId: c.crew.mine.id }).where(eq(tasks.id, shared.id));
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [shared]);
    expect(await waitsOn(c, follow, c.tokens.ann)).toMatchObject([{ kind: 'after', owner: { agentId: c.crew.other.id } }]);
    expect(await waitsOn(c, follow, c.tokens.ceo)).toMatchObject([{ owner: { agentId: c.crew.other.id } }]);
    const asked = await c.work('Asked', c.crew.mine);
    await ask(c.app.ctx, c.crew.mine.id, asked.id, { kind: 'approval', text: 'Send it?', approval: { channel: 'message', kind: 'welcome email', amount: null }, topic: 'task' });
    expect(await waitsOn(c, asked, c.tokens.ann)).toMatchObject([{ kind: 'person', owner: null }]);
    /* Olga owns Development, so she reads herself as the person it waits on; Wes reads that it waits on someone. */
    expect(await waitsOn(c, asked, c.tokens.olga)).toMatchObject([{ kind: 'person', owner: { personId: c.ids.olga } }]);
    expect(await waitsOn(c, asked, c.tokens.wes)).toMatchObject([{ kind: 'person', owner: null }]);
    expect(await waitsOn(c, asked, c.tokens.ceo)).toMatchObject([{ kind: 'person', owner: { personId: c.ids.olga } }]);
  });

  it('draws the same waits on the department\'s tree, with the same things left out', async () => {
    const c = await aclCompany();
    await c.db.insert(turns).values([
      { companyId: c.companyId, departmentId: c.dev.id, number: 90, title: 'Now', goal: 'Now.', status: 'open', openedAt: new Date() },
      { companyId: c.companyId, departmentId: c.sales.id, number: 91, title: 'Now', goal: 'Now.', status: 'open', openedAt: new Date() },
    ]);
    const [{ task: hidden }, far, seen] = [await apartWork(c, 'Own secret'), await c.work('Far first', c.crew.far, c.sales.id), await c.work('Seen first', c.crew.mine)];
    const made = await comesAfter(c, 'Follow', c.crew.mine, [hidden, far, seen]);
    const lineOf = async (token: string) => {
      const res = await c.get(`/api/departments/${c.dev.id}/tree`, token);
      const line = (res.json().tree.lines as { taskId: string; waits: View[] }[]).find(l => l.taskId === made.id);
      return { res, line };
    };
    for (const token of [c.tokens.ceo, c.tokens.ann]) {
      const { res, line } = await lineOf(token);
      expect(line!.waits).toHaveLength(2);
      expect(res.body).not.toContain(afterSourceKey(hidden.id));
    }
  });

  it('gives the whole history a page at a time, newest first, past what ended and without what the reader may not see', async () => {
    const c = await aclCompany();
    const { task: hidden } = await apartWork(c, 'Own secret');
    const [one, two, three] = [await c.work('One', c.crew.mine), await c.work('Two', c.crew.mine), await c.work('Three', c.crew.mine)];
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [one, hidden]);
    await updateTask(c.app.ctx, c.crew.head.id, follow.id, { after: [one.id, two.id, hidden.id], independentNone: 'One piece.' });
    await updateTask(c.app.ctx, c.crew.head.id, follow.id, { after: [two.id, three.id, hidden.id], independentNone: 'One piece.' });
    const page = async (token: string, query = '') => (await c.get(`/api/tasks/${follow.id}/waits${query}`, token)).json() as { waits: View[]; next: string | null };
    expect((await page(c.tokens.ceo)).waits).toHaveLength(3);
    expect(JSON.stringify(await page(c.tokens.ceo))).not.toContain(afterSourceKey(hidden.id));
    const first = await page(c.tokens.ann, '?limit=2');
    expect(first.waits).toHaveLength(2);
    expect(first.next).toEqual(expect.any(String));
    const second = await page(c.tokens.ann, `?limit=2&before=${encodeURIComponent(first.next!)}`);
    expect(second.next).toBeNull();
    expect(second.waits).toHaveLength(1);
    const all = [...first.waits, ...second.waits];
    expect(new Set(all.map(w => w.id)).size).toBe(3);
    expect(all.map(w => w.state)).toContain('cancelled');
    for (const wait of all) expect(TaskWaitView.safeParse(wait).success).toBe(true);
  });

  it("refuses the history of a task the reader does not see, an assistant's own agent's, and a page that names no place in it", async () => {
    const c = await aclCompany();
    const far = await c.work('Far', c.crew.far, c.sales.id);
    expect((await c.get(`/api/tasks/${far.id}/waits`, c.tokens.ann)).statusCode).toBe(200);
    const { task: hidden } = await apartWork(c, 'Own secret');
    expect((await c.get(`/api/tasks/${hidden.id}/waits`, c.tokens.ann)).statusCode).toBe(403);
    const own = await c.work('Own', c.crew.mine);
    expect((await c.get(`/api/tasks/${own.id}/waits?before=nonsense`, c.tokens.ann)).statusCode).toBe(400);
    expect((await c.get(`/api/tasks/${own.id}/waits?limit=0`, c.tokens.ann)).statusCode).toBe(400);
  });
});
