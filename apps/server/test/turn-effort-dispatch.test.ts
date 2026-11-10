import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { insertTurn, openTypedTurn, pump } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { turnAgain } from '../src/modules/tasks/again.js';
import { comment, createTask, submit, verdict, type Task, type Wake } from '../src/modules/tasks/engine.js';
import { repeatedTurn } from '../src/modules/tasks/wake-state.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { failureCompany } from './failure-company.js';
import { echelonsTurn } from './helpers.js';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL = 'claude-opus-5-5';
const BASE = 'a'.repeat(40);
const REVIEWER = 'xhigh';
type RunFrame = { type: string; jobId: string; effort: string | null };

async function company() {
  const c = await failureCompany();
  const { ctx, db } = c;
  await db.update(subscriptions).set({ models: [{ id: MODEL, name: 'Opus', efforts: LEVELS }] }).where(eq(subscriptions.id, c.sub.id));
  const skills = (role: string) => ctx.templates.roles.get(role)!.skills.filter(skill => skill.on).map(skill => skill.id);
  await db.update(agents).set({ model: MODEL, skills: skills('DEV-BE') }).where(eq(agents.id, c.agent.id));
  const hire = async (name: string, roleKey: string) => (await db.insert(agents).values({ companyId: c.companyId,
    name, kind: 'worker', roleKey, departmentId: c.dev.id, subscriptionId: c.sub.id, model: MODEL, skills: skills(roleKey) }).returning())[0]!;
  const reviewer = await hire('Rita', 'DEV-REV');
  const tester = await hire('Tess', 'DEV-TEST');
  await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, c.dev.id));
  const commits = new Map<number, string>();
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: 'task' in want ? commits.get(want.task)! : BASE });
  ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: refs.base, headSha: refs.head, paths: ['src/checkout.ts'], diff: '@@ -1 +1 @@\n-old\n+fixed' });
  const task = async (title = 'Checkout API'): Promise<Task> =>
    (await createTask(ctx, { agentId: c.head.id }, { title, brief: '', body: '', departmentId: c.dev.id,
      assigneeAgentId: c.agent.id, executor: true, small: true, paths: ['src/checkout.ts'], reviewerAgentId: reviewer.id, testsAgentId: tester.id })).task;
  const wake = async (wakes: Wake[]) => {
    await wakeAll(ctx, wakes);
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.status, 'queued'));
    for (const w of wakes) await pump(ctx, w.agentId);
  };
  let revision = 0;
  const handIn = async (t: Task, producer = c.agent.id) => {
    commits.set(t.number, (++revision).toString(16).padStart(40, '0'));
    return wake((await submit(ctx, producer, t.id, { summary: 'Current candidate.', evidence: 'Checkout checks.', review: { baseCommit: BASE } })).wakes);
  };
  const finding = async (t: Task, category: 'spec' | 'mechanical' = 'spec') => verdict(ctx, reviewer.id, t.id, {
    pass: false, reviewedCommit: commits.get(t.number)!, comment: 'I am fixing this in Review.',
    issues: [{ category, blocking: true, path: 'src/checkout.ts', line: 1, harm: 'A buyer can be charged twice.' }],
  });
  const running = async (agentId: string) => (await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))))[0]!;
  const endTurn = async (agentId: string) => handleNodeMessage(ctx, BUILTIN, { type: 'job.done', jobId: (await running(agentId)).id,
    ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null });
  const levels = async (agentId: string) => {
    const own = new Set((await c.turnsOf(agentId)).map(job => job.id));
    return c.sent.mock.calls.map(([, frame]) => frame as unknown as RunFrame)
      .filter(frame => frame.type === 'job.run' && own.has(frame.jobId)).map(frame => frame.effort);
  };
  const card = (agentId: string, effort: string | null) => db.update(agents).set({ effort }).where(eq(agents.id, agentId));
  const busy = async (agentId: string) => {
    await insertTurn(ctx, { companyId: c.companyId, agentId, prompt: 'Other current work.', createdBy: null });
    await pump(ctx, agentId);
  };
  const typed = async (agentId: string) => {
    const [person] = await db.select().from(people);
    return (await openTypedTurn(ctx, BUILTIN, agentId, 'Typed words.', person!.id))!;
  };
  await echelonsTurn(db, c.companyId);
  return { ...c, reviewer, tester, task, wake, handIn, finding, running, endTurn, levels, card, busy, typed };
}

describe('effort of the required echelon owner', () => {
  it.each(['spec', 'mechanical'] as const)('keeps %s repairs with Review at its configured level without returning them to the author', async category => {
    const c = await company(), task = await c.task();
    await c.handIn(task);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER]);
    const repair = await c.finding(task, category);
    expect(repair.wakes).toEqual([]);
    expect(repair.task).toMatchObject({ assigneeAgentId: c.reviewer.id, executorAgentId: c.agent.id, status: 'working' });
    await c.endTurn(c.reviewer.id);
    await c.wake((await comment(c.ctx, { agentId: c.head.id }, task.id, 'Check the refund test too.')).wakes);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, REVIEWER]);
    expect(await c.turnsOf(c.agent.id)).toEqual([]);
  });

  it('retains the card level across independent candidates and leaves the card unchanged', async () => {
    const c = await company(), first = await c.task();
    await c.card(c.reviewer.id, 'max');
    await c.handIn(first);
    await c.finding(first);
    await c.endTurn(c.reviewer.id);
    await c.handIn(await c.task('Refunds'));
    expect(await c.levels(c.reviewer.id)).toEqual(['max', 'max']);
    expect((await c.db.select().from(agents).where(eq(agents.id, c.reviewer.id)))[0]!.effort).toBe('max');
  });

  it('claims no effort when the selected model advertises none', async () => {
    const c = await company();
    await c.db.update(subscriptions).set({ models: [{ id: MODEL, name: 'Opus' }] }).where(eq(subscriptions.id, c.sub.id));
    await c.handIn(await c.task());
    expect(await c.levels(c.reviewer.id)).toEqual([null]);
  });

  it('uses only a level the selected model accepts', async () => {
    const c = await company();
    await c.db.update(subscriptions).set({ models: [{ id: MODEL, name: 'Opus', efforts: ['high'] }] }).where(eq(subscriptions.id, c.sub.id));
    await c.handIn(await c.task());
    expect(await c.levels(c.reviewer.id)).toEqual(['high']);
  });

  it('starts Tests with its own configured level after the reviewer submits a repair', async () => {
    const c = await company(), task = await c.task();
    await c.card(c.tester.id, 'max');
    await c.handIn(task);
    await c.finding(task);
    await c.handIn(task, c.reviewer.id);
    expect(await c.levels(c.tester.id)).toEqual(['max']);
    expect(await c.turnsOf(c.agent.id)).toEqual([]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.assigneeAgentId).toBe(c.tester.id);
  });

  it('keeps a running program unchanged and resolves the next turn from its current card', async () => {
    const c = await company();
    await c.busy(c.reviewer.id);
    const current = await c.running(c.reviewer.id);
    await c.card(c.reviewer.id, 'max');
    await c.handIn(await c.task());
    expect((await c.running(c.reviewer.id)).id).toBe(current.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER]);
    await c.endTurn(c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'max']);
  });

  it('opens a typed turn without starting a program and lets the next candidate choose its own effort', async () => {
    const c = await company();
    const opened = await c.typed(c.reviewer.id);
    expect((await c.running(c.reviewer.id)).id).toBe(opened.jobId);
    expect(await c.levels(c.reviewer.id)).toEqual([]);
    await c.card(c.reviewer.id, 'max');
    await c.handIn(await c.task());
    expect(await c.levels(c.reviewer.id)).toEqual([]);
    await c.endTurn(c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual(['max']);
  });

  it('retains the current checker effort and candidate when a machine restart repeats its turn', async () => {
    const c = await company(), task = await c.task();
    await c.card(c.reviewer.id, 'max');
    await c.handIn(task);
    const look = await c.running(c.reviewer.id);
    await c.db.update(jobs).set({ status: 'failed', error: 'machine_restarted' }).where(eq(jobs.id, look.id));
    const ended = await repeatedTurn(c.db, look.id, 'restart');
    expect(ended).not.toBeNull();
    await turnAgain(c.ctx, ended!, 'Your last turn was cut.', { retryOf: look.id });
    await pump(c.ctx, c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual(['max', 'max']);
    expect((await c.running(c.reviewer.id)).taskId).toBe(task.id);
  });
});
