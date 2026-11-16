import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { personColumns } from '../src/auth/session.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import {
  agentEvents,
  agents,
  assistantEvents,
  assistantReplies,
  assistantRequests,
  assistantSeqs,
  companies,
  departments,
  jobs,
  people,
  programDeliveries,
  programInstances,
  programOperatorCases,
  requests,
  subscriptions,
  tasks,
} from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { enqueueTurn, openTypedTurn, startProgram } from '../src/modules/conversation/queue.js';
import { appendEvent } from '../src/modules/events/store.js';
import { reserveDelivery } from '../src/modules/program-operator/deliveries.js';
import { as, createTestDb, listen, mcp, setUpCompany, testApp } from './helpers.js';
import { operatorCompany } from './program-operator-company.js';

const CEO_ORCH_TOKEN = 'tool-token-orch-isolation-0123456789';
const OPS_HEAD_TOKEN = 'tool-token-ops-isolation-01234567890';
const ASSISTANT_TABLES = ['assistants', 'assistant_events', 'assistant_seqs', 'assistant_replies', 'assistant_requests'] as const;

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const callSql = async (client: Client, statement: string): Promise<ToolResult> =>
  (await client.callTool({ name: 'database', arguments: { sql: statement } })) as ToolResult;

const resultText = (res: ToolResult): string => res.content[0]!.text;
const resultRows = (res: ToolResult): Record<string, unknown>[] => {
  expect(res.isError, resultText(res)).toBeFalsy();
  return (JSON.parse(resultText(res)) as { rows: Record<string, unknown>[] }[])[0]!.rows;
};

async function sqlFixture() {
  const { app, db } = await testApp();
  await listen(app);
  const ceoSession = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [ceo] = await db.select(personColumns).from(people).where(eq(people.isOwner, true));
  const [plan] = await db
    .insert(subscriptions)
    .values({ companyId: acme!.id, provider: 'claude', kind: 'personal', label: 'Ivan Claude', status: 'ready', ownerPersonId: ceo!.id })
    .returning();
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [ops] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [devHead] = await db
    .insert(agents)
    .values({ companyId: acme!.id, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev!.id, model: '', subscriptionId: plan!.id })
    .returning();
  const [worker] = await db
    .insert(agents)
    .values({ companyId: acme!.id, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: plan!.id })
    .returning();
  const [opsHead] = await db
    .insert(agents)
    .values({ companyId: acme!.id, kind: 'head', name: 'Wanda', roleKey: 'OPS-HEAD', departmentId: ops!.id, model: '', subscriptionId: plan!.id })
    .returning();

  const added = await app.inject({
    method: 'POST',
    url: '/api/people/assistants',
    payload: { name: 'Ava', owner: ceo!.id, program: 'avaclone', eventsUrl: 'https://ava.example.test/events' },
    ...as(ceoSession),
  });
  expect(added.statusCode).toBe(201);
  const assistantPersonId = (added.json() as { person: { id: string } }).person.id;
  const { key: assistantKey } = (await app.inject({ method: 'POST', url: `/api/people/${assistantPersonId}/key`, ...as(ceoSession) })).json() as { key: string };
  expect((await app.inject({ method: 'PATCH', url: `/api/people/${assistantPersonId}/assistant`, payload: { plan: plan!.id }, ...as(ceoSession) })).statusCode).toBe(200);
  const [assistantAgent] = await db.select().from(agents).where(eq(agents.kind, 'assistant'));

  const [assistantJob] = await db
    .insert(jobs)
    .values({
      companyId: acme!.id,
      subscriptionId: plan!.id,
      agentId: assistantAgent!.id,
      kind: 'conversation',
      prompt: 'Private note for Ava.',
      timeoutMs: 60_000,
      status: 'done',
    })
    .returning();
  const [workerJob] = await db
    .insert(jobs)
    .values({
      companyId: acme!.id,
      subscriptionId: plan!.id,
      agentId: worker!.id,
      kind: 'conversation',
      prompt: 'Check build.',
      timeoutMs: 60_000,
      status: 'done',
    })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({ companyId: acme!.id, departmentId: dev!.id, number: 1, title: 'Ship', brief: '', body: '', status: 'working', assigneeAgentId: worker!.id })
    .returning();
  const [req] = await db
    .insert(requests)
    .values({ companyId: acme!.id, taskId: task!.id, agentId: worker!.id, kind: 'question', text: 'Ready?', status: 'open' })
    .returning();

  await db.insert(assistantSeqs).values({ companyId: acme!.id, seq: 1 }).onConflictDoNothing();
  await db.insert(assistantEvents).values({ companyId: acme!.id, assistantId: assistantPersonId, seq: 1, kind: 'reply', data: { text: 'Secret reply' } });
  await db.insert(assistantReplies).values({
    companyId: acme!.id,
    assistantId: assistantPersonId,
    agentId: worker!.id,
    messageId: randomUUID(),
    jobId: workerJob!.id,
    afterSeq: 0,
  });
  await db.insert(assistantRequests).values({ assistantId: assistantPersonId, requestId: req!.id });

  const [orchTurn] = await db
    .insert(jobs)
    .values({
      companyId: acme!.id,
      subscriptionId: plan!.id,
      agentId: orchestrator!.id,
      kind: 'conversation',
      prompt: 'Check.',
      timeoutMs: 60_000,
      status: 'running',
      answersCeo: true,
      toolTokenHash: hashToken(CEO_ORCH_TOKEN),
    })
    .returning();
  await appendEvent(app.ctx, {
    companyId: acme!.id,
    agentId: orchestrator!.id,
    jobId: orchTurn!.id,
    kind: 'message',
    personId: ceo!.id,
    data: { text: 'Inspect company state.' },
  });
  await db.insert(jobs).values({
    companyId: acme!.id,
    subscriptionId: plan!.id,
    agentId: opsHead!.id,
    kind: 'conversation',
    prompt: 'Watch.',
    timeoutMs: 60_000,
    status: 'running',
    toolTokenHash: hashToken(OPS_HEAD_TOKEN),
  });

  return {
    app,
    db,
    ceoSession,
    ceo: ceo!,
    orchestrator: orchestrator!,
    devHead: devHead!,
    worker: worker!,
    opsHead: opsHead!,
    assistantPersonId,
    assistantKey,
    assistantAgent: assistantAgent!,
    assistantJob: assistantJob!,
    workerJob: workerJob!,
    opsClient: await mcp(app, OPS_HEAD_TOKEN),
    orchClient: await mcp(app, CEO_ORCH_TOKEN),
  };
}

describe('SQL isolation of personal assistants from OPS-HEAD', () => {
  it('grants readerRole zero table or column privileges on every assistant* table in public', async () => {
    const { $client: client } = await createTestDb();
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'assistant%' ORDER BY tablename",
    );
    expect(rows.map(r => r.tablename)).toEqual([...ASSISTANT_TABLES].sort());
    const reader = readerRole('postgres');
    const writer = agentRole('postgres');
    await client.exec(`${grantsFor(writer)};\n${readerGrantsFor(reader)}`);
    for (const table of ASSISTANT_TABLES) {
      const tablePriv = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('${reader}', 'public.${table}', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS has`,
      );
      const colPriv = await client.query<{ has: boolean }>(
        `SELECT has_any_column_privilege('${reader}', 'public.${table}', 'SELECT, INSERT, UPDATE, REFERENCES') AS has`,
      );
      expect(tablePriv.rows, `table privilege on ${table}`).toEqual([{ has: false }]);
      expect(colPriv.rows, `column privilege on ${table}`).toEqual([{ has: false }]);
    }
  });

  it('refuses OPS-HEAD reads of every assistant table directly and via JOIN, subquery, CTE, UNION and TABLE', async () => {
    const f = await sqlFixture();
    const queries = [
      'SELECT * FROM assistants',
      'SELECT person_id, program, agent_id FROM assistants',
      'SELECT person_id FROM public."assistants" WHERE false',
      'SELECT id, assistant_id, kind, data FROM assistant_events',
      'SELECT company_id, seq FROM assistant_seqs',
      'SELECT id, assistant_id, agent_id, job_id FROM assistant_replies',
      'SELECT assistant_id, request_id FROM assistant_requests',
      'TABLE assistants',
      'TABLE assistant_events',
      'SELECT p.id, a.agent_id FROM people p JOIN assistants a ON a.person_id = p.id',
      'SELECT p.id, a.program FROM people p LEFT JOIN assistants a ON a.person_id = p.id',
      'SELECT id FROM people p WHERE EXISTS (SELECT 1 FROM assistants a WHERE a.person_id = p.id)',
      'SELECT id FROM agents WHERE id IN (SELECT agent_id FROM assistant_replies)',
      'WITH ev AS (SELECT * FROM assistant_events) SELECT count(*)::int FROM ev',
      'SELECT id::text FROM companies UNION ALL SELECT company_id::text FROM assistant_seqs',
      'SELECT request_id FROM assistant_requests LIMIT 1',
    ];
    for (const statement of queries) {
      const res = await callSql(f.opsClient, statement);
      expect(res.isError, statement).toBe(true);
      expect(resultText(res), statement).toMatch(/permission denied/);
      expect(resultText(res), statement).toMatch(/closed to this tool/);
      expect(resultText(res), statement).not.toContain('Operations reads the database');
      expect(resultText(res), statement).not.toContain('name the other columns of assistants');
    }
  });

  it('hides agents rows with kind = assistant from OPS-HEAD across direct queries, JOINs, subqueries, CTEs, LATERAL, leaky quals and pg_stats', async () => {
    const f = await sqlFixture();
    const expectedNames = ['Bruno', 'Hana', 'Orchestrator', 'Wanda'];

    expect(resultRows(await callSql(f.opsClient, 'SELECT name, kind FROM agents ORDER BY name'))).toEqual([
      { name: 'Bruno', kind: 'worker' },
      { name: 'Hana', kind: 'head' },
      { name: 'Orchestrator', kind: 'orchestrator' },
      { name: 'Wanda', kind: 'head' },
    ]);
    expect(resultRows(await callSql(f.opsClient, "SELECT id, name FROM agents WHERE kind = 'assistant'"))).toEqual([]);
    expect(resultRows(await callSql(f.opsClient, `SELECT id, name FROM agents WHERE id = '${f.assistantAgent.id}'`))).toEqual([]);
    expect(resultRows(await callSql(f.opsClient, 'SELECT count(*)::int AS n FROM agents'))).toEqual([{ n: expectedNames.length }]);
    expect(resultRows(await callSql(f.opsClient, 'TABLE agents')).map(r => r.name).sort()).toEqual(expectedNames);

    /* INNER JOIN and LEFT JOIN from jobs cannot reveal the assistant agent's row or columns. */
    const innerJoined = resultRows(
      await callSql(
        f.opsClient,
        `SELECT j.id AS job_id, a.id AS agent_id, a.name FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id IN ('${f.assistantJob.id}', '${f.workerJob.id}')`,
      ),
    );
    expect(innerJoined).toEqual([{ job_id: f.workerJob.id, agent_id: f.worker.id, name: 'Bruno' }]);

    const leftJoined = resultRows(
      await callSql(
        f.opsClient,
        `SELECT j.id AS job_id, a.id AS agent_id, a.name, a.kind FROM jobs j LEFT JOIN agents a ON a.id = j.agent_id WHERE j.id = '${f.assistantJob.id}'`,
      ),
    );
    expect(leftJoined).toEqual([{ job_id: f.assistantJob.id, agent_id: null, name: null, kind: null }]);

    /* Subqueries (EXISTS, IN, scalar), MATERIALIZED CTE, LATERAL and UNION ALL. */
    expect(
      resultRows(
        await callSql(
          f.opsClient,
          `SELECT EXISTS (SELECT 1 FROM agents WHERE id = '${f.assistantAgent.id}') AS has_exists,
                  ('${f.assistantAgent.id}'::uuid IN (SELECT id FROM agents)) AS has_in,
                  (SELECT name FROM agents WHERE id = '${f.assistantAgent.id}') AS scalar_name`,
        ),
      ),
    ).toEqual([{ has_exists: false, has_in: false, scalar_name: null }]);

    expect(
      resultRows(
        await callSql(
          f.opsClient,
          `WITH all_agents AS MATERIALIZED (SELECT id, name, kind FROM agents)
           SELECT id, name FROM all_agents WHERE id = '${f.assistantAgent.id}' OR kind = 'assistant'`,
        ),
      ),
    ).toEqual([]);

    expect(
      resultRows(
        await callSql(
          f.opsClient,
          `SELECT p.id AS person_id, a.id AS agent_id FROM people p
           CROSS JOIN LATERAL (SELECT id FROM agents a WHERE a.created_by = p.id) a`,
        ),
      ),
    ).toEqual([]);

    expect(
      resultRows(
        await callSql(
          f.opsClient,
          "SELECT name FROM agents WHERE kind = 'worker' UNION ALL SELECT name FROM agents WHERE kind = 'assistant'",
        ),
      ),
    ).toEqual([{ name: 'Bruno' }]);

    /* Security barrier prevents leaky division-by-zero predicate from probing hidden assistant rows. */
    expect(
      resultRows(
        await callSql(
          f.opsClient,
          "SELECT count(*)::int AS n FROM agents WHERE 1 / (CASE WHEN kind = 'assistant' THEN 0 ELSE 1 END) = 1",
        ),
      ),
    ).toEqual([{ n: expectedNames.length }]);

    /* Planner statistics view pg_stats does not expose column values of RLS-protected agents to OPS-HEAD. */
    await f.db.execute(sql`ANALYZE agents, assistants`);
    expect(
      resultRows(
        await callSql(
          f.opsClient,
          "SELECT tablename, attname FROM pg_stats WHERE schemaname = 'public' AND tablename IN ('agents', 'assistants')",
        ),
      ),
    ).toEqual([]);
  });

  it('preserves owner access to personal assistants and standard Orchestrator / CEO SQL access', async () => {
    const f = await sqlFixture();

    /* Orchestrator in a CEO turn still sees agents rows (including assistant) while trigger protects assistant updates,
       and still reads non-secret columns of assistant tables while secrets and writes stay closed. */
    expect(
      resultRows(await callSql(f.orchClient, `SELECT id, name, kind FROM agents WHERE id = '${f.assistantAgent.id}'`)),
    ).toEqual([{ id: f.assistantAgent.id, name: 'Ava', kind: 'assistant' }]);
    const updateAssistantAgent = await callSql(f.orchClient, `UPDATE agents SET name = 'Ivy' WHERE id = '${f.assistantAgent.id}'`);
    expect(updateAssistantAgent.isError).toBe(true);
    expect(resultText(updateAssistantAgent)).toMatch(/an assistant's own agent belongs to its owner/);

    expect(resultRows(await callSql(f.orchClient, 'SELECT person_id, program, agent_id FROM assistants'))).toEqual([
      { person_id: f.assistantPersonId, program: 'avaclone', agent_id: f.assistantAgent.id },
    ]);
    expect(resultRows(await callSql(f.orchClient, 'SELECT seq FROM assistant_seqs'))).toEqual([{ seq: 1 }]);
    const writeSeq = await callSql(f.orchClient, 'UPDATE assistant_seqs SET seq = 99');
    expect(writeSeq.isError).toBe(true);
    expect(resultText(writeSeq)).toMatch(/permission denied/);

    /* Owner and assistant API continue to work with the personal assistant and its own agent. */
    expect((await f.app.inject({ url: `/api/agents/${f.assistantAgent.id}/events`, ...as(f.ceoSession) })).statusCode).toBe(200);
    const me = await f.app.inject({ url: '/api/assistant/me', headers: { authorization: `Bearer ${f.assistantKey}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ assistant: { id: f.assistantPersonId, agentId: f.assistantAgent.id } });
  });
});

describe('program-operator delivery and hooks on personal assistant turns', () => {
  it('attaches no operatorDelivery or operatorSourceDelivery when dispatching an assistant turn, while keeping it for employees', async () => {
    const c = await operatorCompany(true);
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockReturnValue(true);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));

    const [assistant] = await c.db
      .insert(agents)
      .values({ companyId: c.companyId, kind: 'assistant', name: 'Ava', model: '', subscriptionId: c.sub.id, nodeId: c.identity.nodeId })
      .returning();

    const assistantJobId = await enqueueTurn(c.ctx, {
      companyId: c.companyId,
      agentId: assistant!.id,
      prompt: 'Summarize my notes.',
      createdBy: c.sub.ownerPersonId,
    });
    const assistantRun = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'job.run' && frame.jobId === assistantJobId);
    expect(assistantRun?.type).toBe('job.run');
    if (assistantRun?.type !== 'job.run') throw new Error('Assistant turn was not dispatched.');
    expect(assistantRun.operatorDelivery).toBeUndefined();
    expect(assistantRun.operatorSourceDelivery).toBeUndefined();
    expect('operatorDelivery' in assistantRun).toBe(false);
    expect('operatorSourceDelivery' in assistantRun).toBe(false);
    expect(await c.db.select().from(programDeliveries).where(eq(programDeliveries.agentId, assistant!.id))).toEqual([]);

    /* A normal employee on the exact same node still receives operatorDelivery. */
    const workerJobId = await enqueueTurn(c.ctx, {
      companyId: c.companyId,
      agentId: c.agent.id,
      prompt: 'Check deployment.',
      createdBy: null,
    });
    const workerRun = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'job.run' && frame.jobId === workerJobId);
    expect(workerRun?.type).toBe('job.run');
    if (workerRun?.type !== 'job.run') throw new Error('Worker turn was not dispatched.');
    expect(workerRun.operatorDelivery).toEqual({ id: expect.any(String), ordinal: expect.any(Number) });
  });

  it('attaches no operatorDelivery on live words into a running assistant turn, while keeping it for employees', async () => {
    const c = await operatorCompany(true);
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockReturnValue(true);
    c.sent.mockImplementation((node, frame) => {
      if (frame.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, frame.ref, true));
      return true;
    });

    const [assistant] = await c.db
      .insert(agents)
      .values({ companyId: c.companyId, kind: 'assistant', name: 'Ava', model: '', subscriptionId: c.sub.id, nodeId: c.identity.nodeId })
      .returning();
    const [runningAssistant] = await c.db
      .insert(jobs)
      .values({
        companyId: c.companyId,
        agentId: assistant!.id,
        subscriptionId: c.sub.id,
        nodeId: c.identity.nodeId,
        kind: 'conversation',
        prompt: 'First question.',
        timeoutMs: 60_000,
        status: 'running',
      })
      .returning();

    const intoAssistant = await enqueueTurn(c.ctx, {
      companyId: c.companyId,
      agentId: assistant!.id,
      prompt: 'Follow-up for Ava.',
      createdBy: c.sub.ownerPersonId,
      message: { personId: c.sub.ownerPersonId, text: 'Follow-up for Ava.' },
    });
    expect(intoAssistant).toBe(runningAssistant!.id);

    const assistantSay = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'agent.say' && frame.agentKey === assistant!.id);
    expect(assistantSay?.type).toBe('agent.say');
    if (assistantSay?.type !== 'agent.say') throw new Error('Assistant live input was not sent.');
    expect(assistantSay.operatorDelivery).toBeUndefined();
    expect('operatorDelivery' in assistantSay).toBe(false);
    expect(await c.db.select().from(programDeliveries).where(eq(programDeliveries.agentId, assistant!.id))).toEqual([]);
    const [assistantEvent] = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, runningAssistant!.id));
    expect(assistantEvent!.data).not.toHaveProperty('operatorDelivery');

    /* A normal employee's running turn on the same node still receives live operatorDelivery. */
    const intoWorker = await enqueueTurn(c.ctx, {
      companyId: c.companyId,
      agentId: c.agent.id,
      prompt: 'Follow-up for worker.',
      createdBy: c.sub.ownerPersonId,
      message: { personId: c.sub.ownerPersonId, text: 'Follow-up for worker.' },
    });
    expect(intoWorker).toBe(c.job.id);
    const workerSay = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'agent.say' && frame.agentKey === c.agent.id);
    expect(workerSay?.type).toBe('agent.say');
    if (workerSay?.type !== 'agent.say') throw new Error('Worker live input was not sent.');
    expect(workerSay.operatorDelivery).toEqual({ id: expect.any(String), ordinal: expect.any(Number) });
  });

  it('does not hold, resume or replay pre-existing program-operator state on an agent with kind = assistant', async () => {
    const c = await operatorCompany(true);
    const instanceId = randomUUID();
    await c.db.insert(programInstances).values({ id: instanceId, companyId: c.companyId, agentId: c.agent.id, nodeId: c.identity.nodeId });
    const takenDelivery = await reserveDelivery(c.db, {
      companyId: c.companyId,
      agentId: c.agent.id,
      jobId: c.job.id,
      nodeId: c.identity.nodeId,
      kind: 'assignment',
      words: 'Old words.',
      reference: `old:${c.job.id}`,
    });
    await c.db.update(programDeliveries).set({ outcome: 'taken' }).where(eq(programDeliveries.id, takenDelivery.id));
    await appendEvent(c.ctx, {
      companyId: c.companyId,
      agentId: c.agent.id,
      jobId: c.job.id,
      personId: c.sub.ownerPersonId,
      kind: 'message',
      data: { text: 'Old words.' },
    });
    await c.db.insert(programOperatorCases).values({
      companyId: c.companyId,
      agentId: c.agent.id,
      jobId: c.job.id,
      nodeId: c.identity.nodeId,
      instance: instanceId,
      deliveryId: takenDelivery.id,
      reason: 'assignment_unrecorded',
      evidenceKey: takenDelivery.id,
      capability: 'cap',
      recoveryHold: true,
      deadlineAt: new Date(Date.now() + 60_000),
    });
    await c.db.update(jobs).set({ status: 'failed', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
    await c.db.update(agents).set({ kind: 'assistant', roleKey: null, departmentId: null }).where(eq(agents.id, c.agent.id));
    c.sent.mockClear();

    /* queuedOperatorAssignment is not used to open a key-less typed turn for kind = assistant. */
    expect(await openTypedTurn(c.ctx, c.identity, c.agent.id, 'Old words.', null, c.job.id)).toBeNull();

    /* startProgram does not call resumeOperatorProcess; it dispatches an ordinary empty start turn without operatorDelivery. */
    await startProgram(c.ctx, c.identity, c.agent.id);
    const startedRun = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'job.run');
    expect(startedRun?.type).toBe('job.run');
    if (startedRun?.type !== 'job.run') throw new Error('Start turn was not dispatched.');
    expect(startedRun.operatorDelivery).toBeUndefined();
    expect(startedRun.operatorSourceDelivery).toBeUndefined();
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, startedRun.jobId));

    /* A recoveryHold row does not block dispatching the assistant's own turn either. */
    const nextJobId = await enqueueTurn(c.ctx, {
      companyId: c.companyId,
      agentId: c.agent.id,
      prompt: 'Hello Ava.',
      createdBy: c.sub.ownerPersonId,
    });
    const nextRun = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'job.run' && frame.jobId === nextJobId);
    expect(nextRun?.type).toBe('job.run');
    if (nextRun?.type !== 'job.run') throw new Error('Queued assistant turn was held back.');
    expect(nextRun.operatorDelivery).toBeUndefined();
    expect(nextRun.operatorSourceDelivery).toBeUndefined();
  });
});
