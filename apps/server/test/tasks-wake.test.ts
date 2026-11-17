import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { idOnly } from '../src/db/selections.js';
import * as instructionBuilder from '../src/modules/agents/instructions.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, machines, nodes, pendingWakes, people, personAccess, requests, subscriptions, taskEvents, tasks, teams } from '../src/db/schema.js';
import { agentState, enqueueTurn } from '../src/modules/conversation/queue.js';
import { said } from '../src/modules/conversation/live.js';
import { identityOf, type NodeIdentity } from '../src/modules/nodes/hub.js';
import { ask, blocked, cancel, comment, createTask, GOING_ON_TURNS, report, SILENT_TURNS, startWork, submit, updateTask, verdict, type NewTask } from '../src/modules/tasks/engine.js';
import { afterJob, typedTurn, wakeAll, wakeLeftBehind, wakePrompt } from '../src/modules/tasks/wake.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { as, connectNode, listen, setUpCompany, statements, testApp, until, type FakeNode, echelonsTurn } from './helpers.js';
import { BUILTIN } from './builtin.js';

async function company(env?: NodeJS.ProcessEnv) {
  const { app, db } = await testApp(env);
  const owner = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(skill => skill.on).map(skill => skill.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const memberTask = async (over: Partial<NewTask> = {}) =>
    (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: rita.id, ...over })).task;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  /* The agent's oldest waiting turn runs and ends; what it did in between is up to the test. */
  const finish = async (agentId: string, during: () => Promise<unknown> = async () => {}, status: 'done' | 'failed' = 'done') => {
    const [job] = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
    await db.update(jobs).set({ status: 'running', startedAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job!.id));
    await db.insert(agentEvents).values({ companyId: job!.companyId, agentId, jobId: job!.id, kind: 'program', data: { program: { state: 'thinking', since: Date.now() - 1000, tool: null }, alarm: null } });
    await during();
    await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await afterJob(ctx, job!.id);
    return job!;
  };
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  await echelonsTurn(db, companyId);
  return { app, owner, ctx, db, sub: sub!, ceo: ceo!, dev: dev!, orchestrator: orchestrator!, head, bruno, rita, memberTask, turnsOf, finish };
}

/* A spy a test leaves behind would answer for the instructions of whichever test runs next. */
afterEach(() => { vi.restoreAllMocks(); });

describe('a delayed assignment wake on a closed task', () => {
  it.each(['done', 'cancelled'] as const)('logs a skipped assignment on %s without waking anyone', async status => {
    const c = await company();
    const task = await c.memberTask();
    await c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned', text: 'turn-5' }]);
    expect(await c.db.select().from(jobs)).toEqual([]);
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(log.filter(e => e.kind === 'wake_skipped')).toEqual([expect.objectContaining({ agentId: c.bruno.id, text: 'Run skipped: task is already closed. Bruno: assigned.', data: { wake: 'assigned', job: null } })]);
    expect(await c.db.select().from(agentEvents)).toEqual([]);
  });
});

describe('a person who speaks to an agent directly', () => {
  /* Bruno ends turns on his task without moving it until Hornhoof asks his head how he should go on. */
  async function stuck() {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.bruno.id);
    return { ...c, task };
  }
  const requestsOf = (c: Awaited<ReturnType<typeof company>>) =>
    c.db.select({ kind: requests.kind, status: requests.status, answer: requests.answer, answeredBy: requests.answeredBy }).from(requests).orderBy(asc(requests.createdAt));

  it("does not let a person answer an internal stuck request through the agent's terminal", async () => {
    const c = await stuck();
    expect(await c.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'waiting' }]);
    expect(await typedTurn(c.ctx, identityOf(c.sub, null, null, BUILTIN)!, c.bruno.id, 'Run the tests first, then submit.', c.ceo.id)).not.toBeNull();
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'open', answer: null, answeredBy: null }]);
    expect(await c.db.select({ status: tasks.status, silent: tasks.silent }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'waiting', silent: SILENT_TURNS }]);
  });

  it('leaves what waits on a task alone for a person who cannot reach the task', async () => {
    const c = await stuck();
    const [sales] = await c.db.insert(departments).values({ companyId: c.dev.companyId, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const [maria] = await c.db.insert(people).values({ companyId: c.dev.companyId, name: 'Maria', email: 'maria@acme.com', status: 'active', scopeKind: 'listed' }).returning();
    await c.db.insert(personAccess).values({ companyId: c.dev.companyId, personId: maria!.id, departmentId: sales!.id });
    expect(await typedTurn(c.ctx, identityOf(c.sub, null, null, BUILTIN)!, c.bruno.id, 'Skip the tests.', maria!.id)).not.toBeNull();
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
      queueMicrotask(() => said(c.ctx, node, m.ref, ok));
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
    const other = (await createTask(w.ctx, { agentId: w.head.id }, { title: 'Refunds', brief: '', body: 'POST /refunds.', departmentId: w.dev.id, assigneeAgentId: w.bruno.id, executor: true, small: true, reviewerAgentId: w.rita.id })).task;
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
    await c.db.update(subscriptions).set({ limitsUpdatedAt: new Date(), limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] } }).where(eq(subscriptions.id, c.sub.id));
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
  async function withPeer(rex: { limited?: boolean; status?: 'ready' | 'needs_login'; online?: boolean; nodeVersion?: string; urgentOnly?: boolean } = {}, before: 'nothing' | 'a turn' | 'a long refused turn' = 'nothing') {
    const c = await company();
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const rejected = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt }] };
    const [codex] = await c.db
      .insert(subscriptions)
      .values({ companyId: c.dev.companyId, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: c.ceo.id, status: rex.status ?? 'ready', limits: rex.limited ? rejected : null, limitsUpdatedAt: rex.limited ? new Date() : null })
      .returning();
    const [box] = await c.db.insert(machines).values({ companyId: c.dev.companyId, personId: c.ceo.id, machineKey: 'rex-0001-abcd', hostname: 'rex-box' }).returning();
    await c.db.insert(nodes).values({ id: codex!.id, companyId: c.dev.companyId, machineId: box!.id, subscriptionId: codex!.id, keyHash: 'rex-key-hash', status: rex.status ?? 'ready', version: rex.nodeVersion ?? '0.5.0' });
    const { isReady, hasTerminals } = { isReady: c.ctx.hub.isReady.bind(c.ctx.hub), hasTerminals: c.ctx.hub.hasTerminals.bind(c.ctx.hub) };
    const rexs = (id: NodeIdentity) => id.kind === 'node' && id.nodeId === codex!.id;
    vi.spyOn(c.ctx.hub, 'isReady').mockImplementation(id => (rexs(id) ? rex.online ?? true : isReady(id)));
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockImplementation(id => !rexs(id) && hasTerminals(id));
    const takesSkillFiles = c.ctx.hub.takesSkillFiles.bind(c.ctx.hub);
    vi.spyOn(c.ctx.hub, 'takesSkillFiles').mockImplementation(id => rexs(id) || takesSkillFiles(id));
    const [team] = rex.urgentOnly ? await c.db.insert(teams).values({ companyId: c.dev.companyId, departmentId: c.dev.id, name: 'Quick', urgentOnly: true }).returning() : [];
    const [peer] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Rex', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: codex!.id, teamId: team?.id ?? null }).returning();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    if (before === 'a turn') await c.finish(c.bruno.id, () => comment(c.ctx, { agentId: c.bruno.id }, task.id, 'The handler is half done.'));
    await c.db.update(subscriptions).set({ limitsUpdatedAt: new Date(), limits: rejected }).where(eq(subscriptions.id, c.sub.id));
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

  it("keeps the work with Bruno once his turns worked on it, as what he did may not be pushed yet, and he goes on on a fallback plan", async () => {
    for (const before of ['a turn', 'a long refused turn'] as const) {
      const { db, bruno, rex, task, turnsOf } = await withPeer({}, before);
      expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0], before).toMatchObject({ executorAgentId: bruno.id, assigneeAgentId: bruno.id });
      expect(await turnsOf(rex.id), before).toEqual([]);
    }
  });

  it('keeps the work with Bruno, who goes on on the free plan as a fallback, when the one who could take it is in a team that takes only urgent work', async () => {
    const { db, bruno, rex, task, turnsOf } = await withPeer({ urgentOnly: true });
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ executorAgentId: bruno.id });
    expect(await turnsOf(rex.id)).toEqual([]);
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]).toMatchObject({ subscriptionId: rex.subscriptionId });
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued' || j.status === 'running').map(j => [j.taskId, j.subscriptionId])).toEqual([[task.id, rex.subscriptionId]]);
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
    await createTask(c.ctx, { agentId: c.head.id }, { title: 'Refunds', brief: '', body: '', departmentId: c.dev.id, parentId: task.id, assigneeAgentId: kai!.id, executor: true });
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
  it('moves unstarted work queued to a busy worker to a free worker of the same role', async () => {
    const c = await company();
    const started = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: started.id, why: 'assigned' }]);
    await c.db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(eq(jobs.taskId, started.id));
    await c.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, started.id));
    await c.db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, c.sub.id));
    vi.spyOn(c.ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(c.ctx.hub, 'isOnline').mockReturnValue(true);
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockReturnValue(true);
    const [kai] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id }).returning();
    expect(await agentState(c.ctx, kai!.id)).toMatchObject({ ready: true, busy: false, queued: 0, limitUntil: null, budgetUntil: null, machineDrain: null });

    const unstarted = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: unstarted.id, why: 'assigned' }]);

    expect((await c.db.select().from(tasks).where(eq(tasks.id, unstarted.id)))[0]).toMatchObject({ assigneeAgentId: kai!.id, executorAgentId: kai!.id, status: 'open' });
    expect((await c.turnsOf(kai!.id)).map(j => j.taskId)).toEqual([unstarted.id]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, started.id)))[0]).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id, status: 'working' });
  });

  /* Bruno is at work, and Kai of his role is free but in a team that takes only urgent work. */
  async function withKaiOfQuick() {
    const c = await company();
    const started = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: started.id, why: 'assigned' }]);
    await c.db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(eq(jobs.taskId, started.id));
    await c.db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, c.sub.id));
    vi.spyOn(c.ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(c.ctx.hub, 'isOnline').mockReturnValue(true);
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockReturnValue(true);
    const [quick] = await c.db.insert(teams).values({ companyId: c.dev.companyId, departmentId: c.dev.id, name: 'Quick', urgentOnly: true }).returning();
    const worker = async (name: string, teamId: string | null) => (await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: c.dev.id, teamId, model: '', subscriptionId: c.sub.id }).returning())[0]!;
    return { ...c, worker, kai: await worker('Kai', quick!.id) };
  }

  it('passes over a free worker of a team that takes only urgent work', async () => {
    const c = await withKaiOfQuick();
    const unstarted = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: unstarted.id, why: 'assigned' }]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, unstarted.id)))[0]).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id, status: 'open' });
    expect(await c.turnsOf(c.kai.id)).toEqual([]);
  });

  it('gives the work to the free worker after one of a team that takes only urgent work', async () => {
    const c = await withKaiOfQuick();
    const dora = await c.worker('Dora', null);
    const unstarted = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: unstarted.id, why: 'assigned' }]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, unstarted.id)))[0]).toMatchObject({ assigneeAgentId: dora.id, executorAgentId: dora.id });
    expect(await c.turnsOf(c.kai.id)).toEqual([]);
  });

  it('keeps unstarted work queued when the worker of the same role is busy too', async () => {
    const c = await company();
    const started = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: started.id, why: 'assigned' }]);
    await c.db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(eq(jobs.taskId, started.id));
    await c.db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, c.sub.id));
    vi.spyOn(c.ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(c.ctx.hub, 'isOnline').mockReturnValue(true);
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockReturnValue(true);
    const [kai] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id }).returning();
    await c.db.insert(jobs).values({ companyId: c.dev.companyId, subscriptionId: c.sub.id, agentId: kai!.id, kind: 'conversation', prompt: 'Other work', timeoutMs: 1000, status: 'running', startedAt: new Date() });

    const unstarted = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: unstarted.id, why: 'assigned' }]);

    expect((await c.db.select().from(tasks).where(eq(tasks.id, unstarted.id)))[0]).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id, status: 'open' });
  });

  it('keeps started work with its worker when another free worker is available', async () => {
    const c = await company();
    const started = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: started.id, why: 'assigned' }]);
    await c.db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(eq(jobs.taskId, started.id));
    await c.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, started.id));
    await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id });

    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: started.id, why: 'assigned' }]);

    expect((await c.db.select().from(tasks).where(eq(tasks.id, started.id)))[0]).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id, status: 'working' });
    await c.db.update(tasks).set({ status: 'open' }).where(eq(tasks.id, started.id));
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: started.id, why: 'assigned' }]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, started.id)))[0]).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id, status: 'open' });
  });

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
    await submit(c.ctx, c.bruno.id, c.task.id, { summary: 'Done.', evidence: 'npm test: 12 passed', review: { baseCommit: BASE } });
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'withdrawn' }]);
    expect(await taskOf(c, c.task.id)).toMatchObject({ status: 'review' });
  });

  it('goes away when the agent reports a task it owns', async () => {
    const c = await company();
    /* Where the department keeps code, a worker closes such a task only on accepted subtasks; here it keeps none. */
    await c.db.update(departments).set({ repoUrl: null }).where(eq(departments.id, c.dev.id));
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
    await expect(submit(c.ctx, c.bruno.id, c.task.id, { summary: 'Done.', evidence: 'npm test', review: { baseCommit: BASE } })).rejects.toThrow(/waits for a person's answer/);
  });

  it('asks the member head to answer the internal stuck request', async () => {
    const c = await stuck();
    const [note] = await c.db.select(idOnly(requests)).from(requests);
    const asked = (await c.turnsOf(c.head.id)).filter(j => j.prompt.includes(note!.id));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toContain('comment');
    expect((await c.turnsOf(c.orchestrator.id)).filter(j => j.prompt.includes(note!.id))).toEqual([]);
  });

  it('wakes whoever holds the task now when its head answers', async () => {
    const c = await stuck();
    /* Handed on before Hornhoof let such notes go. */
    await c.db.update(tasks).set({ executorAgentId: c.kai.id, assigneeAgentId: c.kai.id }).where(eq(tasks.id, c.task.id));
    const { wakes } = await comment(c.ctx, { agentId: c.head.id }, c.task.id, 'Try again.');
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

  /* A node ends the turn of a program that has no Hornhoof tools in its session this way, and starts the program anew. */
  it('does not remind an agent whose turn ended without its tools: the turn goes again later', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const noTools = () => db.update(jobs).set({ error: 'agent_failed', failure: { kind: 'tools', text: 'The program has no Hornhoof tools in this session.', retryable: true } }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    await finish(bruno.id, noTools, 'failed');
    expect(await db.select({ kind: taskEvents.kind }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'reminded')))).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'open', silent: 0 });
    const queued = (await turnsOf(bruno.id)).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.notBefore).not.toBeNull();
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

  it('blocks the task for its head once after five turns on it in a row failed, however long each ran', async () => {
    const { ctx, db, head, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const late = () => db.update(jobs).set({ error: 'agent_failed', startedAt: new Date(Date.now() - 10 * 60_000), tail: 'Error: the stream ended' }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    const read = async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    for (let i = 0; i < 4; i++) await finish(bruno.id, late, 'failed');
    expect((await read()).status).toBe('open');
    await finish(bruno.id, late, 'failed');
    expect((await read()).status).toBe('blocked');
    const [note] = await db.select({ kind: taskEvents.kind, text: taskEvents.text }).from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(desc(taskEvents.id)).limit(1);
    expect(note!.kind).toBe('blocked');
    expect(note!.text).toContain('5 turns of Bruno in a row on');
    expect(note!.text).toContain('the stream ended');
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect((await turnsOf(head.id)).filter(j => j.status === 'queued')).toHaveLength(1);
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
    await finish(bruno.id, async () => wakeAll(ctx, (await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test', review: { baseCommit: BASE } })).wakes));
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
type Run = { type: 'job.run'; jobId: string; prompt: string; workspace?: { key: string; repo: { url: string; branch: string; token: string; author: { name: string; email: string } | null } | null; repositoryScope?: { companyId: string; repositoryOwnerId: string; repoUrlHash: string } } | null };

/* The node's mark comes back after everything the server sent it before, as one socket keeps their order. */
async function marked(node: FakeNode): Promise<void> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
}

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
  const task = async (agentId: string, productId: string | null = null) => (await createTask(app.ctx, { agentId }, { title: 'Checkout API', brief: '', body: '', departmentId: dev!.id, productId, assigneeAgentId: agentId, executor: true })).task;
  return { app, db, url, ceo, builtin, ctx: app.ctx, companyId, dev: dev!, shop: shop!, hire, repository, task };
}

describe("a plan's share for tasks", () => {
  const used = (utilization: number, resetsAt: string) => ({ status: 'allowed' as const, windows: [{ name: 'five_hour', utilization, resetsAt }] });
  /* Bruno on the built-in node's key, which used most of its five hours. */
  async function plan(utilization: number) {
    const r = await withRepositories();
    const bruno = await r.hire('Bruno', null);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await r.db.update(subscriptions).set({ budget: 80, limits: used(utilization, resetsAt), limitsUpdatedAt: new Date() });
    return { ...r, bruno, resetsAt };
  }

  it('holds task turns once a window of the plan used the share set for tasks, and says until when', async () => {
    const { ctx, db, builtin, bruno, task, resetsAt } = await plan(0.85);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: (await task(bruno.id)).id, why: 'assigned' }]);
    await marked(builtin);
    /* Nothing of Bruno's goes to the machine: the one turn there is the orchestrator's, told once that no fallback has room. */
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(builtin.queued()).toBe(1);
    expect((await db.select({ prompt: jobs.prompt }).from(jobs).where(eq(jobs.agentId, orchestrator!.id))).map(j => j.prompt)).toEqual([expect.stringContaining('no fallback plan has room for its employees, so their work waits: Bruno.')]);
    expect((await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.agentId, bruno.id)))).toEqual([{ status: 'queued' }]);
    expect(await agentState(ctx, bruno.id)).toMatchObject({ budgetUntil: resetsAt, limitUntil: null });
  });

  it("still sends a person's own message on such a plan", async () => {
    const { ctx, builtin, bruno, companyId } = await plan(0.85);
    const [person] = await ctx.db.select(idOnly(people)).from(people);
    await enqueueTurn(ctx, { companyId, agentId: bruno.id, prompt: 'Ivan (CEO): How far are you?', createdBy: person!.id });
    expect((await nextRun(builtin)).prompt).toContain('How far are you?');
  });

  it('sends task turns below the share', async () => {
    const { ctx, builtin, bruno, task } = await plan(0.5);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: (await task(bruno.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).prompt).toContain('Checkout API');
    expect(await agentState(ctx, bruno.id)).toMatchObject({ budgetUntil: null });
  });

  it.each(['head', 'orchestrator'] as const)('sends a %s turn with a task above the share', async kind => {
    const r = await plan(0.85);
    const agent = kind === 'head'
      ? (await r.db.insert(agents).values({ companyId: r.companyId, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: r.dev.id, model: '', subscriptionId: r.bruno.subscriptionId }).returning())[0]!
      : (await r.db.select().from(agents).where(eq(agents.kind, 'orchestrator')))[0]!;
    const mine = kind === 'head'
      ? await r.task(agent.id)
      : (await createTask(r.ctx, { personId: (await r.db.select(idOnly(people)).from(people))[0]!.id }, { title: 'Checkout API', brief: '', body: '', departmentId: null, assigneeAgentId: agent.id })).task;
    await wakeAll(r.ctx, [{ agentId: agent.id, taskId: mine.id, why: 'assigned' }]);
    expect((await nextRun(r.builtin)).prompt).toContain('Checkout API');
    expect(await r.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.agentId, agent.id))).toEqual([{ status: 'running' }]);
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
      expect(run.prompt).toContain('Several things waited for you in line and go out together in this turn.');
      await db.insert(agentEvents).values({ companyId, agentId: head.id, jobId: run.jobId, kind: 'program', data: { program: { state: 'thinking', since: Date.now() - 1000, tool: null }, alarm: null } });
      await db.insert(agentEvents).values(taskIds.map(taskId => ({ companyId, agentId: head.id, jobId: run.jobId, kind: 'tool' as const, data: { name: 'hornhoof.task', input: '{}', task: { id: taskId } } })));
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
    /* Its own failure continuation remains; no carried failure advances the stuck counter. */
    const wentOn = async (taskId: string) => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'continued')))).length;
    expect([await wentOn(payments.id), await wentOn(refunds.id)]).toEqual([1, 0]);
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
    expect([await count(refunds.id, 'interrupted'), await count(refunds.id, 'continued')]).toEqual([0, 0]);
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
  it("sends a task's turn with its product's repository, else its department's, and each agent its own folder", async () => {
    const { ctx, builtin, companyId, dev, shop, hire, repository, task } = await withRepositories();
    expect((await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111' })).statusCode).toBe(200);
    expect((await repository(shop.id, { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222' })).statusCode).toBe(200);
    const bruno = await hire('Bruno', shop.id);
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: (await task(bruno.id, shop.id)).id, why: 'assigned' }]);
    const first = await nextRun(builtin);
    /* The repository as the company's registry of what is built knows it, so the agent's worktree gets its dependencies from there. */
    const scope = (ownerId: string, url: string) => ({ companyId, repositoryOwnerId: ownerId, repoUrlHash: hashToken(url) });
    expect(first.workspace).toEqual({ key: bruno.id, repo: { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222', author: null }, repositoryScope: scope(shop.id, 'https://github.com/acme/shop.git') });
    /* Where it is and how it is worked in the agent reads with its briefing tool: the message is the message alone. */
    expect(first.prompt).not.toContain('https://github.com/acme/shop.git');
    expect(first.prompt).not.toContain('./shop');
    expect(first.prompt).not.toContain('ghp_');
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).workspace).toEqual({ key: pia.id, repo: { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111', author: null }, repositoryScope: scope(dev.id, 'https://github.com/acme/platform.git') });
  });

  it("clones the repository of the task's product for an agent of the whole department, and its own for its window", async () => {
    const { ctx, builtin, companyId, dev, shop, hire, repository } = await withRepositories();
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111' });
    await repository(shop.id, { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222' });
    const pia = await hire('Pia', null);
    const { task } = await createTask(ctx, { agentId: pia.id }, { title: 'Shop checkout', brief: '', body: '', departmentId: dev.id, productId: shop.id, assigneeAgentId: pia.id, executor: true });
    await wakeAll(ctx, [{ agentId: pia.id, taskId: task.id, why: 'assigned' }]);
    const run = await nextRun(builtin);
    expect(run.workspace).toEqual({
      key: pia.id,
      repo: { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222', author: null },
      repositoryScope: { companyId, repositoryOwnerId: shop.id, repoUrlHash: hashToken('https://github.com/acme/shop.git') },
    });
    builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => builtin.acks.includes(run.jobId));
    builtin.send({ type: 'agent.start', agentKey: pia.id });
    expect((await nextRun(builtin)).workspace?.repo?.url).toBe('https://github.com/acme/platform.git');
  });

  it('gives the clone who its commits are by, and puts it in no message', async () => {
    const { ctx, builtin, dev, hire, repository, task } = await withRepositories();
    const author = { name: 'Alex Rivera', email: 'alex@acme.example' };
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main', author });
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    const run = await nextRun(builtin);
    expect(run.workspace?.repo?.author).toEqual(author);
    for (const words of ['Alex Rivera', 'Commit as', 'Co-Authored-By', 'read its own rules first', 'a branch per task']) expect(run.prompt).not.toContain(words);
  });

  it('starts an agent for its window with its instructions alone, telling it nothing of its repository', async () => {
    const { builtin, dev, hire, repository } = await withRepositories();
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main' });
    const pia = await hire('Pia', null);
    builtin.send({ type: 'agent.start', agentKey: pia.id });
    const start = (await nextRun(builtin)) as Run & { context?: string | null };
    expect(start.prompt).toBe('');
    expect(start).not.toHaveProperty('guidance');
    expect(start.context ?? '').not.toContain('platform');
    expect(start.workspace?.repo?.url).toBe('https://github.com/acme/platform.git');
  });

  it.each(['unblocked', 'reminder', 'go_on', 'tests', 'work'] as const)('wakes the holder on %s with the news alone, not the rules its skills keep', why => {
    const task = { id: 't-7', number: 7, title: 'Checkout API', assigneeAgentId: 'a-1', executorAgentId: 'a-1' } as unknown as Parameters<typeof wakePrompt>[1];
    const prompt = wakePrompt({ kind: 'worker' }, task, { agentId: 'a-1', taskId: 't-7', why, text: 'Current news.' });
    expect(prompt).toContain('#7 "Checkout API"');
    expect(prompt).not.toContain('task.echelons');
    expect(prompt).toMatch(/If you (still )?cannot go on, use blocked/);
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
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' } });
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
    await marked(mac);
    expect(mac.queued()).toBe(0);
    expect((await app.inject({ url: `/api/agents/${olga.id}/events`, ...as(ceo) })).json().state.reason).toBe('node_outdated');
  });
});

/* Real dispatch after an agent's long turn, with task wakes held behind it. */
async function busyQueue() {
  const c = await company({ NODE_KEY });
  const builtin = await connectNode(await listen(c.app), NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(() => c.ctx.hub.isReady(identityOf(c.sub, null, null, BUILTIN)!));
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
  it.each(['done', 'cancelled'] as const)('drops three queued assignments after their tasks are %s', async status => {
    const c = await busyQueue();
    const [first, second, last] = await Promise.all([c.memberTask(), c.memberTask(), c.memberTask()]);
    await wakeAll(c.ctx, [
      { agentId: c.bruno.id, taskId: first!.id, why: 'assigned' },
      { agentId: c.bruno.id, taskId: second!.id, why: 'assigned' },
      { agentId: c.bruno.id, taskId: last!.id, why: 'assigned', text: 'turn-4' },
    ]);
    const queued = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(3);
    /* These are the old rows of the incident, before wake snapshots existed. */
    await c.db.update(agentEvents).set({ data: sql`${agentEvents.data} - 'taskWake'` }).where(inArray(agentEvents.jobId, queued.map(j => j.id)));
    await c.close([first!.id, second!.id, last!.id], status);
    const next = await enqueueTurn(c.ctx, { companyId: c.dev.companyId, agentId: c.bruno.id, prompt: 'A new message.', createdBy: c.ceo.id });
    await c.release();

    expect((await nextRun(c.builtin)).jobId).toBe(next);
    await marked(c.builtin);
    expect(c.builtin.queued()).toBe(0);
    for (const [i, task] of [first!, second!, last!].entries()) {
      const [stale] = await c.db.select().from(jobs).where(eq(jobs.id, queued[i]!.id));
      expect(stale).toMatchObject({ status: 'obsolete', error: 'stale', startedAt: null });
      expect(stale!.result).toContain(`#${task.number}`);
      expect((await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, stale!.id), eq(agentEvents.kind, 'stopped')))).map(e => e.data)).toEqual([
        { reason: 'obsolete', text: stale!.result, tail: 'No output.', program: null, task: { id: task.id, number: task.number } },
      ]);
    }
  });

  it('drops a late assignment signal before it queues a turn, and forgets the kept signal', async () => {
    const c = await busyQueue();
    const task = await c.memberTask();
    await c.close([task.id]);
    await c.db.insert(pendingWakes).values({ companyId: task.companyId, agentId: c.bruno.id, taskId: task.id, why: 'assigned', createdAt: new Date(Date.now() - 60_000) });
    await wakeLeftBehind(c.ctx, new Date(Date.now() + 60_000));
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect(await c.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, task.id))).toEqual([]);
  });

  it('keeps comments on a done task in its log without waking its producer or checking owners', async () => {
    const c = await company();
    const task = await c.memberTask();
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: c.bruno.id }).where(eq(tasks.id, task.id));
    for (const actor of [{ personId: c.ceo.id }, { agentId: c.head.id }]) {
      const moved = await comment(c.ctx, actor, task.id, 'A note for the task history.');
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

  it.each(['done', 'reported', 'reviewed'] as const)('preserves the %s notice to the head after a task closes', async why => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const task = await c.memberTask();
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
  ])('drops an assignment that now belongs to $name', async ({ set }) => {
    const c = await busyQueue();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    const [queued] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    await c.db.update(tasks).set(set).where(eq(tasks.id, task.id));
    await c.release();
    await marked(c.builtin);
    expect(c.builtin.queued()).toBe(0);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ status: 'obsolete', error: 'stale', startedAt: null });
  });

  it('drops a queued Review after the same owner advances the candidate to Tests', async () => {
    const c = await busyQueue();
    const held = await c.hold(c.rita.id);
    await c.db.update(agents).set({ skills: [...c.rita.skills, 'dev-test-environment'] }).where(eq(agents.id, c.rita.id));
    const task = await c.memberTask({ testsAgentId: c.rita.id });
    await wakeAll(c.ctx, (await submit(c.ctx, c.bruno.id, task.id, { summary: 'Ready.', evidence: 'Total checks.', review: { baseCommit: BASE } })).wakes);
    const [queued] = (await c.turnsOf(c.rita.id)).filter(j => j.status === 'queued');
    expect(queued).toBeDefined();
    await verdict(c.ctx, c.rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Checked the current candidate.' });
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(jobs.id, queued!.id));
    await c.release(held.id);
    await marked(c.builtin);
    expect(c.builtin.queued()).toBe(0);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it('still dispatches a current assignment after the busy turn ends', async () => {
    const c = await busyQueue();
    const task = await c.memberTask();
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
    const task = await c.memberTask();
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
    const child = await c.memberTask();
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
    const task = await c.memberTask();
    await c.db.update(tasks).set({ assigneeAgentId: c.head.id }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c.head.id, taskId: task.id, why: 'updated' }]);
    const [queued] = (await c.turnsOf(c.head.id)).filter(j => j.status === 'queued');
    await c.db.update(tasks).set({ assigneeAgentId: c.bruno.id }).where(eq(tasks.id, task.id));
    await c.release(held.id);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it('rejects a task turn without workflow identity even when its owner created the task', async () => {
    const c = await busyQueue();
    const task = await c.memberTask();
    await c.db.update(tasks).set({ createdByAgentId: c.bruno.id }).where(eq(tasks.id, task.id));
    const queued = await enqueueTurn(c.ctx, { companyId: task.companyId, agentId: c.bruno.id, taskId: task.id, prompt: 'An old assignment.', createdBy: null });
    await c.close([task.id]);
    await c.release();
    expect((await c.db.select().from(jobs).where(eq(jobs.id, queued)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });

  it('dispatches a current task turn with its canonical workflow identity', async () => {
    const c = await busyQueue();
    const task = await c.memberTask();
    const route = routeSnapshot(await routeOf(c.db, task), task.assigneeAgentId);
    const queued = await enqueueTurn(c.ctx, { companyId: task.companyId, agentId: c.bruno.id, taskId: task.id,
      prompt: 'Continue the assigned task.', createdBy: null, message: { personId: null, text: 'Continue the assigned task.', taskWake: taskWakeOf(task, { why: 'assigned' }, route) } });
    await c.release();
    expect((await nextRun(c.builtin)).jobId).toBe(queued);
  });

  it('dispatches a canonical completion notice to the giver after the task closes', async () => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const task = await c.memberTask();
    const route = routeSnapshot(await routeOf(c.db, task), task.assigneeAgentId);
    await c.close([task.id]);
    const prompt = wakePrompt(c.head, task, { agentId: c.head.id, taskId: task.id, why: 'done' });
    const queued = await enqueueTurn(c.ctx, { companyId: task.companyId, agentId: c.head.id, taskId: task.id, prompt, createdBy: null,
      message: { personId: null, text: prompt, taskWake: taskWakeOf(task, { why: 'done' }, route) } });
    await c.release(held.id);
    expect((await nextRun(c.builtin)).jobId).toBe(queued);
  });

  it.each(['blocked', 'tests', 'work'] as const)('preserves current %s news for the giver', async why => {
    const c = await busyQueue();
    const held = await c.hold(c.head.id);
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.head.id, taskId: task.id, why, text: 'Current news.' }]);
    const [queued] = (await c.turnsOf(c.head.id)).filter(j => j.status === 'queued');
    expect(queued).toBeDefined();
    await c.release(held.id);
    expect((await nextRun(c.builtin)).jobId).toBe(queued!.id);
  });

  it.each([
    { why: 'assigned', status: 'blocked', holder: 'bruno', receiver: 'bruno' },
    { why: 'assigned', status: 'open', holder: 'head', receiver: 'bruno' },
    { why: 'review', status: 'open', holder: 'bruno', receiver: 'rita' },
    { why: 'review', status: 'review', holder: 'bruno', receiver: 'rita' },
  ] as const)('rejects $why before queueing when its current phase or recipient does not match ($status, $holder)', async ({ why, status, holder, receiver }) => {
    const c = await company();
    const task = await c.memberTask();
    await c.db.update(tasks).set({ status, assigneeAgentId: c[holder].id }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c[receiver].id, taskId: task.id, why }]);
    expect(await c.turnsOf(c[receiver].id)).toEqual([]);
  });

  it('resumes current working tasks when the agent gets its subscription back', async () => {
    const c = await company();
    const task = await c.memberTask();
    await c.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, task.id));
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.bruno.id));
    const response = await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.bruno.id}`, payload: { subscription: c.sub.id }, ...as(c.owner) });
    expect(response.statusCode).toBe(200);
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toHaveLength(1);
  });

  it('discards obsolete work even if its instructions can no longer be built', async () => {
    const c = await busyQueue();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    await c.close([task.id]);
    vi.spyOn(instructionBuilder, 'instructionsOf').mockRejectedValue(new Error('These obsolete instructions are unavailable.'));
    await c.release();
    await marked(c.builtin);
    expect(c.builtin.queued()).toBe(0);
    expect((await c.db.select().from(jobs).where(eq(jobs.taskId, task.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
  });
});
