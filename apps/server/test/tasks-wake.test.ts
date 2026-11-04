import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import * as instructionBuilder from '../src/modules/agents/instructions.js';
import { describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, machines, nodes, pendingWakes, people, personAccess, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { agentState, enqueueTurn } from '../src/modules/conversation/queue.js';
import { said } from '../src/modules/conversation/live.js';
import { identityOf, type NodeIdentity } from '../src/modules/nodes/hub.js';
import { answer, ask, blocked, cancel, comment, createTask, GOING_ON_TURNS, report, submit, updateTask } from '../src/modules/tasks/engine.js';
import { afterJob, SILENT_TURNS, startWork, typedTurn, wakeAll, wakeLeftBehind, wakePrompt } from '../src/modules/tasks/wake.js';
import { as, connectNode, listen, setUpCompany, statements, testApp, until, type FakeNode } from './helpers.js';

async function company(env?: NodeJS.ProcessEnv) {
  const { app, db } = await testApp(env);
  const owner = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  const memberTask = async (gates = [rita.id]) =>
    (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, gates })).task;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  /* The agent's oldest waiting turn runs and ends; what it did in between is up to the test. */
  const finish = async (agentId: string, during: () => Promise<unknown> = async () => {}, status: 'done' | 'failed' = 'done') => {
    const [job] = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
    await db.update(jobs).set({ status: 'running', startedAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job!.id));
    await during();
    await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await afterJob(ctx, job!.id);
    return job!;
  };
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, owner, ctx, db, sub: sub!, ceo: ceo!, dev: dev!, orchestrator: orchestrator!, head, bruno, rita, memberTask, turnsOf, finish };
}

describe('a delayed merge wake on a closed task', () => {
  it.each(['done', 'cancelled'] as const)('logs a skipped merge on %s without waking anyone', async status => {
    const c = await company();
    const task = await c.memberTask();
    await c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task.id));
    await c.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, agentId: c.bruno.id, kind: 'submitted', text: 'Merged.', data: { merged: true } });
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'merge', text: 'turn-5' }]);
    expect(await c.db.select().from(jobs)).toEqual([]);
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(log.filter(e => e.kind === 'wake_skipped')).toEqual([expect.objectContaining({ agentId: c.bruno.id, text: 'Run skipped: task is already closed. Bruno: merge.', data: { wake: 'merge', job: null } })]);
    expect(await c.db.select().from(agentEvents)).toEqual([]);
  });
});

describe('a person who speaks to an agent directly', () => {
  /* Bruno ends turns on his task without moving it until Hornhoof asks a person how he should go on. */
  async function stuck() {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.bruno.id);
    return { ...c, task };
  }
  const requestsOf = (c: Awaited<ReturnType<typeof company>>) =>
    c.db.select({ kind: requests.kind, status: requests.status, answer: requests.answer, answeredBy: requests.answeredBy }).from(requests).orderBy(asc(requests.createdAt));

  it("tells a stuck agent how to go on by typing into its terminal, and the task goes on", async () => {
    const c = await stuck();
    expect(await c.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'waiting' }]);
    expect(await typedTurn(c.ctx, identityOf(c.sub, null)!, c.bruno.id, 'Run the tests first, then submit.', c.ceo.id)).not.toBeNull();
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'answered', answer: 'Run the tests first, then submit.', answeredBy: c.ceo.id }]);
    expect(await c.db.select({ status: tasks.status, silent: tasks.silent }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'working', silent: 0 }]);
    /* After the typed turn the task's own turn follows, so a typed turn that goes nowhere still leaves the task watched. */
    const queued = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    expect(queued.map(j => j.taskId)).toEqual([c.task.id]);
    expect(queued[0]!.prompt).toContain('Run the tests first, then submit.');
  });

  it('leaves what waits on a task alone for a person who cannot reach the task', async () => {
    const c = await stuck();
    const [sales] = await c.db.insert(departments).values({ companyId: c.dev.companyId, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const [maria] = await c.db.insert(people).values({ companyId: c.dev.companyId, name: 'Maria', email: 'maria@acme.com', status: 'active', scopeKind: 'listed' }).returning();
    await c.db.insert(personAccess).values({ companyId: c.dev.companyId, personId: maria!.id, departmentId: sales!.id });
    expect(await typedTurn(c.ctx, identityOf(c.sub, null)!, c.bruno.id, 'Skip the tests.', maria!.id)).not.toBeNull();
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'open', answer: null, answeredBy: null }]);
    expect(await c.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'waiting' }]);
  });

  it("answers the agent's question with a message in its window, and leaves a commit to approve open", async () => {
    const { app, db, ceo, hire, task } = await withRepositories();
    const bruno = await hire('Bruno', null);
    const mine = await task(bruno.id);
    await ask(app.ctx, bruno.id, mine.id, { kind: 'question', text: 'EUR or USD?' });
    await ask(app.ctx, bruno.id, mine.id, { kind: 'approval', text: 'Merge it?', commit: 'a'.repeat(40) });
    const [me] = await db.select().from(people);
    await until(async () => (await agentState(app.ctx, bruno.id)).ready);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/messages`, payload: { text: 'EUR only.' }, ...as(ceo) })).statusCode).toBe(202);
    expect(await db.select({ kind: requests.kind, status: requests.status, answer: requests.answer, answeredBy: requests.answeredBy }).from(requests).orderBy(asc(requests.createdAt))).toEqual([
      { kind: 'question', status: 'answered', answer: 'EUR only.', answeredBy: me!.id },
      { kind: 'approval', status: 'open', answer: null, answeredBy: null },
    ]);
    /* The message's own turn, and the task's after it. */
    expect((await db.select({ taskId: jobs.taskId }).from(jobs).where(eq(jobs.agentId, bruno.id)).orderBy(asc(jobs.createdAt))).map(j => j.taskId)).toEqual([null, mine.id]);
  });
});

describe('words for an agent at work', () => {
  /* Bruno runs a turn in his live terminal; his node answers each word Hornhoof sends with ok. */
  async function atWork(ok = true, onTask = false) {
    const c = await company();
    const task = onTask ? await c.memberTask() : null;
    const [run] = await c.db.insert(jobs).values({ companyId: c.dev.companyId, subscriptionId: c.sub.id, agentId: c.bruno.id, taskId: task?.id ?? null, kind: 'conversation', prompt: 'work', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    const says: { agentKey: string; text: string }[] = [];
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockReturnValue(true);
    vi.spyOn(c.ctx.hub, 'send').mockImplementation((node, m) => {
      if (m.type !== 'agent.say') return true;
      says.push({ agentKey: m.agentKey, text: m.text });
      setTimeout(() => said(c.ctx, node, m.ref, ok), 10);
      return true;
    });
    return { ...c, run: run!, says, task };
  }
  const queuedOf = (c: Awaited<ReturnType<typeof company>>, agentId: string) => c.db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued')));
  const message = (c: Awaited<ReturnType<typeof company>>) => ({ companyId: c.dev.companyId, agentId: c.bruno.id, prompt: 'Hana (Head of development): Use the new schema.', createdBy: null, message: { personId: null, text: 'Use the new schema.', from: 'agent' as const, name: 'Hana', by: c.head.id } });

  it('types a message into the turn that runs, and opens no turn for it', async () => {
    const c = await atWork();
    expect(await enqueueTurn(c.ctx, message(c))).toBe(c.run.id);
    expect(c.says).toEqual([{ agentKey: c.bruno.id, text: 'From Hana (Head of development, Development) to Bruno (Backend engineer, Development):\n\nHana (Head of development): Use the new schema.' }]);
    expect(await queuedOf(c, c.bruno.id)).toEqual([]);
    const [shown] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.bruno.id), eq(agentEvents.kind, 'message')));
    expect(shown).toMatchObject({ jobId: c.run.id, data: { text: 'Use the new schema.', name: 'Hana' } });
  });

  it('gives a message its own turn when it could not go into the one that runs', async () => {
    const c = await atWork(false);
    const jobId = await enqueueTurn(c.ctx, message(c));
    expect(jobId).not.toBe(c.run.id);
    expect((await queuedOf(c, c.bruno.id)).map(j => j.prompt)).toEqual(['Hana (Head of development): Use the new schema.']);
  });

  it("types a person's comment into the turn on that task, and a comment on another task waits for its own turn", async () => {
    const w = await atWork(true, true);
    const other = (await createTask(w.ctx, { agentId: w.head.id }, { title: 'Refunds', brief: '', body: 'POST /refunds.', departmentId: w.dev.id, assigneeAgentId: w.bruno.id, executor: true, gates: [w.rita.id] })).task;
    await wakeAll(w.ctx, (await comment(w.ctx, { personId: w.ceo.id }, w.task!.id, 'EUR only.')).wakes);
    expect(w.says.map(s => s.text)).toEqual([expect.stringContaining('EUR only.')]);
    expect(await queuedOf(w, w.bruno.id)).toEqual([]);
    await wakeAll(w.ctx, (await comment(w.ctx, { personId: w.ceo.id }, other.id, 'USD too.')).wakes);
    expect(w.says).toHaveLength(1);
    expect((await queuedOf(w, w.bruno.id)).map(j => j.taskId)).toEqual([other.id]);
  });
});

describe('a plan at its limit', () => {
  it('does not count a turn that ended at the limit as standing still: the agent goes on after the reset', async () => {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await c.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] } }).where(eq(subscriptions.id, c.sub.id));
    for (let i = 0; i < SILENT_TURNS + 1; i++) await c.finish(c.bruno.id, async () => {}, 'failed');
    expect(await c.db.select({ status: tasks.status, silent: tasks.silent }).from(tasks).where(eq(tasks.id, task.id))).toEqual([{ status: 'open', silent: 0 }]);
    expect(await c.db.select().from(requests)).toEqual([]);
    const queued = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain('Go on with the work from where you left off');
  });
});

describe('a plan at its limit, with others of the role on other plans', () => {
  /* Rex is a backend engineer too, on a Codex plan whose machine is on; Bruno's plan is at its limit for an hour, and
     refuses his turn as it starts. before: what Bruno's turns did on the task until then. */
  async function withPeer(rex: { limited?: boolean; status?: 'ready' | 'needs_login'; online?: boolean; nodeVersion?: string } = {}, before: 'nothing' | 'a turn' | 'a long refused turn' = 'nothing') {
    const c = await company();
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const rejected = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt }] };
    const [codex] = await c.db
      .insert(subscriptions)
      .values({ companyId: c.dev.companyId, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: c.ceo.id, status: rex.status ?? 'ready', limits: rex.limited ? rejected : null })
      .returning();
    const [box] = await c.db.insert(machines).values({ companyId: c.dev.companyId, personId: c.ceo.id, machineKey: 'rex-0001-abcd', hostname: 'rex-box' }).returning();
    await c.db.insert(nodes).values({ id: codex!.id, companyId: c.dev.companyId, machineId: box!.id, subscriptionId: codex!.id, keyHash: 'rex-key-hash', status: rex.status ?? 'ready', version: rex.nodeVersion ?? '0.5.0' });
    const { isReady, hasTerminals } = { isReady: c.ctx.hub.isReady.bind(c.ctx.hub), hasTerminals: c.ctx.hub.hasTerminals.bind(c.ctx.hub) };
    const rexs = (id: NodeIdentity) => id.kind === 'node' && id.nodeId === codex!.id;
    vi.spyOn(c.ctx.hub, 'isReady').mockImplementation(id => (rexs(id) ? rex.online ?? true : isReady(id)));
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockImplementation(id => !rexs(id) && hasTerminals(id));
    const [peer] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Rex', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: codex!.id }).returning();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    if (before === 'a turn') await c.finish(c.bruno.id, () => comment(c.ctx, { agentId: c.bruno.id }, task.id, 'The handler is half done.'));
    await c.db.update(subscriptions).set({ limits: rejected }).where(eq(subscriptions.id, c.sub.id));
    const running = and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'running'));
    const refused = async () => {
      await c.db.update(jobs).set({ tail: "You've hit your usage limit. Try again in 1 hour." }).where(running);
      if (before === 'a long refused turn') await c.db.update(jobs).set({ startedAt: new Date(Date.now() - 20 * 60_000) }).where(running);
    };
    await c.finish(c.bruno.id, refused, 'failed');
    return { ...c, rex: peer!, task };
  }

  it('gives the work to one of them who is on, with one note in the task', async () => {
    const { db, bruno, rex, task, turnsOf } = await withPeer();
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ executorAgentId: rex.id, assigneeAgentId: rex.id, status: 'open', silent: 0 });
    const notes = await db.select({ kind: taskEvents.kind, text: taskEvents.text }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), inArray(taskEvents.kind, ['assigned', 'continued', 'reminded'])));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('assigned');
    expect(notes[0]!.text).toMatch(/Bruno's plan is at its limit until .*, so Rex takes the work over on Codex\./);
    expect((await turnsOf(rex.id)).map(j => [j.taskId, j.status])).toEqual([[task.id, 'queued']]);
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
  });

  it("waits for the reset once Bruno's turns worked on it, as what he did may not be pushed yet", async () => {
    for (const before of ['a turn', 'a long refused turn'] as const) {
      const { db, bruno, rex, task, turnsOf } = await withPeer({}, before);
      expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0], before).toMatchObject({ executorAgentId: bruno.id, assigneeAgentId: bruno.id });
      expect(await turnsOf(rex.id), before).toEqual([]);
    }
  });

  it('waits for the reset when their plans are at their limits too', async () => {
    const { db, bruno, task, turnsOf } = await withPeer({ limited: true });
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ executorAgentId: bruno.id });
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toHaveLength(1);
  });

  it('waits for the reset when none of them could start now: signed out, its machine off or its node too old', async () => {
    for (const rex of [{ status: 'needs_login' as const }, { online: false }, { nodeVersion: '0.2.0' }]) {
      const { db, bruno, rex: peer, task, turnsOf } = await withPeer(rex);
      expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0], JSON.stringify(rex)).toMatchObject({ executorAgentId: bruno.id, assigneeAgentId: bruno.id });
      expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued'), JSON.stringify(rex)).toHaveLength(1);
      expect(await turnsOf(peer.id), JSON.stringify(rex)).toEqual([]);
    }
  });
});

describe('the turns a task move needs', () => {
  const later = () => new Date(Date.now() + 60_000);

  it('are kept with the move, so a server that stopped before queueing them still queues them', async () => {
    const c = await company();
    const task = await c.memberTask();
    expect(await c.turnsOf(c.bruno.id)).toEqual([]);
    expect(await wakeLeftBehind(c.ctx, later())).toBe(1);
    expect((await c.turnsOf(c.bruno.id)).map(j => j.taskId)).toEqual([task.id]);
    expect(await wakeLeftBehind(c.ctx, later())).toBe(0);
  });

  it('are forgotten once they are queued', async () => {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    expect(await wakeLeftBehind(c.ctx, later())).toBe(0);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(1);
  });

  it('wait for the next try when queueing one breaks, and the others still go out', async () => {
    const c = await company();
    const task = await c.memberTask();
    const publish = c.ctx.bus.publish.bind(c.ctx.bus);
    let broke = false;
    vi.spyOn(c.ctx.bus, 'publish').mockImplementation((companyId, m) => {
      if (m.type !== 'agent_event' || broke) return publish(companyId, m);
      broke = true;
      throw new Error('The stream broke.');
    });
    await wakeAll(c.ctx, [
      { agentId: c.bruno.id, taskId: task.id, why: 'assigned' },
      { agentId: c.head.id, taskId: task.id, why: 'blocked' },
    ]);
    expect(await c.turnsOf(c.head.id)).toHaveLength(1);
    expect(await wakeLeftBehind(c.ctx, later())).toBe(1);
    expect((await c.turnsOf(c.bruno.id)).map(j => j.taskId)).toEqual([task.id]);
  });

  it('are left out once the task moves on: a later move keeps the turns it needs itself', async () => {
    const c = await company();
    const dropped = await c.memberTask();
    await cancel(c.ctx, { agentId: c.head.id }, dropped.id, 'Not needed.');
    const handed = await c.memberTask();
    const [kai] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id }).returning();
    await updateTask(c.ctx, c.head.id, handed.id, { executor: kai!.id });
    expect(await wakeLeftBehind(c.ctx, later())).toBe(1);
    expect(await c.turnsOf(c.bruno.id)).toEqual([]);
    expect((await c.turnsOf(kai!.id)).map(j => j.taskId)).toEqual([handed.id]);
  });

  it('are left out for work cancelled together with the task above it', async () => {
    const c = await company();
    const task = await c.memberTask();
    const [kai] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id }).returning();
    await createTask(c.ctx, { agentId: c.head.id }, { title: 'Refunds', brief: '', body: '', departmentId: c.dev.id, parentId: task.id, assigneeAgentId: kai!.id, executor: true, gates: [] });
    await cancel(c.ctx, { agentId: c.head.id }, task.id, 'Not needed.');
    expect(await wakeLeftBehind(c.ctx, later())).toBe(0);
    expect(await c.turnsOf(kai!.id)).toEqual([]);
  });

  it('are queued by one sweep at a time', async () => {
    const c = await company();
    await c.memberTask();
    const swept = await Promise.all([wakeLeftBehind(c.ctx, later()), wakeLeftBehind(c.ctx, later())]);
    expect(swept[0]! + swept[1]!).toBe(1);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(1);
  });
});

describe('a task handed to another executor', () => {
  it('takes away the turns that waited for the one who held it before', async () => {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    const [kai] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id }).returning();
    await wakeAll(c.ctx, (await updateTask(c.ctx, c.head.id, task.id, { executor: kai!.id })).wakes);
    expect((await c.turnsOf(c.bruno.id)).map(j => ({ status: j.status, error: j.error }))).toEqual([{ status: 'failed', error: 'handed_on' }]);
    expect((await c.turnsOf(kai!.id)).map(j => j.status)).toEqual(['queued']);
  });
});

describe("Hornhoof's note that a task stands still", () => {
  async function stuck() {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.bruno.id);
    const [kai] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id }).returning();
    return { ...c, task, kai: kai! };
  }
  const requestsOf = (c: Awaited<ReturnType<typeof company>>) => c.db.select({ kind: requests.kind, status: requests.status }).from(requests);
  const taskOf = async (c: Awaited<ReturnType<typeof company>>, id: string) => (await c.db.select({ status: tasks.status, silent: tasks.silent }).from(tasks).where(eq(tasks.id, id)))[0];

  it('goes away when the head hands the task to someone else, who takes it up', async () => {
    const c = await stuck();
    const { wakes } = await updateTask(c.ctx, c.head.id, c.task.id, { executor: c.kai.id });
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'withdrawn' }]);
    expect(await taskOf(c, c.task.id)).toEqual({ status: 'open', silent: 0 });
    expect(wakes).toEqual([{ agentId: c.kai.id, taskId: c.task.id, why: 'assigned', cause: { actor: { agentId: c.head.id }, action: 'rewrote work', eventId: expect.any(Number), task: { id: c.task.id, number: c.task.number } } }]);
  });

  it('goes away when the executor hands its work in after all', async () => {
    const c = await stuck();
    await submit(c.ctx, c.bruno.id, c.task.id, { summary: 'Done.', evidence: 'npm test: 12 passed' });
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'withdrawn' }]);
    expect(await taskOf(c, c.task.id)).toMatchObject({ status: 'review' });
  });

  it('goes away when the agent reports a task it owns', async () => {
    const c = await company();
    const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Plan the sprint', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id });
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.bruno.id);
    await report(c.ctx, c.bruno.id, task.id, { done: true, summary: 'Planned.' });
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'withdrawn' }]);
  });

  it('still keeps a question the agent asked a person', async () => {
    const c = await stuck();
    await c.db.update(requests).set({ status: 'answered' });
    await c.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, c.task.id));
    await ask(c.ctx, c.bruno.id, c.task.id, { kind: 'question', text: 'EUR or USD?' });
    await expect(submit(c.ctx, c.bruno.id, c.task.id, { summary: 'Done.', evidence: 'npm test' })).rejects.toThrow(/waits for a person's answer/);
  });

  it('asks the orchestrator to put the note into plain words for people', async () => {
    const c = await stuck();
    const [note] = await c.db.select({ id: requests.id }).from(requests);
    const asked = (await c.turnsOf(c.orchestrator.id)).filter(j => j.prompt.includes(note!.id));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toContain('explain_request');
  });

  it('wakes whoever holds the task now when a person says try again', async () => {
    const c = await stuck();
    /* Handed on before Hornhoof let such notes go. */
    await c.db.update(tasks).set({ executorAgentId: c.kai.id, assigneeAgentId: c.kai.id }).where(eq(tasks.id, c.task.id));
    const [note] = await c.db.select({ id: requests.id }).from(requests);
    const { wakes } = await answer(c.ctx, { personId: c.ceo.id }, note!.id, { retry: true });
    expect(wakes.map(w => w.agentId)).toEqual([c.kai.id]);
  });
});

describe('waking agents for their tasks', () => {
  it('queues one turn per agent and task, naming the task', async () => {
    const { ctx, bruno, memberTask, turnsOf } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [
      { agentId: bruno.id, taskId: task.id, why: 'assigned' },
      { agentId: bruno.id, taskId: task.id, why: 'comment', text: 'EUR only.' },
    ]);
    const queued = await turnsOf(bruno.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ taskId: task.id, status: 'queued', kind: 'conversation' });
    expect(queued[0]!.prompt).toContain('#1 "Checkout API"');
    expect(queued[0]!.timeoutMs).toBe(2 * 3_600_000);
  });

  it('marks a task working when its turn starts', async () => {
    const { ctx, db, bruno, memberTask } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const [job] = await db.select().from(jobs).where(eq(jobs.taskId, task.id));
    await startWork(ctx, job!.id);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('working');
  });

  it('reminds an agent that ended a turn without moving its task, then asks a person', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 1; i < SILENT_TURNS; i++) {
      await finish(bruno.id);
      const queued = (await turnsOf(bruno.id)).filter(j => j.status === 'queued');
      expect(queued).toHaveLength(1);
      expect(queued[0]!.prompt).toContain('without moving it');
    }
    await finish(bruno.id);
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'waiting', silent: SILENT_TURNS });
    expect(await db.select({ kind: requests.kind, agentId: requests.agentId }).from(requests)).toEqual([{ kind: 'stuck', agentId: bruno.id }]);
  });

  it('lets an agent that told in the task how far it got go on in another turn, not counted as standing still', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS + 1; i++) await finish(bruno.id, () => comment(ctx, { agentId: bruno.id }, task.id, `Part ${i} pushed.`));
    const queued = (await turnsOf(bruno.id)).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain('Go on with the work from where you left off');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'open', silent: 0 });
    expect(await db.select().from(requests)).toEqual([]);
  });

  it('lets an agent whose turn ran out of time while it worked go on', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const outOfTime = () => db.update(jobs).set({ error: 'timeout' }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    for (let i = 0; i < SILENT_TURNS; i++) await finish(bruno.id, outOfTime, 'failed');
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toHaveLength(1);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(0);
  });

  it('asks a person once an agent went on for many turns without handing anything in', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < GOING_ON_TURNS; i++) await finish(bruno.id, () => comment(ctx, { agentId: bruno.id }, task.id, `Part ${i} pushed.`));
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect(await db.select({ kind: requests.kind, status: requests.status }).from(requests)).toEqual([{ kind: 'stuck', status: 'open' }]);
  });

  it('does not count a turn that broke as standing still: the agent goes on, and nobody is reminded', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    /* It worked for ten minutes before its program broke. */
    const longAgo = () => db.update(jobs).set({ error: 'agent_failed', startedAt: new Date(Date.now() - 10 * 60_000) }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    for (let i = 0; i < SILENT_TURNS + 1; i++) await finish(bruno.id, longAgo, 'failed');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'open', silent: 0 });
    expect(await db.select({ kind: taskEvents.kind }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'reminded')))).toEqual([]);
    expect(await db.select().from(requests)).toEqual([]);
    const queued = (await turnsOf(bruno.id)).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain('Go on with the work from where you left off');
  });

  it.each([
    ['instructions_too_long', "Bruno's instructions are 200857 characters, more than the 200000 a turn carries, so this turn did not go out."],
    ['node_too_old', "This machine's node is too old for these instructions; update it."],
  ])('blocks the task for its head at the first turn that could not go out for the length of its instructions (%s)', async (error, why) => {
    const { ctx, db, head, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const refused = () => db.update(jobs).set({ error, result: why }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    await finish(bruno.id, refused, 'failed');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('blocked');
    const [note] = await db.select({ kind: taskEvents.kind, text: taskEvents.text }).from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(desc(taskEvents.id)).limit(1);
    expect(note).toEqual({ kind: 'blocked', text: why });
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect((await turnsOf(head.id)).filter(j => j.status === 'queued')[0]!.prompt).toContain(why);
  });

  it('blocks the task for its head once, with the error, after three turns on it in a row broke at once', async () => {
    const { ctx, db, head, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const crash = () => db.update(jobs).set({ error: 'agent_failed', tail: 'Error: the program exited with code 1' }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    const read = async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    for (let i = 0; i < 2; i++) await finish(bruno.id, crash, 'failed');
    expect((await read()).status).toBe('open');
    await finish(bruno.id, crash, 'failed');
    expect((await read()).status).toBe('blocked');
    const [note] = await db.select({ kind: taskEvents.kind, text: taskEvents.text }).from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(desc(taskEvents.id)).limit(1);
    expect(note!.kind).toBe('blocked');
    expect(note!.text).toContain('broke within');
    expect(note!.text).toContain('the program exited with code 1');
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    const told = (await turnsOf(head.id)).filter(j => j.status === 'queued');
    expect(told).toHaveLength(1);
    expect(told[0]!.prompt).toContain('cannot go on');
    expect(told[0]!.prompt).toContain('the program exited with code 1');
    expect(await db.select().from(requests)).toEqual([]);
    /* Once the head answers, the count starts again. */
    await wakeAll(ctx, (await updateTask(ctx, head.id, task.id, { body: 'Use the other provider.' })).wakes);
    await finish(bruno.id, crash, 'failed');
    expect((await read()).status).toBe('open');
  });

  it("does not block the task when its turns ended on Kimi's quota running out", async () => {
    const { ctx, db, bruno, memberTask, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const quota = () =>
      db.update(jobs).set({ error: 'agent_failed', tail: '{"type":"error","code":"provider.api_error","message":"You exceeded your current token quota","name":"APIProviderQuotaExhaustedError","details":{"statusCode":429,"requestId":null,"traceId":null}}' }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    for (let i = 0; i < 3; i++) await finish(bruno.id, quota, 'failed');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('open');
  });

  it('does not count a turn that broke because its machine started again', async () => {
    const { ctx, db, bruno, memberTask, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const restarted = () => db.update(jobs).set({ error: 'machine_restarted', startedAt: new Date(Date.now() - 10 * 60_000) }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    await finish(bruno.id, restarted, 'failed');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(0);
  });

  it('wakes nobody again after a turn that moved the task', async () => {
    const { ctx, db, bruno, rita, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await finish(bruno.id, async () => wakeAll(ctx, (await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' })).wakes));
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect((await turnsOf(rita.id)).map(j => j.taskId)).toEqual([task.id]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(0);
  });

  it('reminds an agent about a task it left without moving, though a turn on another task waits', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const first = await memberTask();
    const second = await memberTask();
    await wakeAll(ctx, [
      { agentId: bruno.id, taskId: first.id, why: 'assigned' },
      { agentId: bruno.id, taskId: second.id, why: 'assigned' },
    ]);
    await finish(bruno.id);
    expect((await db.select().from(tasks).where(eq(tasks.id, first.id)))[0]!.silent).toBe(1);
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued').map(j => j.taskId).sort()).toEqual([first.id, second.id].sort());
  });

  it('leaves the count alone while a turn on the same task waits', async () => {
    const { ctx, db, bruno, memberTask, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await finish(bruno.id, () => wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'comment', text: 'EUR only.' }]));
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(0);
  });

  it('wakes an employee for its waiting tasks when it gets a subscription again', async () => {
    const { app, owner, ctx, db, sub, bruno, memberTask, turnsOf } = await company();
    const task = await memberTask();
    await db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, bruno.id));
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    expect(await turnsOf(bruno.id)).toEqual([]);
    const patched = await app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { subscription: sub.id }, ...as(owner) });
    expect(patched.statusCode).toBe(200);
    expect((await turnsOf(bruno.id)).map(j => j.taskId)).toEqual([task.id]);
  });

  it('wakes the orchestrator for his waiting tasks when he gets a subscription again', async () => {
    const { app, owner, ctx, db, sub, ceo, orchestrator, turnsOf } = await company();
    const { task } = await createTask(ctx, { personId: ceo.id }, { title: 'Turn 1: Launch', brief: '', body: '', departmentId: null, assigneeAgentId: orchestrator.id });
    await db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, orchestrator.id));
    await wakeAll(ctx, [{ agentId: orchestrator.id, taskId: task.id, why: 'assigned' }]);
    expect(await turnsOf(orchestrator.id)).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${sub.id}/orchestrator`, ...as(owner) })).statusCode).toBe(200);
    expect((await turnsOf(orchestrator.id)).map(j => j.taskId)).toEqual([task.id]);
  });

  it('wakes nobody when an agent moves from one subscription to another', async () => {
    const { app, owner, ctx, sub, ceo, orchestrator, turnsOf } = await company();
    await createTask(ctx, { personId: ceo.id }, { title: 'Turn 1: Launch', brief: '', body: '', departmentId: null, assigneeAgentId: orchestrator.id });
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${sub.id}/orchestrator`, ...as(owner) })).statusCode).toBe(200);
    expect(await turnsOf(orchestrator.id)).toEqual([]);
  });

  it("tells the orchestrator to go on with a department's task that cannot by the tools he has", async () => {
    const { ctx, dev, head, orchestrator } = await company();
    const { task } = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Payments', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    const prompt = wakePrompt(orchestrator, task, { agentId: orchestrator.id, taskId: task.id, why: 'blocked', text: 'No designer.' });
    expect(prompt).not.toContain('update_task');
    expect(prompt).toContain('cancel_task');
    expect(prompt).toContain('add_tasks');
    expect(prompt).not.toContain('create_task');
    expect(prompt).toContain('No designer.');
  });

  it('lets a head wait for the tasks it gave out', async () => {
    const { ctx, ceo, dev, head, bruno, turnsOf, finish } = await company();
    const { task } = await createTask(ctx, { personId: ceo.id }, { title: 'Payments', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    await wakeAll(ctx, [{ agentId: head.id, taskId: task.id, why: 'assigned' }]);
    await finish(head.id, () => createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, parentId: task.id, assigneeAgentId: bruno.id, executor: true }));
    await wakeAll(ctx, [{ agentId: head.id, taskId: task.id, why: 'comment', text: 'How is it going?' }]);
    await finish(head.id);
    expect((await turnsOf(head.id)).filter(j => j.status === 'queued')).toEqual([]);
  });
});

const NODE_KEY = 'k'.repeat(40);
type Run = { type: 'job.run'; jobId: string; prompt: string; workspace?: { key: string; repo: { url: string; branch: string; token: string; author: { name: string; email: string } | null } | null } | null };

async function nextRun(node: FakeNode): Promise<Run> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as Run;
}

/* A company on the built-in node, with Development and its product Shop. */
async function withRepositories() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [shop] = await db.insert(departments).values({ companyId, name: 'Shop', parentId: dev!.id, roleCode: 'DEV', position: 1 }).returning();
  const hire = async (name: string, productId: string | null, subscriptionId = sub!.id) =>
    (await db.insert(agents).values({ companyId, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: dev!.id, productId, model: '', subscriptionId }).returning())[0]!;
  const repository = (id: string, payload: object) => app.inject({ method: 'PUT', url: `/api/departments/${id}/repository`, payload, ...as(ceo) });
  const task = async (agentId: string) => (await createTask(app.ctx, { agentId }, { title: 'Checkout API', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: agentId, executor: true })).task;
  return { app, db, url, ceo, builtin, ctx: app.ctx, companyId, dev: dev!, shop: shop!, hire, repository, task };
}

describe("a plan's share for tasks", () => {
  const used = (utilization: number, resetsAt: string) => ({ status: 'allowed' as const, windows: [{ name: 'five_hour', utilization, resetsAt }] });
  /* Bruno on the built-in node's key, which used most of its five hours. */
  async function plan(utilization: number) {
    const r = await withRepositories();
    const bruno = await r.hire('Bruno', null);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await r.db.update(subscriptions).set({ budget: 80, limits: used(utilization, resetsAt) });
    return { ...r, bruno, resetsAt };
  }

  it('holds task turns once a window of the plan used the share set for tasks, and says until when', async () => {
    const { ctx, db, builtin, bruno, task, resetsAt } = await plan(0.85);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: (await task(bruno.id)).id, why: 'assigned' }]);
    await new Promise(r => setTimeout(r, 300));
    expect(builtin.queued()).toBe(0);
    expect((await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.agentId, bruno.id)))).toEqual([{ status: 'queued' }]);
    expect(await agentState(ctx, bruno.id)).toMatchObject({ budgetUntil: resetsAt, limitUntil: null });
  });

  it("still sends a person's own message on such a plan", async () => {
    const { ctx, builtin, bruno, companyId } = await plan(0.85);
    const [person] = await ctx.db.select({ id: people.id }).from(people);
    await enqueueTurn(ctx, { companyId, agentId: bruno.id, prompt: 'Ivan (CEO): How far are you?', createdBy: person!.id });
    expect((await nextRun(builtin)).prompt).toContain('How far are you?');
  });

  it('sends task turns below the share', async () => {
    const { ctx, builtin, bruno, task } = await plan(0.5);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: (await task(bruno.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).prompt).toContain('Checkout API');
    expect(await agentState(ctx, bruno.id)).toMatchObject({ budgetUntil: null });
  });
});

describe('a head', () => {
  it('reads everything that moved on its tasks while it was busy in one turn, not one turn per task', async () => {
    const { ctx, db, builtin, dev, companyId } = await withRepositories();
    const [sub] = await db.select().from(subscriptions);
    const staff = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
      (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const head = await staff('Hana', 'head', 'DEV-HEAD');
    const bruno = await staff('Bruno', 'worker', 'DEV-BE');
    const given = async (title: string) => (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true })).task;
    const [busy] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: head.id, kind: 'conversation', prompt: 'Plan the turn.', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    const [checkout, refund, invoice] = [await given('Checkout API'), await given('Refund email'), await given('Invoice PDF')];
    await wakeAll(ctx, [
      { agentId: head.id, taskId: checkout.id, why: 'blocked', text: 'The payment keys are missing.' },
      { agentId: head.id, taskId: refund.id, why: 'done' },
      { agentId: head.id, taskId: invoice.id, why: 'reported', text: 'Shipped.' },
    ]);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, busy!.id));
    await afterJob(ctx, busy!.id);
    const run = await nextRun(builtin);
    for (const said of ['#1 "Checkout API"', 'The payment keys are missing.', '#2 "Refund email"', '#3 "Invoice PDF"', 'Shipped.']) expect(run.prompt).toContain(said);
    expect((await db.select().from(jobs).where(and(eq(jobs.agentId, head.id), eq(jobs.status, 'queued'))))).toEqual([]);
  });

  /* Hana, a head with a turn running, so that what wakes her waits and goes out in one turn. */
  async function busyHead() {
    const { ctx, db, builtin, dev, companyId } = await withRepositories();
    const [sub] = await db.select().from(subscriptions);
    const staff = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
      (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const head = await staff('Hana', 'head', 'DEV-HEAD');
    const [busy] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: head.id, kind: 'conversation', prompt: 'Plan the turn.', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    const held = async (title: string) => (await createTask(ctx, { personId: sub!.ownerPersonId! }, { title, brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id })).task;
    /* What woke her goes out in one turn, which ends as the test says. */
    const together = async (taskIds: string[], ended: { status: 'done' | 'failed'; error?: string }, during: () => Promise<unknown> = async () => {}, why: 'assigned' | 'done' = 'assigned') => {
      await wakeAll(ctx, taskIds.map(taskId => ({ agentId: head.id, taskId, why })));
      await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, busy!.id));
      await afterJob(ctx, busy!.id);
      const run = await nextRun(builtin);
      expect(run.prompt).toContain('Several of your tasks moved while you were busy');
      await during();
      await db.update(jobs).set({ ...ended, finishedAt: new Date() }).where(eq(jobs.id, run.jobId));
      await afterJob(ctx, run.jobId);
    };
    const reminded = async (taskId: string) => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'reminded')))).length;
    return { ctx, db, dev, head, staff, held, together, reminded };
  }

  it('comes back to every task that went out in a turn that failed, not only the first', async () => {
    const { db, held, together, reminded } = await busyHead();
    const [payments, refunds] = [await held('Payments'), await held('Refunds')];
    await together([payments.id, refunds.id], { status: 'failed', error: 'agent_failed' });
    /* A turn that broke is no silence: each of them goes on. */
    const wentOn = async (taskId: string) => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'continued')))).length;
    expect([await wentOn(payments.id), await wentOn(refunds.id)]).toEqual([1, 1]);
    expect([await reminded(payments.id), await reminded(refunds.id)]).toEqual([0, 0]);
  });

  it('runs a turn a node restart cut off once more for its own task, and the tasks that went along with it go on', async () => {
    const { db, held, together, reminded } = await busyHead();
    const [payments, refunds] = [await held('Payments'), await held('Refunds')];
    await together([payments.id, refunds.id], { status: 'failed', error: 'machine_restarted' });
    const count = async (taskId: string, kind: 'continued' | 'interrupted') => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, kind)))).length;
    /* Its own task gets the retry, which waits on it, so it does not go on a second way. */
    expect([await count(payments.id, 'interrupted'), await count(payments.id, 'continued')]).toEqual([1, 0]);
    expect((await db.select({ taskId: jobs.taskId }).from(jobs).where(isNotNull(jobs.retryOf))).map(j => j.taskId)).toEqual([payments.id]);
    expect([await count(refunds.id, 'interrupted'), await count(refunds.id, 'continued')]).toEqual([0, 1]);
    expect([await reminded(payments.id), await reminded(refunds.id)]).toEqual([0, 0]);
  });

  it('reminds it of a task that went out with others and that it left where it was', async () => {
    const { ctx, head, held, together, reminded } = await busyHead();
    const [payments, refunds] = [await held('Payments'), await held('Refunds')];
    await together([payments.id, refunds.id], { status: 'done' }, () => report(ctx, head.id, payments.id, { done: false, summary: 'Asked the bank for keys.' }));
    expect([await reminded(payments.id), await reminded(refunds.id)]).toEqual([0, 1]);
  });

  it('reminds it once of a task whose two finished parts went out in one turn', async () => {
    const { ctx, db, dev, head, staff, held, together, reminded } = await busyHead();
    const payments = await held('Payments');
    const bruno = await staff('Bruno', 'worker', 'DEV-BE');
    const part = async (title: string) => (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev.id, parentId: payments.id, assigneeAgentId: bruno.id, executor: true })).task;
    const [checkout, refund] = [await part('Checkout API'), await part('Refund email')];
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(inArray(tasks.id, [checkout.id, refund.id]));
    await together([checkout.id, refund.id], { status: 'done' }, undefined, 'done');
    expect(await reminded(payments.id)).toBe(1);
  });
});

describe("working in the product's repository", () => {
  it("sends an agent's turn with its product's repository, else its department's, and each agent its own folder", async () => {
    const { ctx, builtin, dev, shop, hire, repository, task } = await withRepositories();
    expect((await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111' })).statusCode).toBe(200);
    expect((await repository(shop.id, { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222' })).statusCode).toBe(200);
    const bruno = await hire('Bruno', shop.id);
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: (await task(bruno.id)).id, why: 'assigned' }]);
    const first = await nextRun(builtin);
    expect(first.workspace).toEqual({ key: bruno.id, repo: { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222', author: null } });
    expect(first.prompt).toContain('https://github.com/acme/shop.git');
    expect(first.prompt).toContain('./shop');
    expect(first.prompt).not.toContain('ghp_');
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).workspace).toEqual({ key: pia.id, repo: { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111', author: null } });
  });

  it('tells the agent who its commits are by, and to add no co-author lines', async () => {
    const { ctx, builtin, dev, hire, repository, task } = await withRepositories();
    const author = { name: 'Ivan Korol', email: 'ivan@acme.dev' };
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main', author });
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    const run = await nextRun(builtin);
    expect(run.workspace?.repo?.author).toEqual(author);
    expect(run.prompt).toContain('Commit as Ivan Korol <ivan@acme.dev>');
    expect(run.prompt).toContain('Co-Authored-By');
  });

  it('tells an agent started for its window where its repository is, with its instructions', async () => {
    const { builtin, dev, hire, repository } = await withRepositories();
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main' });
    const pia = await hire('Pia', null);
    builtin.send({ type: 'agent.start', agentKey: pia.id });
    const start = (await nextRun(builtin)) as Run & { context?: string | null; guidance?: string | null };
    expect(start.prompt).toBe('');
    /* Apart from the conversation, which the node keeps with the session: the repository can change. */
    expect(start.guidance).toContain('https://github.com/acme/platform.git');
    expect(start.guidance).toContain('./platform');
    expect(start.guidance).toContain('read its own rules first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md)');
    /* Anyone who can push to a branch writes those files, so they never stand above Hornhoof's rules. */
    expect(start.guidance).not.toContain('come before your skills');
    expect(start.guidance).toContain('never rank above your skills');
    expect(start.context ?? '').not.toContain('platform');
  });

  it('sends a turn without a repository with the agent folder alone', async () => {
    const { ctx, builtin, hire, task } = await withRepositories();
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).workspace).toEqual({ key: pia.id, repo: null });
  });

  it('keeps a turn with a repository waiting for a machine whose Hornhoof is too old to clone it', async () => {
    const { app, db, url, ceo, ctx, dev, hire, repository, task } = await withRepositories();
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' } });
    const node = joined.json().nodes[0] as { subscriptionId: string; key: string };
    const mac = await connectNode(url, node.key);
    mac.send({ type: 'hello', version: '0.4.0', loggedIn: true, running: [] });
    await until(async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, node.subscriptionId)))[0]!.status === 'ready');
    const olga = await hire('Olga', null, node.subscriptionId);
    await wakeAll(ctx, [{ agentId: olga.id, taskId: (await task(olga.id)).id, why: 'assigned' }]);
    expect((await nextRun(mac)).workspace).toEqual({ key: olga.id, repo: null });
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main' });
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, olga.id));
    await wakeAll(ctx, [{ agentId: olga.id, taskId: (await task(olga.id)).id, why: 'assigned' }]);
    await new Promise(r => setTimeout(r, 150));
    expect(mac.queued()).toBe(0);
    expect((await app.inject({ url: `/api/agents/${olga.id}/events`, ...as(ceo) })).json().state.reason).toBe('node_outdated');
  });
});

/* Real dispatch after an agent's long turn, with task wakes held behind it. */
async function busyQueue() {
  const c = await company({ NODE_KEY });
  const builtin = await connectNode(await listen(c.app), NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(() => c.ctx.hub.isReady(identityOf(c.sub, null)!));
  const hold = async (agentId: string) => (await c.db.insert(jobs).values({ companyId: c.dev.companyId, subscriptionId: c.sub.id, agentId, kind: 'conversation', prompt: 'A long turn.', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning())[0]!;
  const busy = await hold(c.bruno.id);
  const release = async (id = busy.id) => {
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, id));
    await afterJob(c.ctx, id);
  };
  const close = async (ids: string[], status: 'done' | 'cancelled' = 'done') => c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(inArray(tasks.id, ids));
  return { ...c, builtin, hold, release, close };
}

describe('obsolete task turns', () => {
  it.each(['done', 'cancelled'] as const)('drops the three queued assignment and merge turns after their tasks are %s', async status => {
    const c = await busyQueue();
    const [first, second, merge] = await Promise.all([c.memberTask([]), c.memberTask([]), c.memberTask([])]);
    await c.db.update(tasks).set({ merging: true }).where(eq(tasks.id, merge!.id));
    await wakeAll(c.ctx, [
      { agentId: c.bruno.id, taskId: first!.id, why: 'assigned' },
      { agentId: c.bruno.id, taskId: second!.id, why: 'assigned' },
      { agentId: c.bruno.id, taskId: merge!.id, why: 'merge', text: 'turn-4' },
    ]);
    const queued = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(3);
    /* These are the old rows of the incident, before wake snapshots existed. */
    await c.db.update(agentEvents).set({ data: sql`${agentEvents.data} - 'taskWake'` }).where(inArray(agentEvents.jobId, queued.map(j => j.id)));
    await c.close([first!.id, second!.id, merge!.id], status);
    const next = await enqueueTurn(c.ctx, { companyId: c.dev.companyId, agentId: c.bruno.id, prompt: 'A new message.', createdBy: c.ceo.id });
    await c.release();

    expect((await nextRun(c.builtin)).jobId).toBe(next);
    expect(c.builtin.queued()).toBe(0);
    for (const [i, task] of [first!, second!, merge!].entries()) {
      const [stale] = await c.db.select().from(jobs).where(eq(jobs.id, queued[i]!.id));
      expect(stale).toMatchObject({ status: 'failed', error: 'stale', startedAt: null });
      expect(stale!.result).toContain(`#${task.number}`);
      expect((await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, stale!.id), eq(agentEvents.kind, 'stopped')))).map(e => e.data)).toEqual([
        { reason: 'stale', text: stale!.result, task: { id: task.id, number: task.number } },
      ]);
    }
  });

  it('drops a late merge signal before it queues a turn, and forgets the kept signal', async () => {
    const c = await busyQueue();
    const task = await c.memberTask([]);
    await c.close([task.id]);
    await c.db.insert(pendingWakes).values({ companyId: task.companyId, agentId: c.bruno.id, taskId: task.id, why: 'merge', createdAt: new Date(Date.now() - 60_000) });
    await wakeLeftBehind(c.ctx, new Date(Date.now() + 60_000));
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect(await c.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, task.id))).toEqual([]);
  });

  it('keeps comments on a done task in its log without waking its executor or reviewers', async () => {
    const c = await company();
    const task = await c.memberTask();
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: c.bruno.id, panel: [c.rita.id] }).where(eq(tasks.id, task.id));
    for (const actor of [{ personId: c.ceo.id }, { agentId: c.head.id }]) {
      const moved = await comment(c.ctx, actor, task.id, 'A note for the turn review.');
      expect(moved.wakes).toEqual([]);
      await wakeAll(c.ctx, moved.wakes);
    }
    expect(await c.turnsOf(c.bruno.id)).toEqual([]);
    expect(await c.turnsOf(c.rita.id)).toEqual([]);
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'comment'))))).toHaveLength(2);
  });

  it('still wakes the executor when its head answers a blocked task', async () => {
    const c = await company();
    const task = await c.memberTask();
    await blocked(c.ctx, c.bruno.id, task.id, 'Which schema?');
    const moved = await comment(c.ctx, { agentId: c.head.id }, task.id, 'Use the current schema.');
    await wakeAll(c.ctx, moved.wakes);
    expect(moved.task.status).toBe('open');
    expect((await c.turnsOf(c.bruno.id)).map(j => j.prompt)).toEqual([expect.stringContaining('Use the current schema.')]);
  });

  it.each(['done', 'reported', 'reviewed', 'review_passed'] as const)('preserves the %s notice to the head after a task closes', async why => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const task = await c.memberTask([]);
    await c.close([task.id]);
    await wakeAll(c.ctx, [{ agentId: c.head.id, taskId: task.id, why, text: 'The checks passed.' }]);
    const [queued] = (await c.turnsOf(c.head.id)).filter(j => j.status === 'queued');
    expect(queued).toBeDefined();
    await c.release(held.id);
    expect((await nextRun(c.builtin)).jobId).toBe(queued!.id);
  });

  it.each([
    { name: 'another executor', set: { assigneeAgentId: null } },
    { name: 'work already started', set: { status: 'working' as const } },
    { name: 'the merge phase', set: { merging: true } },
  ])('drops an assignment that now belongs to $name', async ({ set }) => {
    const c = await busyQueue();
    const task = await c.memberTask([]);
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    const [queued] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    await c.db.update(tasks).set(set).where(eq(tasks.id, task.id));
    await c.release();
    expect(c.builtin.queued()).toBe(0);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ status: 'failed', error: 'stale', startedAt: null });
  });

  it('drops a review from a previous stage even when the same reviewer is on the next panel', async () => {
    const c = await busyQueue();
    const held = await c.hold(c.rita.id);
    const task = await c.memberTask();
    await c.db.update(tasks).set({ status: 'review', stage: 1, panel: [c.rita.id], assigneeAgentId: c.rita.id }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c.rita.id, taskId: task.id, why: 'review' }]);
    const [queued] = (await c.turnsOf(c.rita.id)).filter(j => j.status === 'queued');
    await c.db.update(tasks).set({ stage: 2 }).where(eq(tasks.id, task.id));
    await c.release(held.id);
    expect(c.builtin.queued()).toBe(0);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it('still dispatches a current assignment after the busy turn ends', async () => {
    const c = await busyQueue();
    const task = await c.memberTask([]);
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'comment', text: 'The same current work.' }]);
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toHaveLength(1);
    const [queued] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    const ran = statements();
    await c.release();
    expect((await nextRun(c.builtin)).jobId).toBe(queued!.id);
    /* PGlite has one connection: the executed row lock proves the Postgres claim cannot race a task move. */
    const locked = ran.find(s => s.sql.includes('from "tasks"') && s.sql.includes('for share'));
    expect(locked?.params).toContain(task.id);
  });

  it('checks the task again at take if it closes while instructions are being built', async () => {
    const c = await busyQueue();
    const task = await c.memberTask([]);
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    const [queued] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    const next = await enqueueTurn(c.ctx, { companyId: task.companyId, agentId: c.bruno.id, prompt: 'A current message.', createdBy: c.ceo.id });
    const build = instructionBuilder.instructionsOf;
    vi.spyOn(instructionBuilder, 'instructionsOf').mockImplementationOnce(async (...args) => {
      const instructions = await build(...args);
      await c.close([task.id]);
      return instructions;
    });
    await c.release();
    expect((await nextRun(c.builtin)).jobId).toBe(next);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it.each(['before preparation', 'during preparation'] as const)('drops an obsolete task from a head combined turn, %s, and keeps the completed child notice', async timing => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const own = async (title: string) => (await createTask(c.ctx, { personId: c.ceo.id }, { title, brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
    const current = await own('Current work');
    const old = await own('Obsolete work');
    const child = await c.memberTask([]);
    await c.close([child.id]);
    await wakeAll(c.ctx, [
      { agentId: c.head.id, taskId: current.id, why: 'assigned' },
      { agentId: c.head.id, taskId: old.id, why: 'assigned' },
      { agentId: c.head.id, taskId: child.id, why: 'done' },
    ]);
    if (timing === 'before preparation') await c.close([old.id]);
    else {
      const build = instructionBuilder.instructionsOf;
      vi.spyOn(instructionBuilder, 'instructionsOf').mockImplementationOnce(async (...args) => {
        const instructions = await build(...args);
        await c.close([old.id]);
        return instructions;
      });
    }
    await c.release(held.id);
    const run = await nextRun(c.builtin);
    expect(run.prompt).toContain('Current work');
    expect(run.prompt).toContain(`#${child.number} "Checkout API"`);
    expect(run.prompt).not.toContain('Obsolete work');
    expect((await c.db.select().from(jobs).where(eq(jobs.taskId, old.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it('drops a head update after the task it created is handed to another holder', async () => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const task = await c.memberTask([]);
    await c.db.update(tasks).set({ assigneeAgentId: c.head.id }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c.head.id, taskId: task.id, why: 'updated' }]);
    const [queued] = (await c.turnsOf(c.head.id)).filter(j => j.status === 'queued');
    await c.db.update(tasks).set({ assigneeAgentId: c.bruno.id }).where(eq(tasks.id, task.id));
    await c.release(held.id);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it('drops a legacy task turn when its worker also created the task', async () => {
    const c = await busyQueue();
    const task = await c.memberTask([]);
    await c.db.update(tasks).set({ createdByAgentId: c.bruno.id }).where(eq(tasks.id, task.id));
    const queued = await enqueueTurn(c.ctx, { companyId: task.companyId, agentId: c.bruno.id, taskId: task.id, prompt: 'An old assignment.', createdBy: null });
    await c.close([task.id]);
    await c.release();
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it('still dispatches a current legacy task turn', async () => {
    const c = await busyQueue();
    const task = await c.memberTask([]);
    const [queued] = await c.db.insert(jobs).values({ companyId: task.companyId, subscriptionId: c.sub.id, agentId: c.bruno.id, taskId: task.id, kind: 'conversation', prompt: 'A current legacy assignment.', timeoutMs: 900000 }).returning();
    await c.release();
    expect((await nextRun(c.builtin)).jobId).toBe(queued!.id);
  });

  it('still dispatches a legacy completion notice to the giver', async () => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const task = await c.memberTask([]);
    await c.close([task.id]);
    const queued = await enqueueTurn(c.ctx, { companyId: task.companyId, agentId: c.head.id, taskId: task.id, prompt: wakePrompt(c.head, task, { agentId: c.head.id, taskId: task.id, why: 'done' }), createdBy: null });
    await c.release(held.id);
    expect((await nextRun(c.builtin)).jobId).toBe(queued);
  });

  it.each(['blocked', 'stuck_at_gate', 'tests', 'work'] as const)('preserves current %s news for the giver', async why => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const task = await c.memberTask([]);
    await wakeAll(c.ctx, [{ agentId: c.head.id, taskId: task.id, why, text: 'Current news.' }]);
    const [queued] = (await c.turnsOf(c.head.id)).filter(j => j.status === 'queued');
    expect(queued).toBeDefined();
    await c.release(held.id);
    expect((await nextRun(c.builtin)).jobId).toBe(queued!.id);
  });

  it.each([
    { why: 'assigned', status: 'blocked', merging: false, stage: 0, holder: 'bruno', receiver: 'bruno', panel: [] },
    { why: 'merge', status: 'open', merging: false, stage: 0, holder: 'bruno', receiver: 'bruno', panel: [] },
    { why: 'merge', status: 'open', merging: true, stage: 0, holder: 'head', receiver: 'bruno', panel: [] },
    { why: 'review', status: 'open', merging: false, stage: 0, holder: 'bruno', receiver: 'rita', panel: ['rita'] },
    { why: 'review', status: 'review', merging: false, stage: 1, holder: 'bruno', receiver: 'rita', panel: ['bruno'] },
  ] as const)('rejects $why before queueing when its current phase or recipient does not match ($status, $holder)', async ({ why, status, merging, stage, holder, receiver, panel }) => {
    const c = await company();
    const task = await c.memberTask([]);
    await c.db.update(tasks).set({ status, merging, stage, assigneeAgentId: c[holder].id, panel: panel.map(p => c[p].id) }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c[receiver].id, taskId: task.id, why }]);
    expect(await c.turnsOf(c[receiver].id)).toEqual([]);
  });

  it('resumes current working tasks when the agent gets its subscription back', async () => {
    const c = await company();
    const task = await c.memberTask([]);
    await c.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, task.id));
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.bruno.id));
    const response = await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.bruno.id}`, payload: { subscription: c.sub.id }, ...as(c.owner) });
    expect(response.statusCode).toBe(200);
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toHaveLength(1);
  });

  it('discards obsolete work even if its instructions can no longer be built', async () => {
    const c = await busyQueue();
    const task = await c.memberTask([]);
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    await c.close([task.id]);
    vi.spyOn(instructionBuilder, 'instructionsOf').mockRejectedValue(new Error('These obsolete instructions are unavailable.'));
    await c.release();
    expect(c.builtin.queued()).toBe(0);
    expect((await c.db.select().from(jobs).where(eq(jobs.taskId, task.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });
});
