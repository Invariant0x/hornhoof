import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { agentEvents, agents, departments, jobs, programDeliveries, programInstances } from '../src/db/schema.js';
import * as timersModule from '../src/modules/agents/timers.js';
import { pump } from '../src/modules/conversation/queue.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { wordsDigest } from '../src/modules/program-operator/deliveries.js';
import { agentFailureStates } from '../src/modules/tasks/failure-records.js';
import { alreadyAlerted } from '../src/modules/tasks/silent.js';
import { freshPglite, ownDatabases, statements } from './helpers-db.js';
import { migrationsBefore } from './migrations-before.js';
import { operatorCompany } from './program-operator-company.js';

ownDatabases();

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Total Time'?: number;
  Plans?: PlanNode[];
};

type ExplainEntry = {
  Plan: PlanNode;
  'Execution Time'?: number;
};

function collectNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(collectNodes)];
}

async function explainSql(client: PGlite, text: string, params: unknown[]): Promise<{ nodes: PlanNode[]; executionMs: number }> {
  const { rows } = await client.query<{ 'QUERY PLAN': ExplainEntry[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params);
  const entry = rows[0]!['QUERY PLAN'][0]!;
  return { nodes: collectNodes(entry.Plan), executionMs: entry['Execution Time'] ?? 0 };
}

function indexNames(nodes: readonly PlanNode[]): string[] {
  return nodes.flatMap(n => (n['Index Name'] ? [n['Index Name']] : []));
}

function seqScanTables(nodes: readonly PlanNode[]): string[] {
  return nodes.filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name']).map(n => n['Relation Name']!);
}

async function hotIndexesMigrationSql(): Promise<string> {
  const journal = JSON.parse(await readFile(`${MIGRATIONS}/meta/_journal.json`, 'utf8')) as { entries: { tag: string }[] };
  const entry = journal.entries.find(item => item.tag.endsWith('_hot_query_indexes'));
  expect(entry?.tag).toBeDefined();
  return readFile(`${MIGRATIONS}/${entry!.tag}.sql`, 'utf8');
}

async function seedVolume() {
  const c = await operatorCompany();
  const client = (c.db as unknown as { $client: PGlite }).$client;
  const now = new Date('2026-11-20T12:00:00Z');
  const [dev] = await c.db.insert(departments).values({ companyId: c.companyId, name: 'Engineering', roleCode: 'ENG' }).returning();
  const extraAgents: string[] = [c.agent.id, c.head.id, c.watcher.id];
  const agentBatch = Array.from({ length: 17 }, (_, i) => ({
    companyId: c.companyId,
    departmentId: dev!.id,
    kind: 'worker' as const,
    name: `SynthAgent${i + 1}`,
    model: '',
    subscriptionId: c.sub.id,
  }));
  const insertedAgents = await c.db.insert(agents).values(agentBatch).returning({ id: agents.id });
  for (const row of insertedAgents) extraAgents.push(row.id);

  await c.db.update(jobs).set({ status: 'done', startedAt: new Date(+now - 35 * 60_000), finishedAt: new Date(+now - 30 * 60_000) }).where(eq(jobs.id, c.job.id));

  /* Bulk-insert 1,200 conversation jobs across 20 agents, 3,000 agent_events and 200 program_deliveries. */
  const jobRows = [];
  for (let i = 0; i < 1200; i++) {
    const agentId = extraAgents[i % extraAgents.length]!;
    const createdAt = new Date(+now - (2000 - i) * 60_000);
    const finishedAt = new Date(+createdAt + 30_000);
    const status = i % 40 === 0 ? 'obsolete' as const : i % 15 === 0 ? 'failed' as const : 'done' as const;
    jobRows.push({
      companyId: c.companyId,
      subscriptionId: c.sub.id,
      nodeId: c.identity.nodeId,
      agentId,
      kind: 'conversation' as const,
      prompt: `Synthetic prompt ${i}`,
      timeoutMs: 60_000,
      status,
      error: status === 'failed' ? 'agent_failed' : null,
      failure: status === 'failed' ? { kind: 'overloaded' as const, retryable: true, text: `Failure ${i}` } : null,
      createdAt,
      startedAt: createdAt,
      finishedAt,
    });
  }
  const insertedJobs = await c.db.insert(jobs).values(jobRows).returning({ id: jobs.id, agentId: jobs.agentId });

  /* Add a two-step failed continuation chain and a queued retry for deterministic assertion in agentFailureStates. */
  const chainFirst = insertedJobs.find(j => j.agentId === extraAgents[3])!;
  const chainSecond = insertedJobs.find(j => j.agentId === extraAgents[3] && j.id !== chainFirst.id)!;
  await c.db.update(jobs).set({
    status: 'failed',
    error: 'agent_failed',
    failure: { kind: 'overloaded', retryable: true, text: 'Provider overloaded.' },
    tail: '529',
    createdAt: new Date(+now - 27 * 60_000),
    finishedAt: new Date(+now - 26 * 60_000),
  }).where(eq(jobs.id, chainFirst.id));
  await c.db.update(jobs).set({
    status: 'failed',
    error: 'agent_failed',
    failure: { kind: 'network', retryable: true, text: 'Socket closed.' },
    tail: 'EOF',
    continueOf: chainFirst.id,
    createdAt: new Date(+now - 25 * 60_000),
    finishedAt: new Date(+now - 24 * 60_000),
  }).where(eq(jobs.id, chainSecond.id));
  await c.db.insert(jobs).values({
    companyId: c.companyId,
    subscriptionId: c.sub.id,
    agentId: extraAgents[3]!,
    kind: 'conversation',
    prompt: 'Retry synthetic prompt',
    timeoutMs: 60_000,
    status: 'queued',
    continueOf: chainSecond.id,
    notBefore: new Date(+now + 60_000),
    createdAt: new Date(+now - 23 * 60_000),
  });

  const eventRows = [];
  for (let i = 0; i < 200; i++) {
    eventRows.push({
      companyId: c.companyId,
      agentId: c.agent.id,
      jobId: c.job.id,
      kind: 'text' as const,
      data: { text: `Active turn chunk ${i}` },
      createdAt: new Date(+now - (4500 - i) * 1000),
    });
  }
  for (let i = 0; i < 3000; i++) {
    const job = insertedJobs[i % insertedJobs.length]!;
    eventRows.push({
      companyId: c.companyId,
      agentId: job.agentId!,
      jobId: job.id,
      kind: i % 3 === 0 ? 'message' as const : i % 3 === 1 ? 'text' as const : 'tool' as const,
      data: { text: `Synthetic event ${i}` },
      createdAt: new Date(+now - (4000 - i) * 1000),
    });
  }
  const alertedJobId = insertedJobs[0]!.id;
  eventRows.push({
    companyId: c.companyId,
    agentId: c.watcher.id,
    jobId: alertedJobId,
    kind: 'message' as const,
    data: { text: 'Alarm sent.', silentJob: alertedJobId },
    createdAt: new Date(+now - 10_000),
  });
  for (let i = 0; i < eventRows.length; i += 500) {
    await c.db.insert(agentEvents).values(eventRows.slice(i, i + 500));
  }

  const evidenceDeliveryId = randomUUID();
  const evidenceInstanceId = randomUUID();
  await c.db.insert(programInstances).values({
    id: evidenceInstanceId,
    companyId: c.companyId,
    agentId: c.agent.id,
    nodeId: c.identity.nodeId,
    launched: true,
    active: true,
  });
  const evidenceText = 'Live evidence words.';
  const deliveryRows = [];
  for (let i = 0; i < 200; i++) {
    const job = insertedJobs[i % insertedJobs.length]!;
    deliveryRows.push({
      id: randomUUID(),
      companyId: c.companyId,
      agentId: job.agentId!,
      jobId: job.id,
      nodeId: c.identity.nodeId,
      ordinal: i + 100,
      reference: `ref-${i}`,
      kind: 'assignment' as const,
      digest: wordsDigest(`Words ${i}`),
      outcome: 'taken' as const,
      createdAt: new Date(+now - (600 - i) * 1000),
    });
  }
  deliveryRows.push({
    id: evidenceDeliveryId,
    companyId: c.companyId,
    agentId: c.agent.id,
    jobId: c.job.id,
    nodeId: c.identity.nodeId,
    instance: evidenceInstanceId,
    ordinal: 1000,
    reference: 'ref-evidence',
    kind: 'live' as const,
    digest: wordsDigest(evidenceText),
    outcome: 'pending' as const,
    createdAt: new Date(+now - 2000),
  });
  await c.db.insert(programDeliveries).values(deliveryRows);
  await c.db.insert(agentEvents).values([
    {
      companyId: c.companyId,
      agentId: c.agent.id,
      jobId: c.job.id,
      kind: 'message',
      data: { text: evidenceText, operatorDelivery: { id: evidenceDeliveryId, ordinal: 1000 } },
    },
  ]);

  await client.exec('ANALYZE jobs, agent_events, program_deliveries, program_instances, program_operator_cases, agents');

  return {
    ...c,
    client,
    now,
    extraAgents,
    alertedJobId,
    evidenceDeliveryId,
    evidenceInstanceId,
    evidenceText,
  };
}

describe('minuteRound bounded concurrency', () => {
  it('caps concurrent sweeps in runBounded while finishing every item', async () => {
    const runBounded = (timersModule as { runBounded?: typeof timersModule.runBounded }).runBounded;
    expect(typeof runBounded).toBe('function');
    let inFlight = 0;
    let maxInFlight = 0;
    const completed: number[] = [];
    const gates: Array<() => void> = [];

    const run = runBounded!(
      Array.from({ length: 8 }, (_, index) => async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>(resolve => {
          gates.push(resolve);
        });
        inFlight -= 1;
        completed.push(index);
      }),
      3,
    );

    await Promise.resolve();
    expect(inFlight).toBe(3);
    expect(maxInFlight).toBe(3);

    while (completed.length < 8) {
      const next = gates.shift();
      expect(next).toBeDefined();
      next!();
      await Promise.resolve();
      await Promise.resolve();
      expect(inFlight).toBeLessThanOrEqual(3);
    }

    await run;
    expect(maxInFlight).toBe(3);
    expect(completed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await expect(runBounded!([], 3)).resolves.toBeUndefined();
  });
});

describe('hot-path query plans and correctness', () => {
  it('runs agentFailureStates, alreadyAlerted, and commitEvidence with index scans, zero full scans, and FOR NO KEY UPDATE on agents', async () => {
    const s = await seedVolume();
    const allSql = statements();

    /* 1. agentFailureStates -> GET /api/org */
    expect((await agentFailureStates(s.ctx, s.companyId, [])).size).toBe(0);
    let mark = allSql.length;
    const states = await agentFailureStates(s.ctx, s.companyId, [...s.extraAgents, s.extraAgents[0]!]);
    const failureSql = allSql.slice(mark);
    expect(states.size).toBe(s.extraAgents.length);
    expect(states.get(s.extraAgents[3]!)?.retry).toMatchObject({ attempt: 2, kind: 'network' });
    /* A failed turn whose continuation waits goes on by itself, so the card shows its retry and no failure (#1953). */
    expect(states.get(s.extraAgents[3]!)?.failure).toBeNull();
    const failureIndexes = new Set<string>();
    for (const q of failureSql.filter(q => /\bfrom\s+"?jobs"?\b/i.test(q.sql))) {
      const { nodes } = await explainSql(s.client, q.sql, q.params);
      expect(seqScanTables(nodes), q.sql).not.toContain('jobs');
      for (const name of indexNames(nodes)) failureIndexes.add(name);
    }
    expect(failureIndexes.has('jobs_agent_conversation_ended')).toBe(true);
    expect(failureIndexes.has('jobs_agent_conversation_retry_waiting')).toBe(true);
    expect(failureIndexes.has('jobs_agent_conversation_obsolete')).toBe(true);

    /* 2. alreadyAlerted -> silent turn watchdog */
    mark = allSql.length;
    expect(await alreadyAlerted({ ...s.ctx }, s.alertedJobId)).toBe(true);
    expect(await alreadyAlerted({ ...s.ctx }, randomUUID())).toBe(false);
    const alertSql = allSql.slice(mark);
    const alertIndexes = new Set<string>();
    for (const q of alertSql.filter(q => /\bfrom\s+"?agent_events"?\b/i.test(q.sql))) {
      const { nodes } = await explainSql(s.client, q.sql, q.params);
      expect(seqScanTables(nodes), q.sql).not.toContain('agent_events');
      for (const name of indexNames(nodes)) alertIndexes.add(name);
    }
    expect(alertIndexes.has('agent_events_silent_job')).toBe(true);

    /* 3. commitEvidence (acceptOperatorEvidence) -> WriteGate.through */
    mark = allSql.length;
    const accepted = await acceptOperatorEvidence(s.ctx, s.identity, {
      type: 'program.delivery',
      agentKey: s.agent.id,
      jobId: s.job.id,
      instance: s.evidenceInstanceId,
      deliveryId: s.evidenceDeliveryId,
      deliveryOrdinal: 1000,
      kind: 'live',
      wordsDigest: wordsDigest(s.evidenceText),
      elapsedMs: 120,
      ordinal: 1,
      evidenceId: randomUUID(),
      phase: 'not_taken',
    }, s.now);
    const evidenceSql = allSql.slice(mark);
    await pump(s.ctx, s.agent.id);
    expect(accepted).toBe(true);

    /* recordEvidence and recordFallback lock agents with FOR NO KEY UPDATE rather than FOR UPDATE so FK inserts on agent_events/jobs do not block. */
    const agentLocks = evidenceSql.filter(q => /\b(?:from|join)\s+"?agents"?(?:\s|$)/i.test(q.sql) && /\bfor\s+/i.test(q.sql));
    expect(agentLocks.length).toBeGreaterThanOrEqual(2);
    for (const lockQuery of agentLocks) {
      expect(lockQuery.sql.toLowerCase()).toContain('for no key update');
    }

    const evidenceIndexes = new Set<string>();
    for (const q of evidenceSql.filter(q => /^\s*select\b/i.test(q.sql) && /\b(?:from|join)\s+"?agent_events"?\b/i.test(q.sql))) {
      const { nodes } = await explainSql(s.client, q.sql, q.params);
      expect(seqScanTables(nodes), q.sql).not.toContain('agent_events');
      for (const name of indexNames(nodes)) evidenceIndexes.add(name);
    }
    expect(evidenceIndexes.has('agent_events_operator_evidence')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_evidence_delivery')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_instance')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_delivery')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_fallback')).toBe(true);
  });

  it('replaces pre-migration sequential and unindexed scans with partial-index lookups on a 56-agent synthetic dataset', async () => {
    const pg = await freshPglite();
    onTestFinished(() => pg.close());
    await migrate(drizzle(pg), { migrationsFolder: await migrationsBefore('hot_query_indexes') });
    const q1 = async (text: string, params: unknown[] = []) => (await pg.query<Record<string, string>>(text, params)).rows[0]!;
    const co = (await q1('insert into companies(name, singleton) values($1, true) returning id', ['Acme'])).id!;
    const person = (await q1('insert into people(company_id, name, email, status, scope_kind) values($1, $2, $3, $4, $5) returning id', [co, 'Ann', 'ann@example.test', 'active', 'company'])).id!;
    const dep = (await q1('insert into departments(company_id, name, role_code) values($1, $2, $3) returning id', [co, 'Eng', 'ENG'])).id!;
    const sub = (await q1('insert into subscriptions(company_id, provider, kind, label, owner_person_id, status) values($1, $2, $3, $4, $5, $6) returning id', [co, 'codex', 'personal', 'Plan', person, 'ready'])).id!;
    const machine = (await q1('insert into machines(company_id, person_id, machine_key, hostname) values($1, $2, $3, $4) returning id', [co, person, 'mk-1', 'Host'])).id!;
    const node = (await q1('insert into nodes(company_id, machine_id, subscription_id, status) values($1, $2, $3, $4) returning id', [co, machine, sub, 'ready'])).id!;
    const agentIds: string[] = [];
    for (let i = 0; i < 56; i++) {
      agentIds.push((await q1('insert into agents(company_id, department_id, kind, name, model, subscription_id) values($1, $2, $3, $4, $5, $6) returning id', [co, dep, 'worker', `Synth${i}`, '', sub])).id!);
    }
    const agArr = `{${agentIds.join(',')}}`;
    await pg.query(
      `insert into jobs(company_id, subscription_id, node_id, agent_id, kind, prompt, timeout_ms, status, created_at, started_at, finished_at)
       select $1, $2, $3, ($4::uuid[])[1 + (g % 56)], 'conversation', 'prompt ' || g, 60000,
         case when g % 50 = 0 then 'obsolete' when g % 15 = 0 then 'failed' else 'done' end,
         now() - ((4000 - g) || ' seconds')::interval, now() - ((4000 - g) || ' seconds')::interval, now() - ((3990 - g) || ' seconds')::interval
       from generate_series(1, 2500) g`,
      [co, sub, node, agArr],
    );
    const sampleJob = (await q1('select id from jobs where agent_id = $1 limit 1', [agentIds[0]])).id!;
    await pg.query(
      `insert into agent_events(company_id, agent_id, job_id, kind, data)
       select $1, ($2::uuid[])[1 + (g % 56)], $3, case when g % 3 = 0 then 'message' else 'text' end, jsonb_build_object('text', 'ev ' || g)
       from generate_series(1, 6000) g`,
      [co, agArr, sampleJob],
    );
    const alertId = randomUUID();
    await pg.query('insert into agent_events(company_id, agent_id, job_id, kind, data) values($1, $2, $3, $4, $5::jsonb)', [co, agentIds[0], sampleJob, 'message', JSON.stringify({ text: 'a', silentJob: alertId })]);
    const inst = randomUUID();
    await pg.query('insert into program_instances(id, company_id, agent_id, node_id, launched, active) values($1, $2, $3, $4, true, true)', [inst, co, agentIds[0], node]);
    const targetDel = (await q1(
      'insert into program_deliveries(company_id, agent_id, job_id, node_id, program_instance_id, ordinal, reference, kind, digest, outcome) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id',
      [co, agentIds[0], sampleJob, node, inst, 1, 'r1', 'live', 'd1', 'not_taken'],
    )).id!;
    await pg.query('insert into agent_events(company_id, agent_id, job_id, kind, data) values($1, $2, $3, $4, $5::jsonb)', [co, agentIds[0], sampleJob, 'message', JSON.stringify({ text: 'm', operatorDelivery: { id: targetDel, ordinal: 1 } })]);
    await pg.query('insert into agent_events(company_id, agent_id, job_id, kind, data) values($1, $2, $3, $4, $5::jsonb)', [co, agentIds[0], sampleJob, 'message', JSON.stringify({ operatorEvidenceId: randomUUID(), operatorEvidence: { deliveryId: targetDel, instance: inst, phase: 'attempt', ordinal: 1 } })]);
    await pg.exec('ANALYZE');

    const explainText = async (label: string, text: string, params: unknown[]) => {
      const json = await explainSql(pg, text, params);
      const plain = (await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');
      return { label, ...json, plain };
    };

    const before = [
      await explainText('agentFailureStates.ended (BEFORE)', `select distinct on (agent_id) * from jobs where company_id = $1 and agent_id = any($2::uuid[]) and kind = 'conversation' and status in ('done', 'failed') and (error is null or error not in ('cancelled', 'removed', 'switched_off')) order by agent_id asc, coalesce(finished_at, created_at) desc, created_at desc`, [co, agArr]),
      await explainText('agentFailureStates.retryWaiting (BEFORE)', `select distinct on (agent_id) * from jobs where company_id = $1 and agent_id = any($2::uuid[]) and kind = 'conversation' and status = 'queued' and not_before is not null and continue_of is not null order by agent_id asc, created_at asc`, [co, agArr]),
      await explainText('agentFailureStates.obsolete (BEFORE)', `select distinct on (agent_id) * from jobs where company_id = $1 and agent_id = any($2::uuid[]) and kind = 'conversation' and status = 'obsolete' order by agent_id asc, coalesce(finished_at, created_at) desc, created_at desc`, [co, agArr]),
      await explainText('alreadyAlerted (BEFORE)', `select id from agent_events where kind = 'message' and data->>'silentJob' = $1 limit 1`, [alertId]),
      await explainText('commitEvidence.applyDeliveryFact (BEFORE)', `select distinct data->'operatorEvidence'->>'phase' from agent_events where agent_id = $1 and data->'operatorEvidence'->>'deliveryId' = $2 and data->'operatorEvidence'->>'phase' is not null`, [agentIds[0], targetDel]),
      await explainText('commitEvidence.fallbackMessage (BEFORE)', `select data from agent_events where company_id = $1 and agent_id = $2 and job_id = $3 and data->'operatorDelivery'->>'id' = $4`, [co, agentIds[0], sampleJob, targetDel]),
    ];

    /* Before our fix + migration, alreadyAlerted sequentially scans agent_events and none of the new partial indexes exist. */
    expect(seqScanTables(before[3]!.nodes)).toContain('agent_events');
    expect(indexNames(before[0]!.nodes)).not.toContain('jobs_agent_conversation_ended');
    expect(indexNames(before[4]!.nodes)).not.toContain('agent_events_operator_evidence_delivery');
    expect(indexNames(before[5]!.nodes)).not.toContain('agent_events_operator_delivery');

    await pg.exec(await hotIndexesMigrationSql());
    await pg.exec('ANALYZE');

    const after = [
      await explainText('agentFailureStates.ended (AFTER)', `select j.agent_id, j.status, j.failure, j.finished_at, j.created_at, j.tail from unnest($2::uuid[]) a(agent_id) cross join lateral (select agent_id, status, failure, finished_at, created_at, tail from jobs where company_id = $1 and agent_id = a.agent_id and kind = 'conversation' and status in ('done', 'failed') and (error is null or error not in ('cancelled', 'removed', 'switched_off')) order by coalesce(finished_at, created_at) desc, created_at desc limit 1) j`, [co, agArr]),
      await explainText('agentFailureStates.retryWaiting (AFTER)', `select j.agent_id, j.continue_of, j.not_before from unnest($2::uuid[]) a(agent_id) cross join lateral (select agent_id, continue_of, not_before from jobs where company_id = $1 and agent_id = a.agent_id and kind = 'conversation' and status = 'queued' and not_before is not null and continue_of is not null order by created_at asc limit 1) j`, [co, agArr]),
      await explainText('agentFailureStates.obsolete (AFTER)', `select j.agent_id, j.finished_at, j.created_at from unnest($2::uuid[]) a(agent_id) cross join lateral (select agent_id, finished_at, created_at from jobs where company_id = $1 and agent_id = a.agent_id and kind = 'conversation' and status = 'obsolete' order by coalesce(finished_at, created_at) desc, created_at desc limit 1) j`, [co, agArr]),
      await explainText('alreadyAlerted (AFTER)', `select id from agent_events where kind = 'message' and data ? 'silentJob' and data->>'silentJob' = $1 limit 1`, [alertId]),
      await explainText('commitEvidence.applyDeliveryFact (AFTER)', `select distinct data->'operatorEvidence'->>'phase' from agent_events where agent_id = $1 and data->'operatorEvidence'->>'deliveryId' = $2 and data->'operatorEvidence'->>'phase' is not null`, [agentIds[0], targetDel]),
      await explainText('commitEvidence.fallbackMessage (AFTER)', `select data from agent_events where company_id = $1 and agent_id = $2 and job_id = $3 and data->'operatorDelivery'->>'id' = $4`, [co, agentIds[0], sampleJob, targetDel]),
    ];

    for (const item of after) {
      expect(seqScanTables(item.nodes), item.label).not.toContain('jobs');
      expect(seqScanTables(item.nodes), item.label).not.toContain('agent_events');
    }
    expect(indexNames(after[0]!.nodes)).toContain('jobs_agent_conversation_ended');
    expect(indexNames(after[1]!.nodes)).toContain('jobs_agent_conversation_retry_waiting');
    expect(indexNames(after[2]!.nodes)).toContain('jobs_agent_conversation_obsolete');
    expect(indexNames(after[3]!.nodes)).toContain('agent_events_silent_job');
    expect(indexNames(after[4]!.nodes)).toContain('agent_events_operator_evidence_delivery');
    expect(indexNames(after[5]!.nodes)).toContain('agent_events_operator_delivery');

    if (process.env.HH_EXPLAIN_OUT) {
      const report = [...before, ...after].map(x => `=== ${x.label} (${x.executionMs.toFixed(3)} ms) ===\n${x.plain}`).join('\n\n');
      await writeFile(process.env.HH_EXPLAIN_OUT, `${report}\n`, 'utf8');
    }
  });
});
