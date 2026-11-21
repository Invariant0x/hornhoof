import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { agentEvents, agents, departments, jobs, programDeliveries, programInstances, tasks, turns } from '../src/db/schema.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { wordsDigest } from '../src/modules/program-operator/deliveries.js';
import { reconcileOperatorFallbacks } from '../src/modules/program-operator/requeue.js';
import { agentFailureStates } from '../src/modules/tasks/failure-records.js';
import { alreadyAlerted } from '../src/modules/tasks/silent.js';
import { quietDepartment } from '../src/modules/tasks/wait-observations.js';
import { freshPglite, ownDatabases, statements } from './helpers-db.js';
import { migrationsThrough } from './migrations-before.js';
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

  const [openTurn] = await c.db.insert(turns).values({
    companyId: c.companyId,
    departmentId: dev!.id,
    number: 1,
    goal: 'Synthetic load test',
    openedAt: new Date(+now - 60 * 60_000),
  }).returning();
  const [openTask] = await c.db.insert(tasks).values({
    companyId: c.companyId,
    departmentId: dev!.id,
    turnId: openTurn!.id,
    number: 101,
    title: 'Synthetic task',
    status: 'working',
    updatedAt: new Date(+now - 45 * 60_000),
  }).returning();

  /* Finish the operatorCompany starter job cleanly so quietDepartment sees controlled running state. */
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
      taskId: i % 20 === 0 ? openTask!.id : null,
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

  /* Add one queued continuation retry and one fresh failure for deterministic assertion in agentFailureStates. */
  const latestFailed = insertedJobs.find(j => j.agentId === extraAgents[3])!;
  await c.db.update(jobs).set({
    status: 'failed',
    error: 'agent_failed',
    failure: { kind: 'network', retryable: true, text: 'Socket closed.' },
    tail: 'EOF',
    createdAt: new Date(+now - 25 * 60_000),
    finishedAt: new Date(+now - 24 * 60_000),
  }).where(eq(jobs.id, latestFailed.id));
  await c.db.insert(jobs).values({
    companyId: c.companyId,
    subscriptionId: c.sub.id,
    agentId: extraAgents[3]!,
    kind: 'conversation',
    prompt: 'Retry synthetic prompt',
    timeoutMs: 60_000,
    status: 'queued',
    continueOf: latestFailed.id,
    notBefore: new Date(+now + 60_000),
    createdAt: new Date(+now - 23 * 60_000),
  });

  const eventRows = [];
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

  /* 500 historical deliveries (24 already-requeued live not_taken, 474 taken assignments, 1 missing fallback, 1 for commitEvidence). */
  const deliveryRows = [];
  const fallbackEvents = [];
  for (let i = 0; i < 498; i++) {
    const job = insertedJobs[i % insertedJobs.length]!;
    const kind = i < 24 ? 'live' as const : 'assignment' as const;
    const outcome = i < 24 ? 'not_taken' as const : 'taken' as const;
    const deliveryId = randomUUID();
    deliveryRows.push({
      id: deliveryId,
      companyId: c.companyId,
      agentId: job.agentId!,
      jobId: job.id,
      nodeId: c.identity.nodeId,
      ordinal: i + 100,
      reference: `ref-${i}`,
      kind,
      digest: wordsDigest(`Words ${i}`),
      outcome,
      createdAt: new Date(+now - (600 - i) * 1000),
    });
    if (i < 24) {
      fallbackEvents.push({
        companyId: c.companyId,
        agentId: job.agentId!,
        jobId: job.id,
        kind: 'typed' as const,
        data: { text: `Words ${i}`, operatorFallback: deliveryId },
      });
    }
  }
  const missingDeliveryId = randomUUID();
  const missingText = 'Synthetic unheard live words.';
  deliveryRows.push({
    id: missingDeliveryId,
    companyId: c.companyId,
    agentId: c.agent.id,
    jobId: c.job.id,
    nodeId: c.identity.nodeId,
    ordinal: 999,
    reference: 'ref-missing',
    kind: 'live' as const,
    digest: wordsDigest(missingText),
    outcome: 'not_taken' as const,
    createdAt: new Date(+now - 5000),
  });
  fallbackEvents.push({
    companyId: c.companyId,
    agentId: c.agent.id,
    jobId: c.job.id,
    kind: 'message' as const,
    data: { text: missingText, operatorDelivery: { id: missingDeliveryId, ordinal: 999 } },
  });

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
  fallbackEvents.push({
    companyId: c.companyId,
    agentId: c.agent.id,
    jobId: c.job.id,
    kind: 'message' as const,
    data: { text: evidenceText, operatorDelivery: { id: evidenceDeliveryId, ordinal: 1000 } },
  });
  const recoveryCaseId = randomUUID();
  fallbackEvents.push({
    companyId: c.companyId,
    agentId: c.agent.id,
    jobId: c.job.id,
    kind: 'message' as const,
    data: { operatorEvidenceId: randomUUID(), operatorEvidence: { type: 'program.recovery_ready', case: recoveryCaseId, instance: evidenceInstanceId, ordinal: 0 } },
  });

  await c.db.insert(programDeliveries).values(deliveryRows);
  await c.db.insert(agentEvents).values(fallbackEvents);

  await client.exec('ANALYZE jobs, agent_events, program_deliveries, program_instances, program_operator_cases, agents, tasks');

  return {
    ...c,
    client,
    now,
    dev: dev!,
    openTurn: openTurn!,
    openTask: openTask!,
    extraAgents,
    alertedJobId,
    missingDeliveryId,
    missingText,
    evidenceDeliveryId,
    evidenceInstanceId,
    evidenceText,
    recoveryCaseId,
  };
}

describe('hot-path query plans and correctness', () => {
  it('runs all five hot paths with index scans and zero full scans on jobs, agent_events, or program_deliveries', async () => {
    const s = await seedVolume();
    const allSql = statements();

    /* 1. agentFailureStates -> GET /api/org */
    let mark = allSql.length;
    const states = await agentFailureStates(s.ctx, s.companyId, s.extraAgents);
    const failureSql = allSql.slice(mark);
    expect(states.size).toBe(s.extraAgents.length);
    expect(states.get(s.extraAgents[3]!)?.retry).toMatchObject({ attempt: 1, kind: 'network' });
    expect(states.get(s.extraAgents[3]!)?.failure).toMatchObject({ kind: 'network', text: 'Socket closed.' });
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

    /* 3. reconcileOperatorFallbacks -> minuteRound */
    vi.spyOn(s.ctx.hub, 'isReady').mockReturnValue(false);
    mark = allSql.length;
    await reconcileOperatorFallbacks(s.ctx, s.now);
    const reconcileSql = allSql.slice(mark);
    const discovery = reconcileSql.find(q => /program_deliveries/i.test(q.sql) && /operatorFallback/i.test(q.sql));
    expect(discovery).toBeDefined();
    const discoveryPlan = await explainSql(s.client, discovery!.sql, discovery!.params);
    expect(seqScanTables(discoveryPlan.nodes)).not.toContain('agent_events');
    expect(seqScanTables(discoveryPlan.nodes)).not.toContain('program_deliveries');
    const discoveryIndexes = new Set(indexNames(discoveryPlan.nodes));
    expect(discoveryIndexes.has('program_deliveries_live_not_taken')).toBe(true);
    expect(discoveryIndexes.has('agent_events_operator_fallback')).toBe(true);
    expect(discoveryIndexes.has('agent_events_operator_delivery')).toBe(true);
    for (const q of reconcileSql.filter(q => /^\s*select\b/i.test(q.sql) && /\b(?:from|join)\s+"?agent_events"?\b/i.test(q.sql))) {
      const { nodes } = await explainSql(s.client, q.sql, q.params);
      expect(seqScanTables(nodes), q.sql).not.toContain('agent_events');
    }
    const requeued = await s.db.select().from(jobs).where(eq(jobs.prompt, s.missingText));
    expect(requeued).toHaveLength(1);

    /* 4. quietDepartment -> minuteRound (quiet branch and running branch) */
    mark = allSql.length;
    const quiet = await quietDepartment(s.ctx, s.openTurn.id, s.dev.id, s.now);
    const quietSql = allSql.slice(mark);
    expect(quiet).not.toBeNull();
    expect(quiet!.silent.map(t => t.id)).toEqual([s.openTask.id]);
    const quietIndexes = new Set<string>();
    for (const q of quietSql.filter(q => /\bfrom\s+"?jobs"?\b/i.test(q.sql))) {
      const { nodes } = await explainSql(s.client, q.sql, q.params);
      expect(seqScanTables(nodes), q.sql).not.toContain('jobs');
      for (const name of indexNames(nodes)) quietIndexes.add(name);
    }
    expect(quietIndexes.has('jobs_company_conversation_running')).toBe(true);
    expect(quietIndexes.has('jobs_agent_conversation_finished')).toBe(true);
    expect(quietIndexes.has('jobs_task_conversation_finished')).toBe(true);

    /* Running branch returns null immediately via jobs_company_conversation_running without scanning history. */
    const [runningJob] = await s.db.insert(jobs).values({
      companyId: s.companyId,
      subscriptionId: s.sub.id,
      agentId: s.extraAgents[4]!,
      kind: 'conversation',
      prompt: 'Active turn',
      timeoutMs: 60_000,
      status: 'running',
      startedAt: new Date(+s.now - 1000),
    }).returning({ id: jobs.id });
    mark = allSql.length;
    expect(await quietDepartment(s.ctx, s.openTurn.id, s.dev.id, s.now)).toBeNull();
    const busySql = allSql.slice(mark);
    const busyJobsQueries = busySql.filter(q => /\bfrom\s+"?jobs"?\b/i.test(q.sql));
    expect(busyJobsQueries).toHaveLength(1);
    const busyPlan = await explainSql(s.client, busyJobsQueries[0]!.sql, busyJobsQueries[0]!.params);
    expect(seqScanTables(busyPlan.nodes)).not.toContain('jobs');
    expect(indexNames(busyPlan.nodes)).toContain('jobs_company_conversation_running');
    await s.db.delete(jobs).where(eq(jobs.id, runningJob!.id));

    /* 5. commitEvidence (acceptOperatorEvidence) -> WriteGate.through */
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
    expect(accepted).toBe(true);
    const evidenceIndexes = new Set<string>();
    for (const q of evidenceSql.filter(q => /^\s*select\b/i.test(q.sql) && /\b(?:from|join)\s+"?agent_events"?\b/i.test(q.sql))) {
      const { nodes } = await explainSql(s.client, q.sql, q.params);
      expect(seqScanTables(nodes), q.sql).not.toContain('agent_events');
      for (const name of indexNames(nodes)) evidenceIndexes.add(name);
    }
    expect(evidenceIndexes.has('agent_events_operator_evidence')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_evidence_delivery')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_evidence_instance') || evidenceIndexes.has('agent_events_operator_instance')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_delivery')).toBe(true);
    expect(evidenceIndexes.has('agent_events_operator_fallback')).toBe(true);

    /* restoreCase lookup in checkOperatorHealth uses agent_events_operator_recovery_case without Seq Scan. */
    const recoveryPlan = await explainSql(
      s.client,
      `select "data" from "agent_events" where "agent_id" = $1 and "data"->'operatorEvidence'->>'type' = 'program.recovery_ready' and "data"->'operatorEvidence'->>'case' = $2`,
      [s.agent.id, s.recoveryCaseId],
    );
    expect(seqScanTables(recoveryPlan.nodes)).not.toContain('agent_events');
    expect(indexNames(recoveryPlan.nodes)).toContain('agent_events_operator_recovery_case');
  });

  it('replaces pre-0158 sequential scans with indexed plans on the same 56-agent synthetic dataset', async () => {
    const pg = await freshPglite();
    onTestFinished(() => pg.close());
    await migrate(drizzle(pg), { migrationsFolder: await migrationsThrough('request_unchecked') });
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
    const taskId = (await q1('insert into tasks(company_id, department_id, number, title, status) values($1, $2, 1, $3, $4) returning id', [co, dep, 'T1', 'working'])).id!;
    const agArr = `{${agentIds.join(',')}}`;
    await pg.query(
      `insert into jobs(company_id, subscription_id, node_id, agent_id, task_id, kind, prompt, timeout_ms, status, created_at, started_at, finished_at)
       select $1, $2, $3, ($4::uuid[])[1 + (g % 56)], case when g % 20 = 0 then $5::uuid else null end, 'conversation', 'prompt ' || g, 60000,
         case when g % 50 = 0 then 'obsolete' when g % 15 = 0 then 'failed' else 'done' end,
         now() - ((4000 - g) || ' seconds')::interval, now() - ((4000 - g) || ' seconds')::interval, now() - ((3990 - g) || ' seconds')::interval
       from generate_series(1, 2500) g`,
      [co, sub, node, agArr, taskId],
    );
    const sampleJob = (await q1('select id from jobs limit 1')).id!;
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
    const delIds: string[] = [];
    for (let i = 0; i < 500; i++) {
      const did = (await q1(
        'insert into program_deliveries(company_id, agent_id, job_id, node_id, program_instance_id, ordinal, reference, kind, digest, outcome) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id',
        [co, agentIds[i % 56], sampleJob, node, inst, i + 1, `r${i}`, i < 25 ? 'live' : 'assignment', 'd', i < 25 ? 'not_taken' : 'taken'],
      )).id!;
      delIds.push(did);
      if (i < 24) {
        await pg.query('insert into agent_events(company_id, agent_id, job_id, kind, data) values($1, $2, $3, $4, $5::jsonb)', [co, agentIds[i % 56], sampleJob, 'typed', JSON.stringify({ operatorFallback: did })]);
      }
    }
    const targetDel = delIds[24]!;
    await pg.query('insert into agent_events(company_id, agent_id, job_id, kind, data) values($1, $2, $3, $4, $5::jsonb)', [co, agentIds[24 % 56], sampleJob, 'message', JSON.stringify({ text: 'm', operatorDelivery: { id: targetDel, ordinal: 25 } })]);
    await pg.query('insert into agent_events(company_id, agent_id, job_id, kind, data) values($1, $2, $3, $4, $5::jsonb)', [co, agentIds[0], sampleJob, 'message', JSON.stringify({ operatorEvidenceId: randomUUID(), operatorEvidence: { deliveryId: targetDel, instance: inst, phase: 'attempt', ordinal: 1 } })]);
    await pg.exec('ANALYZE');

    const explainText = async (label: string, text: string, params: unknown[]) => {
      const json = await explainSql(pg, text, params);
      const plain = (await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');
      return { label, ...json, plain };
    };

    const before = [
      await explainText('agentFailureStates (BEFORE)', `select distinct on (agent_id) * from jobs where company_id = $1 and agent_id = any($2::uuid[]) and kind = 'conversation' and status in ('done', 'failed') and (error is null or error not in ('cancelled', 'removed', 'switched_off')) order by agent_id asc, coalesce(finished_at, created_at) desc, created_at desc`, [co, agArr]),
      await explainText('alreadyAlerted (BEFORE)', `select id from agent_events where kind = 'message' and data->>'silentJob' = $1 limit 1`, [alertId]),
      await explainText('reconcileOperatorFallbacks (BEFORE)', `select * from program_deliveries where kind = 'live' and outcome = 'not_taken' and not exists (select 1 from agent_events e where e.agent_id = program_deliveries.agent_id and e.kind = 'typed' and e.data->>'operatorFallback' = program_deliveries.id::text) and exists (select 1 from agent_events e where e.agent_id = program_deliveries.agent_id and e.job_id = program_deliveries.job_id and e.data->'operatorDelivery'->>'id' = program_deliveries.id::text) limit 100`, []),
      await explainText('quietDepartment (BEFORE)', `select * from jobs where company_id = $1 and kind = 'conversation' and (agent_id in (select id from agents where company_id = $1 and department_id = $2) or task_id = $3)`, [co, dep, taskId]),
      await explainText('commitEvidence.applyDeliveryFact (BEFORE)', `select distinct data->'operatorEvidence'->>'phase' from agent_events where agent_id = $1 and data->'operatorEvidence'->>'deliveryId' = $2 and data->'operatorEvidence'->>'phase' is not null`, [agentIds[0], targetDel]),
      await explainText('commitEvidence.instanceFacts (BEFORE)', `select data from agent_events where agent_id = $1 and data->'operatorEvidence'->>'instance' = $2 order by (data->'operatorEvidence'->>'ordinal')::bigint`, [agentIds[0], inst]),
    ];

    /* Before 0158, alreadyAlerted and quietDepartment perform sequential scans on agent_events and jobs. */
    expect(seqScanTables(before[1]!.nodes)).toContain('agent_events');
    expect(seqScanTables(before[3]!.nodes)).toContain('jobs');

    await pg.exec(await readFile(`${MIGRATIONS}/0158_hot_query_indexes.sql`, 'utf8'));
    await pg.exec('ANALYZE');

    const after = [
      await explainText('agentFailureStates (AFTER)', `select j.agent_id, j.status, j.failure, j.finished_at, j.created_at, j.tail from unnest($2::uuid[]) a(agent_id) cross join lateral (select agent_id, status, failure, finished_at, created_at, tail from jobs where company_id = $1 and agent_id = a.agent_id and kind = 'conversation' and status in ('done', 'failed') and (error is null or error not in ('cancelled', 'removed', 'switched_off')) order by coalesce(finished_at, created_at) desc, created_at desc limit 1) j`, [co, agArr]),
      await explainText('alreadyAlerted (AFTER)', `select id from agent_events where kind = 'message' and data ? 'silentJob' and data->>'silentJob' = $1 limit 1`, [alertId]),
      await explainText('reconcileOperatorFallbacks (AFTER)', `select * from program_deliveries where kind = 'live' and outcome = 'not_taken' and not exists (select 1 from agent_events e where e.agent_id = program_deliveries.agent_id and e.kind = 'typed' and e.data->>'operatorFallback' = program_deliveries.id::text) and exists (select 1 from agent_events e where e.agent_id = program_deliveries.agent_id and e.job_id = program_deliveries.job_id and e.data->'operatorDelivery'->>'id' = program_deliveries.id::text) limit 100`, []),
      await explainText('quietDepartment.running (AFTER)', `select id from jobs where company_id = $1 and kind = 'conversation' and status = 'running' and agent_id = any($2::uuid[]) limit 1`, [co, agArr]),
      await explainText('quietDepartment.maxFinished (AFTER)', `select max(j.finished_at) from unnest($2::uuid[]) a(agent_id) cross join lateral (select finished_at from jobs where company_id = $1 and agent_id = a.agent_id and kind = 'conversation' and started_at is not null and finished_at is not null order by finished_at desc limit 1) j`, [co, agArr]),
      await explainText('quietDepartment.maxFinishedByTask (AFTER)', `select max(j.finished_at) from unnest($2::uuid[]) k(id) cross join lateral (select finished_at from jobs where company_id = $1 and task_id = k.id and kind = 'conversation' and started_at is not null and finished_at is not null order by finished_at desc limit 1) j`, [co, `{${taskId}}`]),
      await explainText('commitEvidence.applyDeliveryFact (AFTER)', `select distinct data->'operatorEvidence'->>'phase' from agent_events where agent_id = $1 and data->'operatorEvidence'->>'deliveryId' = $2 and data->'operatorEvidence'->>'phase' is not null`, [agentIds[0], targetDel]),
      await explainText('commitEvidence.instanceFacts (AFTER)', `select data from agent_events where agent_id = $1 and data->'operatorEvidence'->>'instance' = $2 order by (data->'operatorEvidence'->>'ordinal')::bigint`, [agentIds[0], inst]),
    ];

    for (const item of after) {
      expect(seqScanTables(item.nodes), item.label).not.toContain('jobs');
      expect(seqScanTables(item.nodes), item.label).not.toContain('agent_events');
      expect(seqScanTables(item.nodes), item.label).not.toContain('program_deliveries');
      expect(item.executionMs, item.label).toBeLessThan(1000);
    }

    if (process.env.HH_EXPLAIN_OUT) {
      const report = [...before, ...after].map(x => `=== ${x.label} (${x.executionMs.toFixed(3)} ms) ===\n${x.plain}`).join('\n\n');
      await writeFile(process.env.HH_EXPLAIN_OUT, `${report}\n`, 'utf8');
    }
  });
});
