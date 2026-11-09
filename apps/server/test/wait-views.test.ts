import { TaskWaitView } from '@hornhoof/protocol/waits';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks, taskWaits, turns, waitPolicies } from '../src/db/schema.js';
import { ask, createTask, updateTask, type Task } from '../src/modules/tasks/engine.js';
import { afterSourceKey } from '../src/modules/tasks/wait-state.js';
import { aclCompany, leaks, type AclCompany } from './agent-view-company.js';

const HOUR = 3_600_000;

const policy = (c: AclCompany, kind: 'after' | 'person' = 'after') => c.db.insert(waitPolicies).values({
  companyId: c.companyId, departmentId: c.dev.id, kind, stage: '', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: c.ids.ceo,
});

const comesAfter = async (c: AclCompany, title: string, holder: { id: string }, after: Task[]) =>
  (await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title, brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: holder.id, executor: true, after: after.map(t => t.id), independentNone: 'One piece.' })).task;

type View = TaskWaitView;
const waitsOn = async (c: AclCompany, task: Pick<Task, 'id'>, token: string): Promise<View[]> => (await c.get(`/api/tasks/${task.id}`, token)).json().task.waits as View[];

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

  it('keeps out the wait for a task the reader does not see: no line, no number and no name of it', async () => {
    const c = await aclCompany();
    const hidden = await c.work('Far secret', c.crew.far, c.sales.id);
    const seen = await c.work('Seen first', c.crew.mine);
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [hidden, seen]);
    const res = await c.get(`/api/tasks/${follow.id}`, c.tokens.ann);
    expect(res.json().task.waits).toHaveLength(1);
    expect(res.json().task.waitsFor).toEqual([seen.number]);
    expect(leaks(res, [c.crew.far])).toEqual([]);
    for (const word of ['Far secret', hidden.id, afterSourceKey(hidden.id)]) expect(res.body).not.toContain(word);
    expect(await waitsOn(c, follow, c.tokens.ceo)).toHaveLength(2);
    const line = (await c.get(`/api/tasks?department=${c.dev.id}`, c.tokens.ann)).json().tasks.find((t: { id: string }) => t.id === follow.id);
    expect(line.waits).toHaveLength(1);
  });

  it('leaves out an owner the reader does not see, and a person other than themselves', async () => {
    const c = await aclCompany();
    const shared = (await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Shared', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.crew.other.id, executor: true, reviewerAgentId: c.crew.mine.id })).task;
    await c.db.update(tasks).set({ createdByAgentId: c.crew.mine.id }).where(eq(tasks.id, shared.id));
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [shared]);
    const res = await c.get(`/api/tasks/${follow.id}`, c.tokens.ann);
    expect(res.json().task.waits).toMatchObject([{ kind: 'after', owner: null }]);
    expect(leaks(res, [c.crew.other])).toEqual([]);
    expect(await waitsOn(c, follow, c.tokens.ceo)).toMatchObject([{ owner: { agentId: c.crew.other.id } }]);
    const asked = await c.work('Asked', c.crew.mine);
    await ask(c.app.ctx, c.crew.mine.id, asked.id, { kind: 'approval', text: 'Send it?', approval: { channel: 'message', kind: 'welcome email', amount: null }, topic: 'task' });
    expect(await waitsOn(c, asked, c.tokens.ann)).toMatchObject([{ kind: 'person', owner: null }]);
    expect(await waitsOn(c, asked, c.tokens.olga).catch(() => null)).toBeNull();
    expect(await waitsOn(c, asked, c.tokens.ceo)).toMatchObject([{ kind: 'person', owner: { personId: c.ids.olga } }]);
  });

  it('draws the same waits on the department\'s tree, with the same things left out', async () => {
    const c = await aclCompany();
    await c.db.insert(turns).values({ companyId: c.companyId, number: 90, title: 'Now', goal: 'Now.', status: 'open', openedAt: new Date() });
    const [hidden, seen] = [await c.work('Far secret', c.crew.far, c.sales.id), await c.work('Seen first', c.crew.mine)];
    const made = await comesAfter(c, 'Follow', c.crew.mine, [hidden, seen]);
    const lineOf = async (token: string) => {
      const res = await c.get(`/api/departments/${c.dev.id}/tree`, token);
      const line = (res.json().tree.lines as { taskId: string; waits: View[] }[]).find(l => l.taskId === made.id);
      return { res, line };
    };
    expect((await lineOf(c.tokens.ceo)).line!.waits).toHaveLength(2);
    const ann = await lineOf(c.tokens.ann);
    expect(ann.line!.waits).toHaveLength(1);
    expect(ann.res.body).not.toContain(afterSourceKey(hidden.id));
  });

  it('gives the whole history a page at a time, newest first, past what ended and without what the reader may not see', async () => {
    const c = await aclCompany();
    const hidden = await c.work('Far secret', c.crew.far, c.sales.id);
    const [one, two, three] = [await c.work('One', c.crew.mine), await c.work('Two', c.crew.mine), await c.work('Three', c.crew.mine)];
    const follow = await comesAfter(c, 'Follow', c.crew.mine, [one, hidden]);
    await updateTask(c.app.ctx, c.crew.head.id, follow.id, { after: [one.id, two.id, hidden.id], independentNone: 'One piece.' });
    await updateTask(c.app.ctx, c.crew.head.id, follow.id, { after: [two.id, three.id, hidden.id], independentNone: 'One piece.' });
    const page = async (token: string, query = '') => (await c.get(`/api/tasks/${follow.id}/waits${query}`, token)).json() as { waits: View[]; next: string | null };
    expect((await page(c.tokens.ceo)).waits).toHaveLength(4);
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

  it('refuses the history of a task the reader does not see, and a page that names no place in it', async () => {
    const c = await aclCompany();
    const far = await c.work('Far', c.crew.far, c.sales.id);
    expect((await c.get(`/api/tasks/${far.id}/waits`, c.tokens.ann)).statusCode).toBe(403);
    const own = await c.work('Own', c.crew.mine);
    expect((await c.get(`/api/tasks/${own.id}/waits?before=nonsense`, c.tokens.ann)).statusCode).toBe(400);
    expect((await c.get(`/api/tasks/${own.id}/waits?limit=0`, c.tokens.ann)).statusCode).toBe(400);
  });
});
