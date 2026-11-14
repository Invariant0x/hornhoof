import type { NodeMessage, ProgramState } from '@hornhoof/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, machines, nodes, people, requests, subscriptions } from '../src/db/schema.js';
import { insertTurn, pump, TURN_TIMEOUT_MS } from '../src/modules/conversation/queue.js';
import { BUILTIN, keyOf, nodeIdentity, type NodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { setUpCompany, testApp } from './helpers.js';

const MIN = 60_000;
/* The clock only the test moves: every row, every report and every round of the watchdog is stamped with it. */
const START = new Date('2030-01-01T08:00:00Z');

/* The orchestrator runs on the company's key, on the built-in node. Hana, the head of Development, runs on the CEO's plan on
   his laptop, whose node comes and goes as the test says. Otto keeps the programs going in Operations, on the key. */
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
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  /* The first turn setup left for the orchestrator is over before the test begins. */
  await db.update(jobs).set({ status: 'done', result: '', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator!.id));
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [ops] = await db.insert(departments).values({ companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
  const [plan] = await db.insert(subscriptions).values({ companyId, ownerPersonId: ceo!.id, provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready' }).returning();
  const [machine] = await db.insert(machines).values({ companyId, personId: ceo!.id, machineKey: 'laptop', hostname: 'laptop' }).returning();
  const [laptop] = await db.insert(nodes).values({ companyId, machineId: machine!.id, subscriptionId: plan!.id, keyHash: 'laptop', status: 'ready', version: '0.5.0' }).returning();
  const [hana] = await db.insert(agents).values({ companyId, kind: 'head', name: 'Hana', model: 'claude-opus-5-5', roleKey: 'DEV-HEAD', departmentId: dev!.id, subscriptionId: plan!.id, nodeId: laptop!.id, skills: [] }).returning();
  const [otto] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Otto', model: 'claude-opus-5-5', roleKey: 'OPS-PROGRAM', departmentId: ops!.id, subscriptionId: key!.id, skills: [] }).returning();

  const node = nodeIdentity(laptop!.id);
  let online = true;
  let awayAt: number | null = null;
  vi.spyOn(ctx.hub, 'isReady').mockImplementation(id => id.kind === 'builtin' || online);
  vi.spyOn(ctx.hub, 'isOnline').mockImplementation(id => id.kind === 'builtin' || online);
  vi.spyOn(ctx.hub, 'awaySince').mockImplementation(id => (id.kind === 'builtin' || online ? null : awayAt));
  vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(false);
  vi.spyOn(ctx.hub, 'takesSkillFiles').mockReturnValue(true);
  const send = vi.spyOn(ctx.hub, 'send').mockReturnValue(true);

  const later = (ms = MIN) => vi.setSystemTime(Date.now() + ms);
  /* A message comes to the agent's queue and goes out if nothing runs before it. */
  const message = async (agentId: string, prompt: string) => {
    const id = await insertTurn(ctx, { companyId, agentId, prompt, createdBy: null });
    await pump(ctx, agentId);
    return id;
  };
  const job = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  const running = async (agentId: string) => (await turnsOf(agentId)).filter(j => j.status === 'running');
  /* What the server sent each node: the turns it gave it and what it asked it of the turns it runs. */
  const sentRun = (jobId: string) => send.mock.calls.some(([, m]) => m.type === 'job.run' && m.jobId === jobId);
  const checks = () => send.mock.calls.flatMap(([to, m]) => ((m as { type: string }).type === 'jobs.check' ? [{ to: keyOf(to), jobIds: (m as unknown as { jobIds: string[] }).jobIds }] : []));
  /* The node tells what the turn's program does, as it does at least once a minute while it runs the turn: since when it is
     in that state, and its last sign of life. */
  const pulse = (on: NodeIdentity, jobId: string, state: ProgramState, since = Date.now(), signAt = Date.now()) =>
    handleNodeMessage(ctx, on, { type: 'job.program', jobId, state, since, screenAt: since, signAt });
  /* The node answers which of the turns Hornhoof asked about it still runs. */
  const answer = (on: NodeIdentity, asked: string[], held: string[]) =>
    handleNodeMessage(ctx, on, { type: 'jobs.held', asked, held } as unknown as NodeMessage);
  /* The node goes away and comes back as the test says; the hub knows since when it is away. */
  const away = () => { online = false; awayAt = Date.now(); };
  const back = () => { online = true; awayAt = null; };
  const facts = async (jobId: string) =>
    (await db.select({ data: agentEvents.data }).from(agentEvents).where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message')))).map(e => e.data as { text?: string; turnFact?: boolean }).filter(d => d.turnFact);
  return { ctx, db, companyId, ceo: ceo!, key: key!, plan: plan!, orchestrator: orchestrator!, hana: hana!, otto: otto!, node, later, message, job, turnsOf, running, sentRun, checks, pulse, answer, away, back, facts, send };
}

describe('a running turn that no live program holds', () => {
  it('ends when the node says it no longer runs it after its program went away, and the queue goes on', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    expect((await c.job(turn)).status).toBe('running');
    c.later();
    await c.pulse(c.node, turn, 'gone');
    const next = await c.message(c.hana.id, 'Orchestrator: three new reports wait for you.');
    expect((await c.job(next)).status).toBe('queued');
    c.later(2 * MIN);

    await reconcile(c.ctx, new Date());
    expect(c.checks()).toEqual([{ to: c.node.kind === 'node' ? c.node.nodeId : 'builtin', jobIds: [turn] }]);
    await c.answer(c.node, [turn], []);

    expect(await c.job(turn)).toMatchObject({ status: 'failed', error: 'machine_restarted' });
    expect((await c.facts(turn)).map(f => f.text)).toEqual([expect.stringMatching(/no longer runs this turn/)]);
    expect((await c.job(next)).status).toBe('running');
    expect(c.sentRun(next)).toBe(true);
  });

  it('ends at once when the program stands idle at its prompt and the node does not hold the turn', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'Bruno: the branch is pushed.');
    for (let i = 0; i < 3; i++) {
      c.later();
      await c.pulse(c.node, turn, 'idle');
    }

    await reconcile(c.ctx, new Date());
    await c.answer(c.node, [turn], []);

    expect((await c.job(turn)).status).toBe('failed');
    expect((await c.job(next)).status).toBe('running');
  });

  it('ends the orchestrator\'s turn left running by a server that restarted, and his waiting messages go out', async () => {
    const c = await company();
    /* What the server before the restart wrote: the turn went out to the built-in node, which no longer runs it. This server
       never heard of its program. */
    const [left] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.key.id, agentId: c.orchestrator.id, kind: 'conversation', status: 'running', prompt: 'Report.', timeoutMs: TURN_TIMEOUT_MS, startedAt: new Date(Date.now() - 30 * MIN), createdAt: new Date(Date.now() - 30 * MIN) }).returning();
    const waiting = [];
    for (let i = 0; i < 3; i++) waiting.push(await c.message(c.orchestrator.id, `Report ${i}.`));
    expect((await c.running(c.orchestrator.id)).map(j => j.id)).toEqual([left!.id]);

    await reconcile(c.ctx, new Date());
    expect(c.checks()).toEqual([{ to: 'builtin', jobIds: [left!.id] }]);
    await c.answer(BUILTIN, [left!.id], []);

    expect((await c.job(left!.id)).status).toBe('failed');
    const [goes] = await c.running(c.orchestrator.id);
    expect(waiting).toContain(goes!.id);
    expect(c.sentRun(goes!.id)).toBe(true);
  });

  it('ends a head\'s turn that no machine can run, as a plan\'s turn with no node, and the queue goes on', async () => {
    const c = await company();
    const [lost] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.plan.id, agentId: c.hana.id, kind: 'conversation', status: 'running', prompt: 'Plan.', timeoutMs: TURN_TIMEOUT_MS, startedAt: new Date(Date.now() - 10 * MIN), createdAt: new Date(Date.now() - 10 * MIN) }).returning();
    const next = await c.message(c.hana.id, 'Orchestrator: plan the next release.');
    expect((await c.job(next)).status).toBe('queued');

    await reconcile(c.ctx, new Date());

    expect((await c.job(lost!.id)).status).toBe('failed');
    expect((await c.facts(lost!.id)).map(f => f.text)).toEqual([expect.stringMatching(/no machine/)]);
    expect((await c.job(next)).status).toBe('running');
  });

  it('ends a turn the node does not list when it connects again, and the queue goes on', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'Orchestrator: plan the next release.');
    c.later();
    c.away();
    c.later();
    c.back();
    await handleNodeMessage(c.ctx, c.node, { type: 'hello', version: '0.5.0', loggedIn: true, running: [] });

    expect(await c.job(turn)).toMatchObject({ status: 'failed', error: 'machine_restarted' });
    expect((await c.job(next)).status).toBe('running');
  });
});

describe('a running turn with a live program', () => {
  it('goes on while its program thinks, however long, on the plan\'s node and on the built-in node', async () => {
    const c = await company();
    const hers = await c.message(c.hana.id, 'Plan the release.');
    const his = await c.message(c.orchestrator.id, 'Plan the company.');
    await c.message(c.hana.id, 'Orchestrator: one more thing.');
    for (let i = 0; i < 40; i++) {
      c.later();
      await c.pulse(c.node, hers, i % 2 ? 'thinking' : 'tool');
      await c.pulse(BUILTIN, his, 'thinking');
      await reconcile(c.ctx, new Date());
      const asked = c.checks().at(-1);
      /* A node that holds the turn says so; one that would say otherwise of a program it reports thinking is not believed. */
      if (asked?.to === 'builtin') await c.answer(BUILTIN, asked.jobIds, asked.jobIds);
      if (asked && asked.to !== 'builtin') await c.answer(c.node, asked.jobIds, []);
    }
    expect((await c.job(hers)).status).toBe('running');
    expect((await c.job(his)).status).toBe('running');
    expect(await c.db.select().from(requests)).toEqual([]);
  });

  it('is not asked about nor ended while its node is away for less than the usual reconnect window', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    c.later(3 * MIN);
    c.away();
    const before = c.checks().length;
    for (let i = 0; i < 4; i++) {
      c.later();
      await reconcile(c.ctx, new Date());
    }
    expect(c.checks().length).toBe(before);
    expect((await c.job(turn)).status).toBe('running');
    c.back();
    await c.pulse(c.node, turn, 'thinking');
    await reconcile(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('running');
  });
});

describe('a live program its queue waits behind', () => {
  it('wakes Operations once, not a person, when the program stands idle and its messages wait', async () => {
    const c = await company();
    const turn = await c.message(c.orchestrator.id, 'Plan the company.');
    c.later();
    const waiting = await c.message(c.orchestrator.id, 'Ivan: are you there?');
    expect((await c.job(waiting)).status).toBe('queued');
    const idle = Date.now();
    for (let i = 0; i < 6; i++) {
      c.later();
      /* The program sits at its prompt: its node still gives signs of it, so the quiet alarm stays silent. */
      await c.pulse(BUILTIN, turn, 'idle', idle);
      await reconcile(c.ctx, new Date());
      const asked = c.checks().at(-1);
      if (asked) await c.answer(BUILTIN, asked.jobIds, asked.jobIds);
    }

    const told = (await c.turnsOf(c.otto.id)).filter(j => j.prompt.includes('Orchestrator'));
    expect(told).toHaveLength(1);
    expect(told[0]!.prompt).toMatch(/queue/i);
    expect(told[0]!.prompt).toContain(turn);
    expect((await c.job(turn)).status).toBe('running');
    for (let i = 0; i < 3; i++) {
      c.later();
      await c.pulse(BUILTIN, turn, 'idle', idle);
      await reconcile(c.ctx, new Date());
    }
    expect((await c.turnsOf(c.otto.id)).filter(j => j.prompt.includes('Orchestrator'))).toHaveLength(1);
    expect(await c.db.select().from(requests)).toEqual([]);
  });
});
