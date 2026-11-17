import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, machines, nodes, people, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { GONE_ALONG, pumpWaiting } from '../src/modules/conversation/queue.js';
import { nodeConnected, nodeDisconnected } from '../src/modules/nodes/connections.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { failOpenJobs } from '../src/modules/nodes/messages.js';
import { comment, createTask, GOING_ON_TURNS, SILENT_TURNS } from '../src/modules/tasks/engine.js';
import { queueTaskMessage } from '../src/modules/tasks/external-wait.js';
import { afterJob, wakeAll } from '../src/modules/tasks/wake.js';
import { echelonsTurn, setUpCompany, testApp } from './helpers.js';

const MIN = 60_000;
/* The clock only the test moves: every row and every event of a test is stamped with it. */
const START = new Date('2030-01-01T08:00:00Z');

/* Bruno works on his own plan's laptop, whose node comes and goes as the test says; Hana, his head, is on the company key. */
async function company() {
  vi.useFakeTimers({ toFake: ['Date'], now: START });
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp();
  await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [key] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const [plan] = await db.insert(subscriptions).values({ companyId, ownerPersonId: ceo!.id, provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready' }).returning();
  const [machine] = await db.insert(machines).values({ companyId, personId: ceo!.id, machineKey: 'laptop', hostname: 'laptop' }).returning();
  const [laptop] = await db.insert(nodes).values({ companyId, machineId: machine!.id, subscriptionId: plan!.id, keyHash: 'laptop', status: 'ready', version: '0.5.0' }).returning();
  /* The skills each role's template turns on, written out so that the test reads no template. */
  const everyone = ['hh-hornhoof', 'hh-tasks', 'hh-outside-is-data', 'hh-verify-before-done', 'hh-ask-dont-guess', 'hh-questions', 'hh-stay-in-scope', 'hh-run-checks'];
  const member = [...everyone, 'hh-report-to-head', 'hh-task-flow'];
  const skills = {
    'DEV-HEAD': [...everyone, 'hh-lead-tasks', 'hh-head', 'hh-notebook', 'hh-break-down', 'hh-brief-members', 'hh-handle-reports', 'hh-fix-loop', 'dev-lead', 'dev-work-pipeline', 'dev-release-improvements', 'dev-test-environment', 'dev-gates', 'dev-testing-policy', 'dev-ci-release', 'dev-worktrees', 'dev-release-notes', 'hh-status-update', 'hh-work-fast'],
    'DEV-BE': [...member, 'dev-task-flow', 'dev-engineering-rules', 'dev-testing-policy', 'dev-gates', 'dev-language-rules', 'dev-implement', 'dev-tdd', 'dev-worktrees', 'dev-debugging', 'dev-migrations', 'hh-work-fast'],
    'DEV-REV': [...member, 'dev-task-flow', 'dev-testing-policy', 'dev-gates', 'dev-language-rules', 'dev-review-diff', 'dev-review-fix', 'dev-review-verdict', 'hh-work-fast'],
  };
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: keyof typeof skills, on: { subscriptionId: string; nodeId?: string }) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', ...on, skills: skills[roleKey] }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD', { subscriptionId: key!.id });
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', { subscriptionId: plan!.id, nodeId: laptop!.id });
  const rita = await hire('Rita', 'worker', 'DEV-REV', { subscriptionId: key!.id });
  await echelonsTurn(db, companyId);

  let connected = false;
  vi.spyOn(ctx.hub, 'isReady').mockImplementation(id => id.kind === 'builtin' || connected);
  vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(false);
  vi.spyOn(ctx.hub, 'takesSkillFiles').mockReturnValue(true);
  const send = vi.spyOn(ctx.hub, 'send').mockReturnValue(true);

  /* The node's connections, as the hub records them. */
  const node = nodeIdentity(laptop!.id);
  let link = '';
  const later = (ms = MIN) => vi.setSystemTime(Date.now() + ms);
  const connect = async () => {
    link = randomUUID();
    await nodeConnected(ctx, node, link, new Date());
    connected = true;
  };
  const drop = async () => {
    await nodeDisconnected(ctx, node, { link, at: new Date(), cause: 'network', code: 1006, reason: null, error: null });
    connected = false;
  };
  /* The machine is switched on again: its node connects and says hello, and every waiting turn is sent. */
  const back = async () => {
    later();
    await connect();
    await pumpWaiting(ctx);
  };
  await connect();
  later();

  const memberTask = async (title: string) =>
    (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: rita.id })).task;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  const running = async (agentId: string) => (await turnsOf(agentId)).filter(j => j.status === 'running');
  /* Bruno's turn that went out works on its task, says how far it got when said is given, and ends. */
  const run = async (said?: string, ended: { status: 'done' | 'failed'; error: string | null } = { status: 'done', error: null }) => {
    const [job] = await running(bruno.id);
    later();
    await db.insert(agentEvents).values({ companyId, agentId: bruno.id, jobId: job!.id, kind: 'tool', data: { name: 'hornhoof.task', input: '{}', task: { id: job!.taskId } } });
    if (said) await comment(ctx, { agentId: bruno.id }, job!.taskId!, said);
    later();
    await db.update(jobs).set({ ...ended, finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await afterJob(ctx, job!.id);
    return job!;
  };
  /* Hana writes to Bruno about his task with message_employee. */
  const tell = (task: { number: number }, text: string) =>
    queueTaskMessage(ctx, { companyId, agentId: bruno.id, task: task.number, actor: { agentId: head.id }, text }, { companyId, agentId: bruno.id, prompt: `Hana (Head of development): ${text}`, createdBy: null, message: { personId: null, text, from: 'agent', name: 'Hana', by: head.id } });
  /* The CEO comments on a task, which wakes the one who holds it. */
  const ask = async (taskId: string, text: string) => wakeAll(ctx, (await comment(ctx, { personId: ceo!.id }, taskId, text)).wakes);
  const continued = (taskId: string) => db.select(only(taskEvents, 'data')).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'continued'))).orderBy(asc(taskEvents.createdAt));
  const stuck = () => db.select({ taskId: requests.taskId, text: requests.text }).from(requests).where(eq(requests.kind, 'stuck'));
  const statusOf = async (taskId: string) => (await db.select(only(tasks, 'status')).from(tasks).where(eq(tasks.id, taskId)))[0]!.status;
  const silentOf = async (taskId: string) => (await db.select(only(tasks, 'silent')).from(tasks).where(eq(tasks.id, taskId)))[0]!.silent;
  const reminded = async (taskId: string) => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'reminded')))).length;
  const sentPrompt = (jobId: string) => {
    const call = send.mock.calls.find(([, m]) => m.type === 'job.run' && m.jobId === jobId);
    return call && call[1].type === 'job.run' ? call[1].prompt : null;
  };
  return { ctx, db, ceo: ceo!, head, bruno, later, drop, back, memberTask, turnsOf, running, run, tell, ask, continued, stuck, statusOf, silentOf, reminded, sentPrompt };
}

type Company = Awaited<ReturnType<typeof company>>;

/* Bruno works through turns turns on the task without handing anything in, saying what said gives in each, and his machine
   is switched off during the next one, which Hornhoof ends as machine_offline once the machine stayed away. */
async function workedThenAway(c: Company, task: { id: string }, turns: number, said: (i: number) => string | undefined = i => `Part ${i} pushed.`) {
  await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
  for (let i = 0; i < turns; i++) await c.run(said(i));
  const [cut] = await c.running(c.bruno.id);
  c.later();
  await c.drop();
  c.later(6 * MIN);
  await failOpenJobs(c.ctx, eq(jobs.id, cut!.id), 'machine_offline');
  return cut!;
}

describe('wake-ups that waited while the machine was away', () => {
  it('go out in one turn on their task once the node is back, and do not make the agent look stuck', async () => {
    const c = await company();
    const task = await c.memberTask('Checkout API');
    await workedThenAway(c, task, GOING_ON_TURNS - 1);
    const told = [];
    for (let i = 0; i < GOING_ON_TURNS; i++) {
      c.later(10 * MIN);
      told.push(`Are you there? ${i}`);
      await c.tell(task, told.at(-1)!);
    }
    await c.ask(task.id, 'Any news on the checkout?');
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued').length).toBeGreaterThan(GOING_ON_TURNS);

    await c.back();

    const [one, ...more] = await c.running(c.bruno.id);
    expect(more).toEqual([]);
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    const along = (await c.turnsOf(c.bruno.id)).filter(j => j.result === GONE_ALONG);
    expect(along).toHaveLength(GOING_ON_TURNS);
    expect(along.every(j => j.taskId === task.id)).toBe(true);
    const prompt = c.sentPrompt(one!.id)!;
    expect(prompt).toContain('These wake-ups on your task waited in line until your machine was connected again.');
    for (const said of [...told, 'Any news on the checkout?']) expect(prompt).toContain(said);

    await c.run('Back. Read all of it, going on with the totals.');

    expect(await c.stuck()).toEqual([]);
    expect(await c.statusOf(task.id)).toBe('working');
    expect((await c.continued(task.id)).at(-1)).toEqual({ data: expect.objectContaining({ afterReturn: true }) });
    expect(await c.running(c.bruno.id)).toEqual([expect.objectContaining({ taskId: task.id, prompt: expect.stringContaining('Go on with the work') })]);
  });

  it('leaves none of several tasks stuck or waiting once the machine is back', async () => {
    const c = await company();
    const held = [await c.memberTask('Checkout API'), await c.memberTask('Refund email'), await c.memberTask('Invoice PDF')];
    /* Each of them went on through turns without a hand-in, one short of asking the head. */
    for (const task of held) {
      c.later();
      await c.db.insert(taskEvents).values(Array.from({ length: GOING_ON_TURNS - 1 }, (_, i) => ({ companyId: task.companyId, taskId: task.id, agentId: c.bruno.id, kind: 'continued' as const, text: `Earlier ${i}`, data: { turns: i + 1 } })));
    }
    c.later();
    await c.drop();
    for (const task of held) {
      c.later(10 * MIN);
      await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
      c.later(10 * MIN);
      await c.ask(task.id, `How is ${task.title} going?`);
    }

    await c.back();
    const ran = [];
    for (let i = 0; i < held.length; i++) ran.push((await c.run(`Picked ${i} up again.`)).taskId);

    expect(ran).toEqual(held.map(t => t.id));
    expect(await c.stuck()).toEqual([]);
    for (const task of held) expect(await c.statusOf(task.id)).not.toBe('waiting');
  });

  it('neither reminds the agent nor clears its quiet turns for a turn from the backlog that ended without a word', async () => {
    const c = await company();
    const task = await c.memberTask('Checkout API');
    await workedThenAway(c, task, SILENT_TURNS - 1, () => undefined);
    expect(await c.silentOf(task.id)).toBe(SILENT_TURNS - 1);

    await c.back();
    await c.run();

    expect(await c.stuck()).toEqual([]);
    expect(await c.statusOf(task.id)).toBe('working');
    expect([await c.silentOf(task.id), await c.reminded(task.id)]).toEqual([SILENT_TURNS - 1, SILENT_TURNS - 1]);
  });

  it('does not count the continuation of a turn from the backlog that failed before it recorded its work', async () => {
    const c = await company();
    const task = await c.memberTask('Checkout API');
    await workedThenAway(c, task, GOING_ON_TURNS - 2);
    c.later(10 * MIN);
    await c.tell(task, 'Are you there?');

    await c.back();
    await c.run(undefined, { status: 'failed', error: 'agent_failed' });
    await c.run('Back on the totals.');

    expect(await c.stuck()).toEqual([]);
    expect(await c.statusOf(task.id)).toBe('working');
  });
});

describe('a node that stays connected', () => {
  it('still asks the head once the agent went on for eight turns without handing anything in', async () => {
    const c = await company();
    const task = await c.memberTask('Checkout API');
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < GOING_ON_TURNS - 1; i++) await c.run(`Part ${i} pushed.`);
    expect(await c.stuck()).toEqual([]);

    await c.run('Part 7 pushed.');

    expect(await c.stuck()).toEqual([{ taskId: task.id, text: expect.stringContaining(`Went on for ${GOING_ON_TURNS} turns in a row`) }]);
    expect(await c.statusOf(task.id)).toBe('waiting');
    expect((await c.continued(task.id)).every(e => !(e.data as { afterReturn?: boolean } | null)?.afterReturn)).toBe(true);
  });

  it('counts a turn that went out before its node dropped for a moment and came back', async () => {
    const c = await company();
    const task = await c.memberTask('Checkout API');
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < GOING_ON_TURNS - 1; i++) await c.run(`Part ${i} pushed.`);
    c.later();
    await c.drop();
    await c.back();

    await c.run('Part 7 pushed.');

    expect(await c.stuck()).toEqual([{ taskId: task.id, text: expect.stringContaining(`Went on for ${GOING_ON_TURNS} turns in a row`) }]);
  });
});

/* The node goes away while each turn runs and is back before the next goes out: every turn waited in line for its return. */
async function awayAroundEveryTurn(c: Company, said: (i: number) => string | undefined) {
  const task = await c.memberTask('Checkout API');
  await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
  let turns = 0;
  while (!(await c.stuck()).length && turns < 3 * GOING_ON_TURNS) {
    c.later();
    await c.drop();
    await c.run(said(turns));
    turns++;
    await c.back();
  }
  return { task, turns };
}

describe('a node that goes away around every turn', () => {
  it('lets one turn after its return go uncounted, and still asks the head about an agent that keeps going on', async () => {
    const c = await company();
    const { task, turns } = await awayAroundEveryTurn(c, i => `Part ${i} pushed.`);

    expect(await c.stuck()).toEqual([{ taskId: task.id, text: expect.stringContaining(`Went on for ${GOING_ON_TURNS} turns in a row`) }]);
    expect(turns).toBe(GOING_ON_TURNS + 1);
    expect((await c.continued(task.id)).filter(e => (e.data as { afterReturn?: boolean } | null)?.afterReturn)).toHaveLength(1);
  });

  it('lets one quiet turn after its return go uncounted, and still asks the head about an agent that stays quiet', async () => {
    const c = await company();
    const { task, turns } = await awayAroundEveryTurn(c, () => undefined);

    expect(await c.stuck()).toEqual([{ taskId: task.id, text: expect.stringContaining(`Ended ${SILENT_TURNS} turns in a row`) }]);
    expect(turns).toBe(SILENT_TURNS + 1);
  });
});
