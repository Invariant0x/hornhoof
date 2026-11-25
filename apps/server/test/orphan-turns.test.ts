import type { NodeMessage, ProgramState } from '@hornhoof/protocol';
import type { ProgramView } from '@hornhoof/protocol/program-operator';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, machines, nodes, people, requests, subscriptions } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { insertTurn, pump, TURN_TIMEOUT_MS } from '../src/modules/conversation/queue.js';
import { keyOf, nodeIdentity, type NodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { receiveOperatorReply } from '../src/modules/program-operator/rpc.js';
import { moveStalledQueues } from '../src/modules/tasks/orphan-turns.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { cancelJob, CANCEL_END_WAIT_MS } from '../src/modules/tasks/wake.js';
import { jobOf } from '../src/modules/tools/job.js';
import { BUILTIN } from './builtin.js';
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
    (await db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message')))).map(e => e.data as { text?: string; turnFact?: boolean }).filter(d => d.turnFact);
  /* What the turn's program streams through its node while it works with no screen: a line of its answer. */
  let seq = 0;
  const said = (on: NodeIdentity, jobId: string) =>
    handleNodeMessage(ctx, on, { type: 'job.event', jobId, seq: seq++, event: { kind: 'text', text: `Step ${seq}.` } } as NodeMessage);
  /* The turn's program calls a Hornhoof tool with the turn's token, as its MCP bridge does. */
  const called = async (jobId: string) => {
    const token = `token-${jobId}`;
    await db.update(jobs).set({ toolTokenHash: hashToken(token) }).where(eq(jobs.id, jobId));
    /* A turn that ended has no valid token any more: its call is refused, as the bridge refuses it. */
    await jobOf(ctx, { headers: { authorization: `Bearer ${token}` } } as FastifyRequest).catch(() => undefined);
  };
  /* The node says which agents' programs run on it, as it does with its load each minute. */
  const live = (on: NodeIdentity, agentIds: string[]) =>
    handleNodeMessage(ctx, on, { type: 'load', cpus: 8, load: 0, memFree: 32 * 2 ** 30, memTotal: 64 * 2 ** 30, tests: 0, jobs: 1, live: agentIds });
  /* A round of the watchdog, and the node's answer that it holds every turn it was asked about in it. */
  const roundHeld = async (on: NodeIdentity) => {
    const before = checks().length;
    await reconcile(ctx, new Date());
    for (const asked of checks().slice(before)) await answer(on, asked.jobIds, asked.jobIds);
  };
  const alarmsOf = async (agentId: string) => (await turnsOf(otto!.id)).filter(j => j.prompt.includes('turn alarm') && j.prompt.includes(agentId));
  return { ctx, db, companyId, ceo: ceo!, key: key!, plan: plan!, orchestrator: orchestrator!, hana: hana!, otto: otto!, node, later, message, job, turnsOf, running, sentRun, checks, pulse, answer, away, back, facts, send, said, called, live, roundHeld, alarmsOf };
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
    expect(c.checks()).toEqual([{ to: c.node.kind === 'node' ? c.node.nodeId : keyOf(BUILTIN), jobIds: [turn] }]);
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
    expect(c.checks()).toEqual([{ to: keyOf(BUILTIN), jobIds: [left!.id] }]);
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

describe('a terminal exit whose final job result was lost', () => {
  it('fails the exact departed program even when the node still holds its job', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Review the branch.');
    const next = await c.message(c.hana.id, 'The repairs are ready.');
    c.later(2 * MIN);
    await c.pulse(c.node, turn, 'gone');
    c.later(MIN);
    await c.answer(c.node, [turn], [turn]);
    expect((await c.job(turn)).status).toBe('running');
    c.later(MIN);
    /* A terminal node names the programs that run on it with each of its load reports (apps/node/src/main.ts:694). */
    await c.live(c.node, [c.orchestrator.id]);
    await c.answer(c.node, [turn], [turn]);
    expect(await c.job(turn)).toMatchObject({ status: 'failed', error: 'machine_restarted' });
    expect((await c.job(next)).status).toBe('running');
    expect((await c.facts(turn)).map(f => f.text)).toEqual([expect.stringMatching(/program was gone/)]);
    const sent = c.send.mock.calls.map(([, frame]) => frame);
    const cancel = sent.findIndex(frame => frame.type === 'job.cancel' && frame.jobId === turn);
    const run = sent.findIndex(frame => frame.type === 'job.run' && frame.jobId === next);
    expect(cancel).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(cancel);
    await c.answer(c.node, [turn], [turn]);
    expect(await c.facts(turn)).toHaveLength(1);
  });

  it('keeps a held turn when a foreign node reports an exit or newer work supersedes it', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Review the branch.');
    c.later(2 * MIN);
    await c.pulse(BUILTIN, turn, 'gone');
    c.later(3 * MIN);
    await c.answer(c.node, [turn], [turn]);
    expect((await c.job(turn)).status).toBe('running');
    await c.pulse(c.node, turn, 'gone');
    c.later(MIN);
    await c.pulse(c.node, turn, 'thinking');
    c.later(3 * MIN);
    await c.answer(c.node, [turn], [turn]);
    expect((await c.job(turn)).status).toBe('running');
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
      if (asked?.to === keyOf(BUILTIN)) await c.answer(BUILTIN, asked.jobIds, asked.jobIds);
      if (asked && asked.to !== keyOf(BUILTIN)) await c.answer(c.node, asked.jobIds, []);
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
  function screens(c: Awaited<ReturnType<typeof company>>, turn: string) {
    vi.spyOn(c.ctx.hub, 'hasProgramOperator').mockReturnValue(true);
    let view: Partial<ProgramView> = {};
    const asked: string[] = [];
    c.send.mockImplementation((node, msg) => {
      if (msg.type === 'program.view_get') {
        asked.push(keyOf(node));
        receiveOperatorReply(c.ctx, node, {
          type: 'program.view', agentKey: msg.agentKey, request: msg.request,
          result: 'ok', reason: null, snapshot: 'fresh-snapshot', instance: 'program-1', jobId: turn,
          state: 'idle', tool: null, question: null, input: 'empty', undelivered: false,
          cols: 80, rows: 24, cells: 'completed turn and empty prompt', ...view,
        });
      }
      return true;
    });
    return { asked, show: (next: Partial<ProgramView>) => { view = next; } };
  }

  it('closes a lost end from two independent idle screens even while rejected hooks leave work reported', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'The branch is ready.');
    const screen = screens(c, turn);
    const lastSign = Date.now();
    c.later(2 * MIN);
    await c.pulse(c.node, turn, 'thinking', lastSign, lastSign);
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('running');
    c.later(2 * MIN);
    await c.pulse(c.node, turn, 'thinking', lastSign, lastSign);
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('done');
    expect((await c.job(next)).status).toBe('running');
    expect(screen.asked).toEqual([keyOf(c.node), keyOf(c.node)]);
  });

  it('keeps two completed observations across rotating chrome only with the same explicit response proof', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const screen = screens(c, turn);
    const proof = 'a'.repeat(64);
    screen.show({ completion: proof, cells: 'response with the first toolbar tip' });
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    screen.show({ completion: proof, cells: 'same response with another toolbar tip' });
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('done');
  });

  it('restarts completed observations for changed response proof and legacy screen content', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const screen = screens(c, turn);
    screen.show({ completion: 'a'.repeat(64) });
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    screen.show({ completion: 'b'.repeat(64) });
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('running');
    screen.show({ cells: 'legacy response changed' });
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('running');
  });

  it('closes a lost end with no waiting message and does not inherit idle time across instances or activity', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const screen = screens(c, turn);
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    screen.show({ instance: 'program-2' });
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('running');
    screen.show({ instance: 'program-2', state: 'working' });
    c.later();
    await moveStalledQueues(c.ctx, new Date());
    screen.show({ instance: 'program-2' });
    c.later();
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('running');
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('done');
  });

  it.each([
    { jobId: 'another-turn' }, { result: 'refused' as const }, { state: 'working' as const },
    { tool: 'Bash' }, { input: 'words' as const }, { input: 'unknown' as const },
    { undelivered: true }, { instance: null }, { snapshot: null },
    { question: { id: 'q', kind: 'permission' as const, text: 'Allow?', tool: 'Bash', callId: null } },
  ])('does not close from unsafe or uncertain screen %j', async unsafe => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const screen = screens(c, turn);
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    screen.show(unsafe);
    c.later(2 * MIN);
    await moveStalledQueues(c.ctx, new Date());
    screen.show({});
    c.later();
    await moveStalledQueues(c.ctx, new Date());
    expect((await c.job(turn)).status).toBe('running');
  });

  it('keeps running a turn whose views show an idle empty input line with job=null: nothing closes a turn on silence alone', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'The branch is ready.');
    const screen = screens(c, turn);
    const lastSign = Date.now();
    screen.show({ jobId: null, state: 'working', tool: 'call_mcp_tool', input: 'empty' });
    for (let look = 0; look < 3; look++) {
      c.later(2 * MIN);
      await c.pulse(c.node, turn, 'tool', lastSign, lastSign);
      await moveStalledQueues(c.ctx, new Date());
    }
    expect((await c.job(turn)).status).toBe('running');
    expect((await c.job(next)).status).toBe('queued');
  });

  it('keeps running a turn whose views report no_program: nothing closes a turn on silence alone', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'The branch is ready.');
    const screen = screens(c, turn);
    screen.show({ result: 'refused', reason: 'no_program', state: 'gone', snapshot: null, instance: null, jobId: null, input: 'unknown' });
    for (let look = 0; look < 3; look++) {
      c.later(2 * MIN);
      await moveStalledQueues(c.ctx, new Date());
    }
    expect((await c.job(turn)).status).toBe('running');
    expect((await c.job(next)).status).toBe('queued');
  });

  /* The orchestrator's turn its node still runs, whose program has stood idle at its prompt since a minute after it began,
     while Ivan's message waits behind it: the end of that turn never reached Hornhoof. */
  async function idleBehind(c: Awaited<ReturnType<typeof company>>) {
    const turn = await c.message(c.orchestrator.id, 'Plan the company.');
    c.later();
    const waiting = await c.message(c.orchestrator.id, 'Ivan: are you there?');
    const idle = Date.now();
    const round = async () => {
      c.later();
      await c.pulse(BUILTIN, turn, 'idle', idle);
      await reconcile(c.ctx, new Date());
      const asked = c.checks().at(-1);
      if (asked) await c.answer(BUILTIN, asked.jobIds, asked.jobIds);
    };
    return { turn, waiting, round };
  }
  const sentOf = (c: Awaited<ReturnType<typeof company>>, type: string) =>
    c.send.mock.calls.flatMap(([, m], i) => ((m as { type: string }).type === type ? [{ i, jobId: (m as { jobId?: string }).jobId }] : []));
  const toldOtto = async (c: Awaited<ReturnType<typeof company>>) => (await c.turnsOf(c.otto.id)).filter(j => j.prompt.includes(c.orchestrator.name));

  it('closes the turn once its live program stands idle at its prompt and gives the waiting messages to the same session', async () => {
    const c = await company();
    const { turn, waiting, round } = await idleBehind(c);
    expect((await c.job(waiting)).status).toBe('queued');
    await round();
    expect((await c.job(turn)).status).toBe('running');
    await round();

    expect(await c.job(turn)).toMatchObject({ status: 'done' });
    expect((await c.facts(turn)).map(f => f.text)).toEqual([expect.stringMatching(/idle at its prompt/)]);
    expect((await c.job(waiting)).status).toBe('running');
    const [cancel] = sentOf(c, 'job.cancel');
    const run = sentOf(c, 'job.run').find(r => r.jobId === waiting);
    expect(cancel).toMatchObject({ jobId: turn });
    expect(run!.i).toBeGreaterThan(cancel!.i);
    /* The program goes on in its session: nothing starts it again or closes it. */
    expect([...sentOf(c, 'agent.restart'), ...sentOf(c, 'agent.release')]).toEqual([]);
    expect(await toldOtto(c)).toEqual([]);
    /* The node's own end of the closed turn comes later and changes nothing. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: turn, ok: false, sessionId: null, result: '', tail: '', error: 'cancelled' });
    expect(await c.job(turn)).toMatchObject({ status: 'done' });
    expect((await c.job(waiting)).status).toBe('running');
  });

  it('wakes Operations once, not a person, when the queue still stands after that', async () => {
    const c = await company();
    const first = await idleBehind(c);
    await first.round();
    await first.round();
    expect((await c.job(first.waiting)).status).toBe('running');
    c.later();
    const more = await c.message(c.orchestrator.id, 'Ivan: hello?');
    const idle = Date.now();
    for (let i = 0; i < 4; i++) {
      c.later();
      await c.pulse(BUILTIN, first.waiting, 'idle', idle);
      await reconcile(c.ctx, new Date());
      const asked = c.checks().at(-1);
      if (asked) await c.answer(BUILTIN, asked.jobIds, asked.jobIds);
    }

    const told = await toldOtto(c);
    expect(told).toHaveLength(1);
    expect(told[0]!.prompt).toMatch(/queue/i);
    expect(told[0]!.prompt).toContain(first.waiting);
    expect((await c.job(first.waiting)).status).toBe('running');
    expect((await c.job(more)).status).toBe('queued');
    for (let i = 0; i < 3; i++) {
      c.later();
      await c.pulse(BUILTIN, first.waiting, 'idle', idle);
      await reconcile(c.ctx, new Date());
    }
    expect(await toldOtto(c)).toHaveLength(1);
    expect(await c.db.select().from(requests)).toEqual([]);
  });
});

describe('a turn whose program runs with no screen', () => {
  it('raises no node_silent alarm while its node streams the events of its work, however long', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    for (let i = 0; i < 24; i++) {
      c.later(5 * MIN);
      await c.said(c.node, turn);
      await c.roundHeld(c.node);
    }
    expect(await c.alarmsOf(c.hana.id)).toEqual([]);
    expect((await c.job(turn)).status).toBe('running');
  });

  it('raises no node_silent alarm while it calls Hornhoof tools through its bridge', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    for (let i = 0; i < 24; i++) {
      c.later(5 * MIN);
      await c.called(turn);
      await c.roundHeld(c.node);
    }
    expect(await c.alarmsOf(c.hana.id)).toEqual([]);
    expect((await c.job(turn)).status).toBe('running');
  });

  it('raises one node_silent alarm once its work has stood still as long as the quiet, counted from its last event', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    for (let i = 0; i < 6; i++) {
      c.later(5 * MIN);
      await c.said(c.node, turn);
      await c.roundHeld(c.node);
    }
    const last = Date.now();
    c.later(9 * MIN);
    await c.roundHeld(c.node);
    expect(await c.alarmsOf(c.hana.id)).toEqual([]);
    c.later(MIN);
    await c.roundHeld(c.node);
    const [alarm, ...more] = await c.alarmsOf(c.hana.id);
    expect(more).toEqual([]);
    expect(alarm!.prompt).toContain('node_silent');
    expect(alarm!.prompt).toContain(new Date(last).toISOString());
    expect((await c.job(turn)).status).toBe('running');
  });

  it('is not ended while its tools go on, even when its node no longer lists it', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'Orchestrator: one more thing.');
    for (let i = 0; i < 4; i++) {
      c.later();
      await c.called(turn);
      await reconcile(c.ctx, new Date());
      const asked = c.checks().at(-1);
      if (asked) await c.answer(c.node, asked.jobIds, []);
    }
    expect((await c.job(turn)).status).toBe('running');
    expect((await c.job(next)).status).toBe('queued');
  });
});

describe('a turn its node still lists whose program is gone', () => {
  /* Hana's turn went out to the laptop, whose node reported her program gone a minute later, while Bruno's word waits behind
     it. The node still lists the turn when asked. */
  async function goneHeld(c: Awaited<ReturnType<typeof company>>) {
    const turn = await c.message(c.hana.id, 'Plan the release.');
    c.later();
    await c.pulse(c.node, turn, 'gone');
    const next = await c.message(c.hana.id, 'Bruno: the branch is pushed.');
    c.later(2 * MIN);
    return { turn, next };
  }

  it('ends as interrupted once the node names no program of hers and the turn gives no sign of work, and the queue goes on', async () => {
    const c = await company();
    const { turn, next } = await goneHeld(c);
    await c.live(c.node, [c.orchestrator.id]);
    await c.roundHeld(c.node);

    expect(await c.job(turn)).toMatchObject({ status: 'failed', error: 'machine_restarted' });
    expect((await c.facts(turn)).map(f => f.text)).toEqual([expect.stringMatching(/program was gone/)]);
    expect((await c.job(next)).status).toBe('running');
    expect(c.sentRun(next)).toBe(true);
    expect(await c.alarmsOf(c.hana.id)).toEqual([]);
  });

  it('goes on while the node still names her program, as after a restart of it', async () => {
    const c = await company();
    const { turn, next } = await goneHeld(c);
    await c.live(c.node, [c.hana.id]);
    await c.roundHeld(c.node);

    expect((await c.job(turn)).status).toBe('running');
    expect((await c.job(next)).status).toBe('queued');
  });

  it('goes on while the node has said nothing of its programs since the program went', async () => {
    const c = await company();
    await c.live(c.node, []);
    const { turn } = await goneHeld(c);
    await c.roundHeld(c.node);

    expect((await c.job(turn)).status).toBe('running');
  });

  it('goes on while the turn still streams its work', async () => {
    const c = await company();
    const { turn, next } = await goneHeld(c);
    await c.said(c.node, turn);
    await c.live(c.node, []);
    await c.roundHeld(c.node);

    expect((await c.job(turn)).status).toBe('running');
    expect((await c.job(next)).status).toBe('queued');
  });

  /* A node that falls silent says no list of its programs either: the turn is not held for ever, it ends by the path of a
     machine that went away, five minutes after the hub found it gone. */
  it('ends as a turn of a machine that went away when the node falls silent after the program went, naming no programs', async () => {
    const c = await company();
    const { turn } = await goneHeld(c);
    await c.roundHeld(c.node);
    expect((await c.job(turn)).status).toBe('running');

    c.away();
    for (let i = 0; i < 5; i++) {
      c.later();
      await reconcile(c.ctx, new Date());
      expect((await c.job(turn)).status).toBe('running');
    }
    c.later();
    await reconcile(c.ctx, new Date());
    expect(await c.job(turn)).toMatchObject({ status: 'failed', error: 'machine_offline' });
  });

  it('keeps a running turn whose node lists no live program for the employee but never said it is gone', async () => {
    const c = await company();
    const start = Date.now();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'Bruno: the branch is pushed.');
    c.later(3 * MIN);
    await c.pulse(c.node, turn, 'tool', start, start);
    await c.live(c.node, [c.orchestrator.id]);
    await c.roundHeld(c.node);

    expect((await c.job(turn)).status).toBe('running');
    expect((await c.job(next)).status).toBe('queued');
  });

  it('keeps a running turn with no sign of life past the turn timeout: nothing closes it', async () => {
    const c = await company();
    const start = Date.now();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'Bruno: the branch is pushed.');
    c.later(TURN_TIMEOUT_MS + MIN);
    await c.pulse(c.node, turn, 'tool', start, start);
    await reconcile(c.ctx, new Date());
    c.later(MIN);
    await c.pulse(c.node, turn, 'tool', start, start);
    await reconcile(c.ctx, new Date());

    expect((await c.job(turn)).status).toBe('running');
    expect((await c.job(next)).status).toBe('queued');
  });
});

/* #1695: Stop asks the turn's node to end it (job.cancel). A node that never reports the end (an old one, or one whose
   program was already gone) must not hold the employee's queue: after CANCEL_END_WAIT_MS the watchdog closes the turn as
   Stop does when no node is there, and the next waiting turn goes out. */
describe('a turn Stop called off whose end never comes', () => {
  /* Hana works on a turn on her laptop's node, which is connected, and her next message waits behind it; Stop asks the node. */
  async function stopped() {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'Orchestrator: three new reports wait for you.');
    expect((await c.job(next)).status).toBe('queued');
    await cancelJob(c.ctx, turn);
    expect(c.send.mock.calls.filter(([, m]) => m.type === 'job.cancel' && m.jobId === turn)).toHaveLength(1);
    expect((await c.job(turn)).status).toBe('running');
    return { ...c, turn, next };
  }
  /* The node's report that the turn ended as stopped. */
  const endOf = (jobId: string) => ({ type: 'job.done', jobId, ok: false, sessionId: null, result: 'Stopped.', tail: '', error: 'cancelled' }) as NodeMessage;
  const stops = async (c: Awaited<ReturnType<typeof stopped>>) =>
    (await c.db.select(only(agentEvents, 'id')).from(agentEvents).where(and(eq(agentEvents.jobId, c.turn), eq(agentEvents.kind, 'stopped')))).length;

  it('is closed as stopped once the wait is over when the node never reports its end, and the next turn goes out', async () => {
    const c = await stopped();
    c.later(CANCEL_END_WAIT_MS - 1);
    await reconcile(c.ctx, new Date());
    expect((await c.job(c.turn)).status).toBe('running');
    expect(c.sentRun(c.next)).toBe(false);

    c.later(1);
    await reconcile(c.ctx, new Date());
    expect(await c.job(c.turn)).toMatchObject({ status: 'failed', error: 'cancelled', result: 'Stopped.' });
    expect(await stops(c)).toBe(1);
    expect((await c.job(c.next)).status).toBe('running');
    expect(c.sentRun(c.next)).toBe(true);
  });

  it('closes once when the node reports the end in time, and the wait then does nothing', async () => {
    const c = await stopped();
    c.later(CANCEL_END_WAIT_MS / 2);
    await handleNodeMessage(c.ctx, c.node, endOf(c.turn));
    const closed = await c.job(c.turn);
    expect(closed).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect((await c.job(c.next)).status).toBe('running');

    c.later(CANCEL_END_WAIT_MS);
    await reconcile(c.ctx, new Date());
    expect(await c.job(c.turn)).toEqual(closed);
    expect(await stops(c)).toBe(1);
    expect(c.send.mock.calls.filter(([, m]) => m.type === 'job.run' && m.jobId === c.next)).toHaveLength(1);
  });

  it('ignores an end the node reports after the wait closed the turn, with no second close', async () => {
    const c = await stopped();
    c.later(CANCEL_END_WAIT_MS);
    await reconcile(c.ctx, new Date());
    const closed = await c.job(c.turn);
    expect(closed).toMatchObject({ status: 'failed', error: 'cancelled' });

    c.later();
    await expect(handleNodeMessage(c.ctx, c.node, endOf(c.turn))).resolves.not.toThrow();
    expect(await c.job(c.turn)).toEqual(closed);
    expect(await stops(c)).toBe(1);
    expect(c.send.mock.calls.filter(([, m]) => m.type === 'job.run' && m.jobId === c.next)).toHaveLength(1);
  });

  it('closes at once, as before, when no node is there to ask', async () => {
    const c = await company();
    const turn = await c.message(c.hana.id, 'Plan the release.');
    const next = await c.message(c.hana.id, 'Orchestrator: three new reports wait for you.');
    c.send.mockReturnValueOnce(false);
    await cancelJob(c.ctx, turn);
    expect(await c.job(turn)).toMatchObject({ status: 'failed', error: 'cancelled', result: 'Stopped.' });
    expect((await c.job(next)).status).toBe('running');
  });
});
