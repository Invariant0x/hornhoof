import { createHash } from 'node:crypto';
import { eq, getTableColumns, getTableName, isTable } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import * as schema from '../src/db/schema.js';
import {
  agentChanges,
  agentEvents,
  agents,
  assistants,
  companies,
  departments,
  goalEvents,
  goals,
  invites,
  jobs,
  machines,
  notebookNotes,
  oneShotCalls,
  people,
  sessions,
  subscriptions,
  taskEvents,
  taskRoutes,
  tasks,
  teams,
  testParts,
  testRuns,
  turnReleases,
  turnTokens,
  turns,
} from '../src/db/schema.js';
import { placeOf, renderInstructions } from '../src/modules/agents/instructions.js';
import {
  answer,
  ask,
  cancel,
  closeTask,
  createTask,
  handOver,
  report,
  submit,
  verdict,
} from '../src/modules/tasks/engine.js';
import { createGoal, editGoal, setGoalStatus } from '../src/modules/tracker/goals.js';
import { as, echelonsTurn, invitePerson, setUpCompany, testApp, TUNNEL, viaLink } from './helpers.js';
import { recorded } from './recorded-fixture.js';

const sha256Hex = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const sha40 = (n: number): string => n.toString(16).padStart(40, '0');

type AchievementRuleView = {
  kind: string;
  threshold?: number;
  level?: number;
  agents?: number;
  weeks?: number;
  daysPerWeek?: number;
  ratio?: number;
};

type EarnedItem = {
  id: string;
  scope: 'shared' | 'personal';
  name: Record<string, string>;
  captions: Record<string, string[]>;
  rule: AchievementRuleView;
  tier: 'bronze' | 'silver' | 'gold';
  display: 'large' | 'medium' | 'shelf';
  artKey: string | null;
  earnedAt: string;
  record: {
    kind: 'task' | 'turn' | 'check' | 'goal';
    id: string;
    number: number;
    eventId?: string;
    commit?: string;
    version?: string;
  };
};

type RewardsPayload = {
  catalogue: {
    id: string;
    researchNumber: number;
    scope: 'shared' | 'personal';
    name: Record<string, string>;
    captions: Record<string, string[]>;
    rule: AchievementRuleView;
    tier: 'bronze' | 'silver' | 'gold';
    display: 'large' | 'medium' | 'shelf';
    artKey: string | null;
  }[];
  earned: EarnedItem[];
  counts: {
    acceptedTasks: number;
    releasedTurns: number;
    passedChecks: number;
    reachedGoals: number;
  };
  showcase: {
    theme: string;
    catalogue: {
      id: string;
      scope: 'shared' | 'personal';
      name: Record<string, string>;
      captions: Record<string, string[]>;
      tier: 'bronze' | 'silver' | 'gold';
      display: 'large' | 'medium' | 'shelf';
      artKey: string | null;
    }[];
    earned: {
      achievementId: string;
      scope: 'shared' | 'personal';
      name: Record<string, string>;
      captions: Record<string, string[]>;
      tier: 'bronze' | 'silver' | 'gold';
      display: 'large' | 'medium' | 'shelf';
      artKey: string | null;
      share: {
        path: string;
        text: Record<string, string>;
      };
    }[];
  };
};

function collectObjectKeys(val: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(val)) {
    for (const item of val) collectObjectKeys(item, out);
    return out;
  }
  if (typeof val === 'object' && val !== null) {
    for (const [k, v] of Object.entries(val)) {
      out.add(k);
      collectObjectKeys(v, out);
    }
  }
  return out;
}

async function insertVerifiedTurnkeyTasks(
  db: Parameters<typeof echelonsTurn>[0],
  input: {
    companyId: string;
    departmentId: string;
    agentId: string;
    startNumber: number;
    count: number;
    baseAtMs: number;
    stepMs?: number;
    goalId?: string | null;
  },
): Promise<{ ids: string[]; lastId: string; firstId: string }> {
  const step = input.stepMs ?? 1_000;
  const ids: string[] = [];
  const chunkSize = 400;
  for (let offset = 0; offset < input.count; offset += chunkSize) {
    const size = Math.min(chunkSize, input.count - offset);
    const taskBatch: (typeof tasks.$inferInsert)[] = [];
    for (let i = 0; i < size; i++) {
      const idx = offset + i;
      const at = new Date(input.baseAtMs + idx * step);
      taskBatch.push({
        companyId: input.companyId,
        number: input.startNumber + idx,
        departmentId: input.departmentId,
        title: `Synthetic task ${input.startNumber + idx}`,
        brief: 'Synthetic verified task',
        body: 'Synthetic body',
        status: 'done',
        executorAgentId: input.agentId,
        goalId: input.goalId ?? null,
        createdAt: at,
        updatedAt: at,
        closedAt: at,
      });
    }
    const inserted = await db.insert(tasks).values(taskBatch).returning({ id: tasks.id, closedAt: tasks.closedAt });
    for (const row of inserted) ids.push(row.id);

    await db.insert(taskRoutes).values(
      inserted.map(row => ({
        taskId: row.id,
        companyId: input.companyId,
        revision: 2,
        state: {
          kind: 'development_echelons' as const,
          phase: 'done' as const,
          stage: null,
          stages: [],
          version: 1 as const,
          security: { reason: null, addedBy: null, required: false },
          abilities: {},
          assignment: null,
          resultKind: 'turnkey' as const,
          candidateId: null,
        },
        paths: [],
      })),
    );

    await db.insert(taskEvents).values(
      inserted.map((row, idx) => ({
        companyId: input.companyId,
        taskId: row.id,
        kind: 'report' as const,
        agentId: input.agentId,
        text: 'Verified result recorded.',
        data: {
          done: true,
          integration: {
            branch: 'turn-1',
            commit: sha40(input.startNumber + offset + idx),
            start: sha40(0),
          },
        },
        createdAt: row.closedAt!,
      })),
    );
  }
  return { ids, firstId: ids[0]!, lastId: ids[ids.length - 1]! };
}

describe('Game layer stage 1: verified achievements catalogue, human-only API, scoping and showcase privacy', () => {
  it('authenticates human company members, refuses agents, orchestrator, heads and assistants, and reads idempotently with zero writes', async () => {
    const { app, db } = await testApp({ TUNNEL_HOST: TUNNEL });
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.companyId, company!.id));
    const [plan] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));

    /* Strangers are rejected locally and over the public link on both routes. */
    expect((await app.inject({ url: '/api/world/rewards' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/world/rewards/showcase' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/world/rewards', ...viaLink() })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/world/rewards/showcase', ...viaLink() })).statusCode).toBe(401);

    /* Invalid bearer tokens are rejected. */
    expect(
      (await app.inject({ url: '/api/world/rewards', headers: { authorization: 'Bearer invalid-token' } })).statusCode,
    ).toBe(401);

    const [dev] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Engineering', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [tkTeam] = await db
      .insert(teams)
      .values({ companyId: company!.id, departmentId: dev!.id, name: 'Turnkey', turnkey: true })
      .returning();
    const [head, worker] = await db
      .insert(agents)
      .values([
        {
          companyId: company!.id,
          kind: 'head',
          name: 'HeadOne',
          model: 'claude-opus-5-5',
          departmentId: dev!.id,
          subscriptionId: plan!.id,
          roleKey: 'DEV-HEAD',
        },
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'BuilderOne',
          model: 'claude-sonnet-5-5',
          departmentId: dev!.id,
          teamId: tkTeam!.id,
          subscriptionId: plan!.id,
          roleKey: 'DEV-ENG',
        },
      ])
      .returning();

    /* Listed department person can read company achievements. */
    const member = await invitePerson(app, ceo, {
      name: 'Clara',
      email: 'clara@moonfern.example',
      access: { departments: [dev!.id] },
    });

    /* Running worker and orchestrator job tokens and active personal assistant keys are ALL refused (#99 / §4.2). */
    const liveAgentToken = 'live-worker-job-token-1994';
    const liveOrchestratorToken = 'live-orchestrator-job-token-1994';
    await db.insert(jobs).values([
      {
        companyId: company!.id,
        subscriptionId: plan!.id,
        agentId: worker!.id,
        kind: 'conversation',
        prompt: 'check',
        timeoutMs: 10_000,
        status: 'running',
        toolTokenHash: sha256Hex(liveAgentToken),
        startedAt: new Date(),
      },
      {
        companyId: company!.id,
        subscriptionId: plan!.id,
        agentId: orchestrator!.id,
        kind: 'conversation',
        prompt: 'orch',
        timeoutMs: 10_000,
        status: 'running',
        toolTokenHash: sha256Hex(liveOrchestratorToken),
        startedAt: new Date(),
      },
    ]);

    const assistantRawKey = `hha_${'A'.repeat(43)}`;
    const [assistantPerson] = await db
      .insert(people)
      .values({
        companyId: company!.id,
        name: 'Leo Assistant',
        status: 'active',
        scopeKind: 'company',
        isAgent: true,
        assistantOf: owner!.id,
      })
      .returning();
    await db.insert(assistants).values({
      personId: assistantPerson!.id,
      companyId: company!.id,
      program: 'openclaw',
      keyHash: sha256Hex(assistantRawKey),
      keyCreatedAt: new Date(),
      wakeSecretEnc: 'enc-secret',
    });

    /* Create one real turnkey task and accept it with recorded evidence. */
    const { task } = await createTask(app.ctx, { personId: owner!.id }, {
      title: 'Build stone gate',
      brief: 'Gate built',
      body: 'Details',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });
    await report(app.ctx, worker!.id, task.id, {
      done: true,
      summary: 'Verified locally with passing tests.',
      ...(await recorded(app.ctx, task.id, worker!.id)),
    });

    /* Every non-human caller (worker bearer, assistant bearer, orchestrator bearer, internal orchestrator/head) is refused. */
    for (const url of ['/api/world/rewards', '/api/world/rewards/showcase']) {
      expect(
        (await app.inject({ url, headers: { authorization: `Bearer ${liveAgentToken}` } })).statusCode,
        `worker bearer on ${url}`,
      ).toBe(401);
      expect(
        (await app.inject({ url, headers: { authorization: `Bearer ${assistantRawKey}` } })).statusCode,
        `assistant key on ${url}`,
      ).toBe(401);
      expect(
        (await app.inject({ url, headers: { authorization: `Bearer ${liveOrchestratorToken}` } })).statusCode,
        `orchestrator bearer on ${url}`,
      ).toBe(403);
      expect(
        (await app.inject({ url, headers: orchestratorHeaders(owner!.id, orchestrator!.id) })).statusCode,
        `internal orchestrator on ${url}`,
      ).toBe(403);
      expect(
        (await app.inject({ url, headers: orchestratorHeaders(owner!.id, head!.id) })).statusCode,
        `internal head on ${url}`,
      ).toBe(403);
    }

    /* Agent instructions contain zero references to game achievements (§3.1 #5). */
    const rendered = renderInstructions(app.ctx.templates, worker!, await placeOf(db, worker!));
    expect(rendered.text).not.toMatch(/\b(?:golden_capstone|first_stone|achievement-captions)\b/i);

    const insertSpy = vi.spyOn(db, 'insert');
    const updateSpy = vi.spyOn(db, 'update');
    const deleteSpy = vi.spyOn(db, 'delete');

    const ceoRes1 = await app.inject({ url: '/api/world/rewards', ...as(ceo) });
    const ceoRes2 = await app.inject({ url: '/api/world/rewards', ...as(ceo) });
    const memberRes = await app.inject({ url: '/api/world/rewards', ...as(member) });

    expect(ceoRes1.statusCode).toBe(200);
    expect(ceoRes2.statusCode).toBe(200);
    expect(memberRes.statusCode).toBe(200);

    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    insertSpy.mockRestore();
    updateSpy.mockRestore();
    deleteSpy.mockRestore();

    /* Idempotency: recomputing returns the exact same result across human callers and calls. */
    const body1 = ceoRes1.json() as RewardsPayload;
    const body2 = ceoRes2.json() as RewardsPayload;
    expect(body1).toEqual(body2);
    expect(memberRes.json()).toEqual(body1);

    /* Catalogue constraints: <= 30 items, unique ids, neutral tiers, captions from JSON, structured rules, artKey null, no yo or em-dash. */
    expect(body1.catalogue.length).toBeGreaterThanOrEqual(15);
    expect(body1.catalogue.length).toBeLessThanOrEqual(30);
    const ids = new Set(body1.catalogue.map(c => c.id));
    expect(ids.size).toBe(body1.catalogue.length);
    for (const item of body1.catalogue) {
      expect(['shared', 'personal']).toContain(item.scope);
      expect(['bronze', 'silver', 'gold']).toContain(item.tier);
      expect((item.name.en ?? '').trim().length).toBeGreaterThan(0);
      expect((item.name.ru ?? '').trim().length).toBeGreaterThan(0);
      expect((item.captions.en ?? []).length).toBeGreaterThan(0);
      expect((item.captions.ru ?? []).length).toBeGreaterThan(0);
      expect(typeof item.rule.kind).toBe('string');
      expect(item.artKey).toBeNull();
      expect(JSON.stringify(item)).not.toMatch(/[\u0451\u0401\u2014]/);
    }
    expect(JSON.stringify(body1.showcase)).not.toMatch(/[\u0451\u0401\u2014]/);

    /* Personal vs shared scope: answering a human scroll earns personal answer_from_above for that human alone,
       never exposing it to another human colleague until that colleague answers their own scroll. */
    const [memberPerson] = await db.select().from(people).where(eq(people.email, 'clara@moonfern.example'));
    const { task: scrollTask1 } = await createTask(app.ctx, { personId: owner!.id }, {
      title: 'Gate archway',
      brief: 'Archway',
      body: 'Details',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });
    const q1 = await ask(app.ctx, worker!.id, scrollTask1.id, { kind: 'question', text: 'Limestone or granite?' });
    await answer(app.ctx, { personId: owner!.id }, q1.request.id, { answer: 'Limestone.' });
    await report(app.ctx, worker!.id, scrollTask1.id, {
      done: true,
      summary: 'Archway verified.',
      ...(await recorded(app.ctx, scrollTask1.id, worker!.id)),
    });

    const ceoPersonal = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    const memberBeforeOwn = (await app.inject({ url: '/api/world/rewards', ...as(member) })).json() as RewardsPayload;

    expect(ceoPersonal.earned.map(e => e.id)).toContain('answer_from_above');
    expect(memberBeforeOwn.earned.map(e => e.id)).not.toContain('answer_from_above');

    const { task: scrollTask2 } = await createTask(app.ctx, { personId: memberPerson!.id }, {
      title: 'Courtyard steps',
      brief: 'Steps',
      body: 'Details',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });
    const q2 = await ask(app.ctx, worker!.id, scrollTask2.id, {
      kind: 'question',
      text: 'Three steps or five?',
      topic: 'task',
    });
    await answer(app.ctx, { personId: memberPerson!.id }, q2.request.id, { answer: 'Three steps.' });
    await report(app.ctx, worker!.id, scrollTask2.id, {
      done: true,
      summary: 'Steps verified.',
      ...(await recorded(app.ctx, scrollTask2.id, worker!.id)),
    });

    const memberAfterOwn = (await app.inject({ url: '/api/world/rewards', ...as(member) })).json() as RewardsPayload;
    expect(memberAfterOwn.earned.map(e => e.id)).toContain('answer_from_above');
  });

  it('earns each computable achievement condition and each verified count at most once', async () => {
    const { app, db } = await testApp();
    app.ctx.readCommit = async (_repo, want) => ({
      branch: 'branch' in want ? want.branch : `task-${want.task}`,
      commitSha: sha40(101),
    });
    app.ctx.readCompare = async (_repo, { base, head }) => ({
      complete: true,
      baseSha: base,
      headSha: head,
      paths: ['apps/server/src/app.ts', 'apps/server/test/app.test.ts'],
      diff: '+ok',
      commits: [{ sha: head, parents: [base] }],
    });
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.companyId, company!.id));
    const [planA] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));
    const [planB] = await db
      .insert(subscriptions)
      .values({
        companyId: company!.id,
        provider: 'codex',
        kind: 'personal',
        label: 'Backup Codex',
        ownerPersonId: owner!.id,
        status: 'ready',
      })
      .returning();

    const [dev] = await db
      .insert(departments)
      .values({
        companyId: company!.id,
        name: 'Development',
        templateKey: 'development',
        roleCode: 'DEV',
        position: 1,
        repoUrl: 'https://github.com/example/moonfern.git',
        repoBranch: 'main',
      })
      .returning();
    const openTurn = await echelonsTurn(db, company!.id);

    const roleSkills = (roleKey: string): string[] =>
      app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [];

    const [head] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'head',
        name: 'HeadDev',
        model: 'claude-opus-5-5',
        departmentId: dev!.id,
        subscriptionId: planA!.id,
        roleKey: 'DEV-HEAD',
        skills: roleSkills('DEV-HEAD'),
      })
      .returning();
    const [workerA, workerB, reviewer, tester] = await db
      .insert(agents)
      .values([
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'WorkerA',
          model: 'claude-sonnet-5-5',
          departmentId: dev!.id,
          subscriptionId: planA!.id,
          roleKey: 'DEV-BE',
          skills: roleSkills('DEV-BE'),
        },
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'WorkerB',
          model: 'gpt-6.1-sol',
          departmentId: dev!.id,
          subscriptionId: planB!.id,
          roleKey: 'DEV-BE',
          skills: roleSkills('DEV-BE'),
        },
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'ReviewerOne',
          model: 'claude-opus-5-5',
          departmentId: dev!.id,
          subscriptionId: planA!.id,
          roleKey: 'DEV-REV',
          skills: roleSkills('DEV-REV'),
        },
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'TesterOne',
          model: 'claude-opus-5-5',
          departmentId: dev!.id,
          subscriptionId: planA!.id,
          roleKey: 'DEV-TEST',
          skills: roleSkills('DEV-TEST'),
        },
      ])
      .returning();

    /* Create a top-level goal (with numeric targetValue set, proving task progress still earns first_tier) and a child goal. */
    const topGoal = await createGoal(
      app.ctx,
      company!.id,
      { personId: owner!.id },
      async () => {},
      { title: 'Ship Moonfern v1', departmentId: null, targetValue: 100 },
    );
    const subGoal = await createGoal(
      app.ctx,
      company!.id,
      { personId: owner!.id },
      async () => {},
      { title: 'Core server module', departmentId: dev!.id, parentGoalId: topGoal.id },
    );

    const { task: richTask } = await createTask(app.ctx, { agentId: head!.id }, {
      title: 'Implement core server',
      brief: 'Server module',
      body: 'Spec',
      departmentId: dev!.id,
      assigneeAgentId: workerA!.id,
      reviewerAgentId: reviewer!.id,
      testsAgentId: tester!.id,
      executor: true,
      resultKind: 'code',
      small: true,
      paths: ['apps/server/**'],
      goalId: subGoal.id,
    });

    await db.insert(jobs).values({
      companyId: company!.id,
      subscriptionId: planA!.id,
      agentId: workerA!.id,
      taskId: richTask.id,
      kind: 'conversation',
      prompt: 'queued before limit',
      timeoutMs: 5_000,
      status: 'queued',
    });
    await handOver(app.ctx, (await db.select().from(tasks).where(eq(tasks.id, richTask.id)))[0]!, workerB!.id, 'Plan at limit.');

    const asked = await ask(app.ctx, workerB!.id, richTask.id, {
      kind: 'question',
      text: 'Use strict JSON schema?',
    });
    await answer(app.ctx, { personId: owner!.id }, asked.request.id, { answer: 'Yes, strict schema.' });

    const [failedJob] = await db
      .insert(jobs)
      .values({
        companyId: company!.id,
        subscriptionId: planB!.id,
        agentId: workerB!.id,
        taskId: richTask.id,
        kind: 'conversation',
        prompt: 'attempt 1',
        timeoutMs: 5_000,
        status: 'failed',
        failure: { kind: 'crash', text: 'Exited 1', retryable: false },
        finishedAt: new Date('2026-11-01T09:00:00.000Z'),
      })
      .returning();
    await db.insert(agentEvents).values({
      companyId: company!.id,
      agentId: head!.id,
      kind: 'message',
      data: { silentJob: failedJob!.id, text: 'Watcher alert' },
      createdAt: new Date('2026-11-01T09:05:00.000Z'),
    });
    await db.insert(jobs).values({
      companyId: company!.id,
      subscriptionId: planB!.id,
      agentId: workerB!.id,
      taskId: richTask.id,
      kind: 'conversation',
      prompt: 'attempt 2 recovered',
      timeoutMs: 5_000,
      status: 'done',
      finishedAt: new Date('2026-11-01T09:10:00.000Z'),
    });

    app.ctx.readCommit = async (_repo, want) => ({
      branch: 'branch' in want ? want.branch : `task-${want.task}`,
      commitSha: 'branch' in want && want.branch === `turn-${openTurn.number}` ? sha40(100) : sha40(101),
    });
    await submit(app.ctx, workerB!.id, richTask.id, {
      summary: 'Initial candidate',
      evidence: 'vitest passed',
      review: { baseCommit: sha40(100) },
    });
    await verdict(app.ctx, reviewer!.id, richTask.id, {
      pass: false,
      reviewedCommit: sha40(101),
      comment: 'Missing edge-case validation on empty payload.',
    });
    app.ctx.readCommit = async (_repo, want) => ({
      branch: 'branch' in want ? want.branch : `task-${want.task}`,
      commitSha: 'branch' in want && want.branch === `turn-${openTurn.number}` ? sha40(100) : sha40(102),
    });
    await submit(app.ctx, reviewer!.id, richTask.id, {
      summary: 'Repaired validation',
      evidence: 'vitest passed with edge case',
      review: { baseCommit: sha40(100) },
    });
    const routeAtTests = (await db.select().from(taskRoutes).where(eq(taskRoutes.taskId, richTask.id)))[0]!;
    await report(app.ctx, tester!.id, richTask.id, {
      done: true,
      summary: 'All local tests green on repaired commit.',
      verification: { candidateId: routeAtTests.state.candidateId!, revision: routeAtTests.revision },
    });
    const routeAtAccept = (await db.select().from(taskRoutes).where(eq(taskRoutes.taskId, richTask.id)))[0]!;
    app.ctx.readCommit = async (_repo, want) => ({
      branch: 'branch' in want ? want.branch : `task-${want.task}`,
      commitSha: sha40(102),
    });
    await report(app.ctx, head!.id, richTask.id, {
      done: true,
      summary: 'Accepted into turn.',
      acceptance: {
        candidateId: routeAtAccept.state.candidateId!,
        revision: routeAtAccept.revision,
        integrationCommit: sha40(102),
      },
    });

    const afterRich = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    const richEarnedIds = afterRich.earned.map(e => e.id);
    expect(richEarnedIds).toContain('first_stone');
    expect(richEarnedIds).toContain('answer_from_above');
    expect(richEarnedIds).toContain('strict_judge');
    expect(richEarnedIds).toContain('firefighter');
    expect(richEarnedIds).toContain('gong_heard');
    expect(richEarnedIds).toContain('backup_provider');
    expect(richEarnedIds).toContain('first_tier');
    expect(new Set(richEarnedIds).size).toBe(richEarnedIds.length);
    for (const e of afterRich.earned) {
      expect(e.record.id).toBe(richTask.id);
      expect(Date.parse(e.earnedAt)).not.toBeNaN();
    }

    const [tkTeam] = await db
      .insert(teams)
      .values({ companyId: company!.id, departmentId: dev!.id, name: 'TurnkeyOne', turnkey: true })
      .returning();
    const [tkOne, tkTwo, tkThree] = await db
      .insert(agents)
      .values([
        { companyId: company!.id, kind: 'worker', name: 'TkOne', model: 'm', departmentId: dev!.id, teamId: tkTeam!.id, subscriptionId: planA!.id, roleKey: 'DEV-ENG' },
        { companyId: company!.id, kind: 'worker', name: 'TkTwo', model: 'm', departmentId: dev!.id, teamId: tkTeam!.id, subscriptionId: planA!.id, roleKey: 'DEV-ENG' },
        { companyId: company!.id, kind: 'worker', name: 'TkThree', model: 'm', departmentId: dev!.id, teamId: tkTeam!.id, subscriptionId: planA!.id, roleKey: 'DEV-ENG' },
      ])
      .returning();

    await insertVerifiedTurnkeyTasks(db, {
      companyId: company!.id,
      departmentId: dev!.id,
      agentId: tkOne!.id,
      startNumber: 10,
      count: 8,
      baseAtMs: Date.parse('2026-11-02T10:00:00.000Z'),
    });

    const afterBatch = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(afterBatch.counts.acceptedTasks).toBe(9);
    expect(afterBatch.earned.filter(e => e.id === 'first_stone')).toHaveLength(1);
    expect(afterBatch.earned.filter(e => e.id === 'housewarming')).toHaveLength(1);

    /* Passed check on exact commit: two runs on sha40(201) count ONCE, plus one run on sha40(202) -> 2 passedChecks. */
    const [checkJob] = await db
      .insert(jobs)
      .values({
        companyId: company!.id,
        subscriptionId: planA!.id,
        agentId: tester!.id,
        taskId: richTask.id,
        kind: 'conversation',
        prompt: 'test',
        timeoutMs: 5_000,
        status: 'done',
      })
      .returning();
    const [run1, run2SameSha, run3OtherSha] = await db
      .insert(testRuns)
      .values([
        {
          companyId: company!.id,
          number: 1,
          taskId: richTask.id,
          agentId: tester!.id,
          jobId: checkJob!.id,
          departmentId: dev!.id,
          kind: 'tests',
          branch: 'turn-1',
          commitSha: sha40(201),
          command: '',
          parts: 1,
          timeoutMs: 60_000,
          status: 'passed',
          createdAt: new Date('2026-11-03T10:00:00.000Z'),
          finishedAt: new Date('2026-11-03T10:05:00.000Z'),
        },
        {
          companyId: company!.id,
          number: 2,
          taskId: richTask.id,
          agentId: tester!.id,
          jobId: checkJob!.id,
          departmentId: dev!.id,
          kind: 'tests',
          branch: 'turn-1',
          commitSha: sha40(201),
          command: '',
          parts: 1,
          timeoutMs: 60_000,
          status: 'passed',
          createdAt: new Date('2026-11-03T11:00:00.000Z'),
          finishedAt: new Date('2026-11-03T11:05:00.000Z'),
        },
        {
          companyId: company!.id,
          number: 3,
          taskId: richTask.id,
          agentId: tester!.id,
          jobId: checkJob!.id,
          departmentId: dev!.id,
          kind: 'tests',
          branch: 'turn-1',
          commitSha: sha40(202),
          command: '',
          parts: 1,
          timeoutMs: 60_000,
          status: 'passed',
          createdAt: new Date('2026-11-04T10:00:00.000Z'),
          finishedAt: new Date('2026-11-04T10:05:00.000Z'),
        },
      ])
      .returning();
    await db.insert(testParts).values([
      { companyId: company!.id, runId: run1!.id, part: 1, status: 'passed', commit: sha40(201), finishedAt: new Date('2026-11-03T10:05:00.000Z') },
      { companyId: company!.id, runId: run2SameSha!.id, part: 1, status: 'passed', commit: sha40(201), finishedAt: new Date('2026-11-03T11:05:00.000Z') },
      { companyId: company!.id, runId: run3OtherSha!.id, part: 1, status: 'passed', commit: sha40(202), finishedAt: new Date('2026-11-04T10:05:00.000Z') },
    ]);

    /* Released turn (v0.1.0 on sha40(201) with turn_releases record). */
    await db
      .update(turns)
      .set({
        status: 'closed',
        version: 'v0.1.0',
        commit: sha40(201),
        closedAt: new Date('2026-11-05T12:00:00.000Z'),
      })
      .where(eq(turns.id, openTurn.id));
    await db.insert(turnReleases).values({
      companyId: company!.id,
      turnId: openTurn.id,
      commit: sha40(201),
      baseCommitSha: sha40(100),
      runId: run1!.id,
      tasks: [{ taskId: richTask.id, number: richTask.number, commit: sha40(102), verdicts: [] }],
      covered: true,
      uncovered: [],
      createdAt: new Date('2026-11-05T11:55:00.000Z'),
    });

    /* Reach child goal and two top-level goals (golden_capstone still earns at most once). */
    await setGoalStatus(app.ctx, company!.id, { personId: owner!.id }, async () => {}, subGoal.id, 'reached', subGoal.version);
    await setGoalStatus(app.ctx, company!.id, { personId: owner!.id }, async () => {}, topGoal.id, 'reached', topGoal.version);
    const secondTopGoal = await createGoal(
      app.ctx,
      company!.id,
      { personId: owner!.id },
      async () => {},
      { title: 'Ship Moonfern v2', departmentId: null },
    );
    await setGoalStatus(app.ctx, company!.id, { personId: owner!.id }, async () => {}, secondTopGoal.id, 'reached', secondTopGoal.version);

    /* Gentle rhythm (steady_nile): 4 consecutive ISO weeks (2026-W45..2026-W48) each with >= 3 distinct UTC days of verified results. */
    const rhythmDates = [
      '2026-11-09T10:00:00.000Z',
      '2026-11-11T10:00:00.000Z',
      '2026-11-13T10:00:00.000Z',
      '2026-11-16T10:00:00.000Z',
      '2026-11-18T10:00:00.000Z',
      '2026-11-20T10:00:00.000Z',
      '2026-11-23T10:00:00.000Z',
      '2026-11-25T10:00:00.000Z',
      '2026-11-27T10:00:00.000Z',
    ];
    for (let i = 0; i < rhythmDates.length; i++) {
      await insertVerifiedTurnkeyTasks(db, {
        companyId: company!.id,
        departmentId: dev!.id,
        agentId: tkTwo!.id,
        startNumber: 30 + i,
        count: 1,
        baseAtMs: Date.parse(rhythmDates[i]!),
      });
    }

    await insertVerifiedTurnkeyTasks(db, {
      companyId: company!.id,
      departmentId: dev!.id,
      agentId: tkOne!.id,
      startNumber: 100,
      count: 100,
      baseAtMs: Date.parse('2026-12-01T00:00:00.000Z'),
      stepMs: 3_600_000,
    });
    await insertVerifiedTurnkeyTasks(db, {
      companyId: company!.id,
      departmentId: dev!.id,
      agentId: tkTwo!.id,
      startNumber: 250,
      count: 20,
      baseAtMs: Date.parse('2026-12-10T00:00:00.000Z'),
      stepMs: 3_600_000,
    });
    await insertVerifiedTurnkeyTasks(db, {
      companyId: company!.id,
      departmentId: dev!.id,
      agentId: tkThree!.id,
      startNumber: 300,
      count: 24,
      baseAtMs: Date.parse('2026-12-15T00:00:00.000Z'),
      stepMs: 3_600_000,
    });

    const midRes = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(midRes.counts.passedChecks).toBe(2);
    expect(midRes.counts.releasedTurns).toBe(1);
    expect(midRes.counts.reachedGoals).toBe(3);

    const midIds = midRes.earned.map(e => e.id);
    expect(midIds).toContain('new_department');
    expect(midIds).toContain('steady_nile');
    expect(midIds).toContain('mudbrick_street');
    expect(midIds).toContain('from_tent_to_house');
    expect(midIds).toContain('first_statue');
    expect(midIds).toContain('master_builder');
    expect(midIds).toContain('golden_capstone');
    expect(midRes.earned.filter(e => e.id === 'golden_capstone')).toHaveLength(1);

    /* Reach Lv 30 (858 accepted tasks -> legend) and 2 completed statues (4000 accepted tasks -> statue_alley), verifying all 17 earn once! */
    await insertVerifiedTurnkeyTasks(db, {
      companyId: company!.id,
      departmentId: dev!.id,
      agentId: tkOne!.id,
      startNumber: 500,
      count: 3_900,
      baseAtMs: Date.parse('2027-01-01T00:00:00.000Z'),
      stepMs: 60_000,
    });

    const fullRes = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    const earnedSet = new Set(fullRes.earned.map(e => e.id));
    expect(fullRes.earned).toHaveLength(fullRes.catalogue.length);
    expect(earnedSet.size).toBe(fullRes.catalogue.length);
    for (const cat of fullRes.catalogue) {
      expect(earnedSet.has(cat.id), `expected ${cat.id} to be earned once`).toBe(true);
    }
  });

  it('takes achievements and verified counts back when their underlying records are undone', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.companyId, company!.id));
    const [plan] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));

    const [dev] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const turn = await echelonsTurn(db, company!.id);
    const [tkTeam] = await db
      .insert(teams)
      .values({ companyId: company!.id, departmentId: dev!.id, name: 'Turnkey', turnkey: true })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'WorkerUndo',
        model: 'm',
        departmentId: dev!.id,
        teamId: tkTeam!.id,
        subscriptionId: plan!.id,
        roleKey: 'DEV-ENG',
      })
      .returning();

    /* 1. Accept a turnkey task -> earns first_stone. */
    const { task } = await createTask(app.ctx, { personId: owner!.id }, {
      title: 'Reversible stone',
      brief: 'Stone',
      body: 'Body',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });
    await report(app.ctx, worker!.id, task.id, {
      done: true,
      summary: 'Verified.',
      ...(await recorded(app.ctx, task.id, worker!.id)),
    });

    /* 2. Reach a top-level goal -> earns first_tier + golden_capstone. */
    const goal = await createGoal(
      app.ctx,
      company!.id,
      { personId: owner!.id },
      async () => {},
      { title: 'Reversible pyramid', departmentId: null },
    );
    const reachedGoal = await setGoalStatus(app.ctx, company!.id, { personId: owner!.id }, async () => {}, goal.id, 'reached', goal.version);

    /* 3. Passed check on sha40(301) and released turn. */
    const [job] = await db
      .insert(jobs)
      .values({
        companyId: company!.id,
        subscriptionId: plan!.id,
        agentId: worker!.id,
        taskId: task.id,
        kind: 'conversation',
        prompt: 'check',
        timeoutMs: 5_000,
        status: 'done',
      })
      .returning();
    const [run] = await db
      .insert(testRuns)
      .values({
        companyId: company!.id,
        number: 1,
        taskId: task.id,
        agentId: worker!.id,
        jobId: job!.id,
        departmentId: dev!.id,
        kind: 'tests',
        branch: 'turn-1',
        commitSha: sha40(301),
        command: '',
        parts: 1,
        timeoutMs: 60_000,
        status: 'passed',
        createdAt: new Date('2026-11-10T10:00:00.000Z'),
        finishedAt: new Date('2026-11-10T10:02:00.000Z'),
      })
      .returning();
    await db.insert(testParts).values({
      companyId: company!.id,
      runId: run!.id,
      part: 1,
      status: 'passed',
      commit: sha40(301),
      finishedAt: new Date('2026-11-10T10:02:00.000Z'),
    });
    await db
      .update(turns)
      .set({ status: 'closed', version: 'v0.2.0', commit: sha40(301), closedAt: new Date('2026-11-10T10:10:00.000Z') })
      .where(eq(turns.id, turn.id));
    await db.insert(turnReleases).values({
      companyId: company!.id,
      turnId: turn.id,
      commit: sha40(301),
      baseCommitSha: sha40(300),
      runId: run!.id,
      tasks: [],
      covered: true,
      uncovered: [],
    });

    const peak = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(peak.counts).toEqual({
      acceptedTasks: 1,
      releasedTurns: 1,
      passedChecks: 1,
      reachedGoals: 1,
    });
    expect(peak.earned.map(e => e.id)).toEqual(['first_stone', 'first_tier', 'golden_capstone']);

    /* Reopen the task -> takes first_stone back from earned and showcase! */
    await db.update(tasks).set({ status: 'working', closedAt: null, assigneeAgentId: worker!.id }).where(eq(tasks.id, task.id));
    const afterTaskUndo = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(afterTaskUndo.counts.acceptedTasks).toBe(0);
    expect(afterTaskUndo.earned.map(e => e.id)).not.toContain('first_stone');
    expect(afterTaskUndo.showcase.earned.map(e => e.achievementId)).not.toContain('first_stone');

    /* Reopen the goal -> takes first_tier and golden_capstone back! */
    await setGoalStatus(app.ctx, company!.id, { personId: owner!.id }, async () => {}, goal.id, 'active', reachedGoal.version);
    const afterGoalUndo = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(afterGoalUndo.counts.reachedGoals).toBe(0);
    expect(afterGoalUndo.earned).toEqual([]);
    expect(afterGoalUndo.showcase.earned).toEqual([]);

    /* A newer failed test run on the exact same commit invalidates that commit's passed check! */
    await db.insert(testRuns).values({
      companyId: company!.id,
      number: 2,
      taskId: task.id,
      agentId: worker!.id,
      jobId: job!.id,
      departmentId: dev!.id,
      kind: 'tests',
      branch: 'turn-1',
      commitSha: sha40(301),
      command: '',
      parts: 1,
      timeoutMs: 60_000,
      status: 'failed',
      createdAt: new Date('2026-11-10T11:00:00.000Z'),
      finishedAt: new Date('2026-11-10T11:02:00.000Z'),
    });
    const afterCheckUndo = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(afterCheckUndo.counts.passedChecks).toBe(0);

    /* Reopen the turn -> resets releasedTurns count to 0! */
    await db.update(turns).set({ status: 'open', version: null, commit: null, closedAt: null }).where(eq(turns.id, turn.id));
    const afterAllUndone = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(afterAllUndone.counts).toEqual({
      acceptedTasks: 0,
      releasedTurns: 0,
      passedChecks: 0,
      reachedGoals: 0,
    });
    expect(afterAllUndone.earned).toEqual([]);
  });

  it('earns nothing from refused, failed, manual or activity-only records', async () => {
    const { app, db } = await testApp();
    app.ctx.readCommit = async (_repo, want) => ({
      branch: 'branch' in want ? want.branch : `task-${want.task}`,
      commitSha: 'branch' in want && want.branch.startsWith('turn-') ? 'a'.repeat(40) : 'b'.repeat(40),
    });
    app.ctx.readCompare = async (_repo, { base, head }) => ({
      complete: true,
      baseSha: base,
      headSha: head,
      paths: ['apps/server/src/app.ts'],
      diff: '+broken',
      commits: [{ sha: head, parents: [base] }],
    });
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.companyId, company!.id));
    const [plan] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));

    await db.update(companies).set({ template: 'startup', theme: 'egypt' }).where(eq(companies.id, company!.id));

    const [dev] = await db
      .insert(departments)
      .values({
        companyId: company!.id,
        name: 'Development',
        templateKey: 'development',
        roleCode: 'DEV',
        position: 1,
        repoUrl: 'https://github.com/example/moonfern.git',
        repoBranch: 'main',
      })
      .returning();
    const idleTurn = await echelonsTurn(db, company!.id);

    const roleSkills4 = (roleKey: string): string[] =>
      app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [];

    const [head, worker, reviewer] = await db
      .insert(agents)
      .values([
        {
          companyId: company!.id,
          kind: 'head',
          name: 'Head',
          model: 'claude-opus-5-5',
          departmentId: dev!.id,
          subscriptionId: plan!.id,
          roleKey: 'DEV-HEAD',
          skills: roleSkills4('DEV-HEAD'),
        },
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'Worker',
          model: 'claude-sonnet-5-5',
          departmentId: dev!.id,
          subscriptionId: plan!.id,
          roleKey: 'DEV-BE',
          skills: roleSkills4('DEV-BE'),
        },
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'Rev',
          model: 'claude-opus-5-5',
          departmentId: dev!.id,
          subscriptionId: plan!.id,
          roleKey: 'DEV-REV',
          skills: roleSkills4('DEV-REV'),
        },
      ])
      .returning();

    /* 1. Cancelled task. */
    const { task: cancelledTask } = await createTask(app.ctx, { agentId: head!.id }, {
      title: 'Cancelled work',
      brief: '',
      body: '',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });
    await cancel(app.ctx, { personId: owner!.id }, cancelledTask.id, 'No longer needed.');

    /* 2. Task closed past its route by the orchestrator (done without acceptance). */
    const { task: bypassedTask } = await createTask(app.ctx, { agentId: head!.id }, {
      title: 'Bypassed work',
      brief: '',
      body: '',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });
    await closeTask(app.ctx, { agentId: orchestrator!.id }, bypassedTask.id, {
      status: 'done',
      why: 'Closed administratively without result.',
    });

    /* 3. Task marked done by hand in DB with no route completion or closing report evidence. */
    await db.insert(tasks).values({
      companyId: company!.id,
      number: 99,
      departmentId: dev!.id,
      title: 'Manual DB done row',
      status: 'done',
      executorAgentId: worker!.id,
      closedAt: new Date(),
    });

    /* 4. Refused candidate (verdict pass: false) left working + answered human question on unaccepted task. */
    const { task: refusedTask } = await createTask(app.ctx, { agentId: head!.id }, {
      title: 'Refused candidate',
      brief: '',
      body: '',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      reviewerAgentId: reviewer!.id,
      executor: true,
      resultKind: 'code',
      small: true,
      paths: ['apps/server/**'],
    });
    const q = await ask(app.ctx, worker!.id, refusedTask.id, { kind: 'question', text: 'Proceed?' });
    await answer(app.ctx, { personId: owner!.id }, q.request.id, { answer: 'Go ahead.' });
    await submit(app.ctx, worker!.id, refusedTask.id, {
      summary: 'Broken candidate',
      evidence: 'none',
      review: { baseCommit: 'a'.repeat(40) },
    });
    await verdict(app.ctx, reviewer!.id, refusedTask.id, {
      pass: false,
      reviewedCommit: 'b'.repeat(40),
      comment: 'Fails checks.',
    });

    /* 5. Idle turn closed automatically with closedBecause, and a closed turn without turnReleases. */
    await db
      .update(turns)
      .set({
        status: 'closed',
        closedBecause: 'Hornhoof closed it by itself: nothing to release.',
        closedAt: new Date(),
      })
      .where(eq(turns.id, idleTurn.id));
    await db.insert(turns).values({
      companyId: company!.id,
      departmentId: dev!.id,
      number: 2,
      goal: 'Unrecorded tag turn',
      status: 'closed',
      version: 'v9.9.9',
      commit: sha40(999),
      closedAt: new Date(),
    });

    /* 6. Failed check, stopped check, unpinned check (commitSha null), and work-kind run. */
    const [job] = await db
      .insert(jobs)
      .values({
        companyId: company!.id,
        subscriptionId: plan!.id,
        agentId: worker!.id,
        taskId: refusedTask.id,
        kind: 'conversation',
        prompt: 'lots of chat activity',
        timeoutMs: 5_000,
        status: 'done',
        finishedAt: new Date(),
      })
      .returning();
    await db.insert(testRuns).values([
      { companyId: company!.id, number: 1, taskId: refusedTask.id, agentId: worker!.id, jobId: job!.id, kind: 'tests', commitSha: sha40(401), command: '', parts: 1, timeoutMs: 60_000, status: 'failed' },
      { companyId: company!.id, number: 2, taskId: refusedTask.id, agentId: worker!.id, jobId: job!.id, kind: 'tests', commitSha: sha40(402), command: '', parts: 1, timeoutMs: 60_000, status: 'stopped' },
      { companyId: company!.id, number: 3, taskId: refusedTask.id, agentId: worker!.id, jobId: job!.id, kind: 'tests', commitSha: null, command: 'echo hi', parts: 1, timeoutMs: 60_000, status: 'passed' },
      { companyId: company!.id, number: 4, taskId: refusedTask.id, agentId: worker!.id, jobId: job!.id, kind: 'work', commitSha: sha40(403), command: 'echo work', parts: 1, timeoutMs: 60_000, status: 'passed' },
    ]);

    /* 7. Active goal with manually edited currentValue (500 / 500) NOT marked reached, plus a dropped goal. */
    const activeGoal = await createGoal(
      app.ctx,
      company!.id,
      { personId: owner!.id },
      async () => {},
      { title: 'Active numeric goal', departmentId: null, targetValue: 500, currentValue: 0 },
    );
    await editGoal(app.ctx, company!.id, { personId: owner!.id }, async () => {}, activeGoal.id, { currentValue: 500 }, activeGoal.version);
    const droppedGoal = await createGoal(
      app.ctx,
      company!.id,
      { personId: owner!.id },
      async () => {},
      { title: 'Dropped goal', departmentId: null },
    );
    await setGoalStatus(app.ctx, company!.id, { personId: owner!.id }, async () => {}, droppedGoal.id, 'dropped', droppedGoal.version);

    /* 8. Pure activity: messages, tokens, one-shot calls, prompt edits, extra machines, invites, notes. */
    await db.insert(agentEvents).values({
      companyId: company!.id,
      agentId: worker!.id,
      jobId: job!.id,
      personId: owner!.id,
      kind: 'message',
      data: { text: '100 messages of activity' },
    });
    await db.insert(turnTokens).values({
      jobId: job!.id,
      companyId: company!.id,
      agentId: worker!.id,
      subscriptionId: plan!.id,
      totalTokens: 500_000,
      at: new Date(),
    });
    await db.insert(oneShotCalls).values({
      companyId: company!.id,
      batch: crypto.randomUUID(),
      number: 1,
      jobId: job!.id,
      callerAgentId: worker!.id,
      taskId: refusedTask.id,
      departmentId: dev!.id,
      brief: 'helper',
    });
    await db.insert(agentChanges).values({
      companyId: company!.id,
      agentId: worker!.id,
      personId: owner!.id,
      field: 'prompt',
      before: '',
      after: 'Always write tests',
    });
    await db.insert(machines).values([
      { companyId: company!.id, personId: owner!.id, machineKey: 'm1', hostname: 'box-1' },
      { companyId: company!.id, personId: owner!.id, machineKey: 'm2', hostname: 'box-2' },
    ]);
    await db.insert(notebookNotes).values({
      companyId: company!.id,
      number: 1,
      text: 'Rule by hand',
      personId: owner!.id,
    });
    const [invitedPerson] = await db
      .insert(people)
      .values({ companyId: company!.id, name: 'Newbie', email: 'newbie@moonfern.example', status: 'active', scopeKind: 'company' })
      .returning();
    await db.insert(invites).values({
      tokenHash: sha256Hex('invite-tok'),
      companyId: company!.id,
      personId: invitedPerson!.id,
      createdBy: owner!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      usedAt: new Date(),
    });

    const res = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(res.counts).toEqual({
      acceptedTasks: 0,
      releasedTurns: 0,
      passedChecks: 0,
      reachedGoals: 0,
    });
    expect(res.earned).toEqual([]);
    expect(res.showcase.earned).toEqual([]);
  });

  it('scopes achievements strictly by company with zero cross-company leak', async () => {
    const { app, db } = await testApp();
    const ceoA = await setUpCompany(app);
    const [companyA] = await db.select().from(companies);
    const [planA] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, companyA!.id));
    const [devA] = await db
      .insert(departments)
      .values({ companyId: companyA!.id, name: 'DevA', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [agentA] = await db
      .insert(agents)
      .values({ companyId: companyA!.id, kind: 'worker', name: 'AgentA', model: 'm', departmentId: devA!.id, subscriptionId: planA!.id, roleKey: 'DEV-ENG' })
      .returning();

    const batchA = await insertVerifiedTurnkeyTasks(db, {
      companyId: companyA!.id,
      departmentId: devA!.id,
      agentId: agentA!.id,
      startNumber: 1,
      count: 1,
      baseAtMs: Date.parse('2026-11-20T10:00:00.000Z'),
    });
    const tokenAgentA = 'agent-a-live-token';
    await db.insert(jobs).values({
      companyId: companyA!.id,
      subscriptionId: planA!.id,
      agentId: agentA!.id,
      kind: 'conversation',
      prompt: 'a',
      timeoutMs: 5_000,
      status: 'running',
      toolTokenHash: sha256Hex(tokenAgentA),
    });

    const [companyB] = await db
      .insert(companies)
      .values({ name: 'Bramble Labs', singleton: false, theme: 'egypt' })
      .returning();
    const [personB] = await db
      .insert(people)
      .values({
        companyId: companyB!.id,
        name: 'Maya Bramble',
        email: 'maya@bramble.example',
        status: 'active',
        scopeKind: 'company',
        isOwner: true,
      })
      .returning();
    const tokenPersonB = 'person-b-session-token';
    await db.insert(sessions).values({
      tokenHash: sha256Hex(tokenPersonB),
      personId: personB!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      beforeHostCookie: false,
    });
    const [planB] = await db
      .insert(subscriptions)
      .values({ companyId: companyB!.id, provider: 'claude', kind: 'personal', label: 'B Plan', ownerPersonId: personB!.id, status: 'ready' })
      .returning();
    const [devB] = await db
      .insert(departments)
      .values({ companyId: companyB!.id, name: 'DevB', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [agentB] = await db
      .insert(agents)
      .values({ companyId: companyB!.id, kind: 'worker', name: 'AgentB', model: 'm', departmentId: devB!.id, subscriptionId: planB!.id, roleKey: 'DEV-ENG' })
      .returning();
    const batchB = await insertVerifiedTurnkeyTasks(db, {
      companyId: companyB!.id,
      departmentId: devB!.id,
      agentId: agentB!.id,
      startNumber: 1,
      count: 3,
      baseAtMs: Date.parse('2026-11-20T12:00:00.000Z'),
    });
    const [goalB] = await db
      .insert(goals)
      .values({
        companyId: companyB!.id,
        number: 1,
        title: 'Bramble Secret Goal',
        responsiblePersonId: personB!.id,
        status: 'reached',
        createdAt: new Date('2026-11-20T13:00:00.000Z'),
        updatedAt: new Date('2026-11-20T13:00:00.000Z'),
      })
      .returning();
    await db.insert(goalEvents).values({
      companyId: companyB!.id,
      goalId: goalB!.id,
      kind: 'status',
      personId: personB!.id,
      data: { fromStatus: 'active', toStatus: 'reached' },
      createdAt: new Date('2026-11-20T13:00:00.000Z'),
    });
    const tokenAgentB = 'agent-b-live-token';
    await db.insert(jobs).values({
      companyId: companyB!.id,
      subscriptionId: planB!.id,
      agentId: agentB!.id,
      kind: 'conversation',
      prompt: 'b',
      timeoutMs: 5_000,
      status: 'running',
      toolTokenHash: sha256Hex(tokenAgentB),
    });

    /* Query-string companyId spoofing is rejected, and agent tokens in both companies are refused. */
    expect(
      (await app.inject({ url: `/api/world/rewards?companyId=${companyB!.id}`, ...as(ceoA) })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `/api/world/rewards/showcase?companyId=${companyB!.id}`, ...as(ceoA) })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/api/world/rewards', headers: { authorization: `Bearer ${tokenAgentA}` } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/world/rewards', headers: { authorization: `Bearer ${tokenAgentB}` } })).statusCode,
    ).toBe(401);

    const memberA = await invitePerson(app, ceoA, {
      name: 'Nora A',
      email: 'nora@moonfern.example',
      access: { whole: true },
    });
    const resPersonA = await app.inject({ url: '/api/world/rewards', ...as(ceoA) });
    const resMemberA = await app.inject({ url: '/api/world/rewards', ...as(memberA) });
    const resPersonB = await app.inject({ url: '/api/world/rewards', ...as(tokenPersonB) });

    expect(resPersonA.statusCode).toBe(200);
    expect(resMemberA.statusCode).toBe(200);
    expect(resPersonB.statusCode).toBe(200);

    const dataA = resPersonA.json() as RewardsPayload;
    const dataB = resPersonB.json() as RewardsPayload;
    expect(resMemberA.json()).toEqual(dataA);

    expect(dataA.counts.acceptedTasks).toBe(1);
    expect(dataA.counts.reachedGoals).toBe(0);
    expect(resPersonA.body).toContain(batchA.firstId);
    expect(resPersonA.body).not.toContain(batchB.firstId);
    expect(resPersonA.body).not.toContain(goalB!.id);
    expect(resPersonA.body).not.toContain('Bramble');

    expect(dataB.counts.acceptedTasks).toBe(3);
    expect(dataB.counts.reachedGoals).toBe(1);
    expect(dataB.earned.map(e => e.id)).toEqual(expect.arrayContaining(['first_stone', 'housewarming', 'golden_capstone']));
    expect(resPersonB.body).toContain(batchB.firstId);
    expect(resPersonB.body).toContain(goalB!.id);
    expect(resPersonB.body).not.toContain(batchA.firstId);
  });

  it('exposes only public-safe fields in showcase and share with zero task text, people names or private identifiers', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.companyId, company!.id));
    const [plan] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));

    const sensitiveTokens = [
      'Moonfern-Confidential-Corp',
      'Elena-Secret-Founder',
      'elena.founder@moonfern.example',
      'Stealth-Dept-77',
      'Whisper-Worker-88',
      'vault-host-99.internal',
      'Private-Max-Subscription',
      'Confidential-Task-Title-4412',
      'Confidential-Task-Brief-4412',
      'Confidential-Task-Body-4412',
      'Confidential-Goal-Title-9910',
      'Confidential-Goal-Why-9910',
    ];

    await db
      .update(companies)
      .set({ name: 'Moonfern-Confidential-Corp', theme: 'egypt' })
      .where(eq(companies.id, company!.id));
    await db
      .update(people)
      .set({ name: 'Elena-Secret-Founder', email: 'elena.founder@moonfern.example' })
      .where(eq(people.id, owner!.id));
    await db
      .update(subscriptions)
      .set({ label: 'Private-Max-Subscription' })
      .where(eq(subscriptions.id, plan!.id));
    await db.insert(machines).values({
      companyId: company!.id,
      personId: owner!.id,
      machineKey: 'priv-key',
      hostname: 'vault-host-99.internal',
    });

    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Stealth-Dept-77', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [tkTeam] = await db
      .insert(teams)
      .values({ companyId: company!.id, departmentId: dept!.id, name: 'TurnkeyPriv', turnkey: true })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Whisper-Worker-88',
        model: 'm',
        departmentId: dept!.id,
        teamId: tkTeam!.id,
        subscriptionId: plan!.id,
        roleKey: 'DEV-ENG',
      })
      .returning();

    const { task } = await createTask(app.ctx, { personId: owner!.id }, {
      title: 'Confidential-Task-Title-4412',
      brief: 'Confidential-Task-Brief-4412',
      body: 'Confidential-Task-Body-4412',
      departmentId: dept!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });
    await report(app.ctx, worker!.id, task.id, {
      done: true,
      summary: 'Confidential-Task-Body-4412 verified.',
      ...(await recorded(app.ctx, task.id, worker!.id)),
    });

    const goal = await createGoal(
      app.ctx,
      company!.id,
      { personId: owner!.id },
      async () => {},
      { title: 'Confidential-Goal-Title-9910', why: 'Confidential-Goal-Why-9910', departmentId: null },
    );
    await setGoalStatus(app.ctx, company!.id, { personId: owner!.id }, async () => {}, goal.id, 'reached', goal.version);

    const fullRes = await app.inject({ url: '/api/world/rewards', ...as(ceo) });
    const showcaseRes = await app.inject({ url: '/api/world/rewards/showcase', ...as(ceo) });
    expect(fullRes.statusCode).toBe(200);
    expect(showcaseRes.statusCode).toBe(200);

    const fullJson = fullRes.json() as RewardsPayload;
    const showcaseBody = showcaseRes.body;
    expect(showcaseRes.json()).toEqual(fullJson.showcase);
    expect(fullJson.showcase.theme).toBe('egypt');
    expect(fullJson.showcase.earned.length).toBeGreaterThanOrEqual(3);

    for (const token of sensitiveTokens) {
      expect(showcaseBody).not.toContain(token);
      /* Internal rewards response also never echoes private task/goal prose or person names. */
      expect(fullRes.body).not.toContain(token);
    }

    /* Showcase carries zero UUIDs, zero commit SHAs, zero ISO timestamps (including date-only stamps), and zero counts! */
    expect(showcaseBody).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(showcaseBody).not.toMatch(/\b[0-9a-f]{40}\b/i);
    expect(showcaseBody).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    for (const card of fullJson.showcase.earned) {
      expect(Object.keys(card).sort()).toEqual([
        'achievementId',
        'artKey',
        'captions',
        'display',
        'name',
        'scope',
        'share',
        'tier',
      ]);
      expect(card.artKey).toBeNull();
      expect((card.captions.en ?? []).length).toBeGreaterThan(0);
      expect((card.captions.ru ?? []).length).toBeGreaterThan(0);
      expect(card.share.path).toBe(`https://hornhoof.org/found?w=egypt&k=${card.achievementId}`);
      expect((card.share.text.en ?? '').length).toBeLessThan(300);
      expect((card.share.text.ru ?? '').length).toBeLessThan(300);
      expect(card.share.text.en).toContain(card.name.en);
      expect(card.share.text.ru).toContain(card.name.ru);
    }
  });

  it('earns backup_provider from durable agentChanges fallback, strict_judge from declined approvals, and leaves zero currency fields in API or schema', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.companyId, company!.id));
    const [claudePlan] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));
    const [codexPlan] = await db
      .insert(subscriptions)
      .values({
        companyId: company!.id,
        provider: 'codex',
        kind: 'personal',
        label: 'Codex Backup',
        ownerPersonId: owner!.id,
        status: 'ready',
      })
      .returning();

    const [dev] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Dev', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [tkTeam] = await db
      .insert(teams)
      .values({ companyId: company!.id, departmentId: dev!.id, name: 'Turnkey', turnkey: true })
      .returning();
    const [worker, manualWorker] = await db
      .insert(agents)
      .values([
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'FallbackWorker',
          model: 'gpt-6.1-sol',
          departmentId: dev!.id,
          teamId: tkTeam!.id,
          subscriptionId: codexPlan!.id,
          roleKey: 'DEV-BE',
        },
        {
          companyId: company!.id,
          kind: 'worker',
          name: 'ManualSwitchWorker',
          model: 'gpt-6.1-sol',
          departmentId: dev!.id,
          teamId: tkTeam!.id,
          subscriptionId: codexPlan!.id,
          roleKey: 'DEV-BE',
        },
      ])
      .returning();

    /* Manual subscription edit by a person (personId IS NOT NULL) must NOT earn backup_provider. */
    const manualAt = new Date('2026-11-22T08:00:00.000Z');
    await db.insert(agentChanges).values({
      companyId: company!.id,
      agentId: manualWorker!.id,
      personId: owner!.id,
      actingAgentId: null,
      byOrchestrator: false,
      field: 'subscription',
      before: claudePlan!.id,
      after: codexPlan!.id,
      createdAt: manualAt,
    });
    const { task: manualTask } = await createTask(app.ctx, { personId: owner!.id }, {
      title: 'Manual switch stone',
      brief: 'Manual plan edit',
      body: 'Spec',
      departmentId: dev!.id,
      assigneeAgentId: manualWorker!.id,
      executor: true,
    });
    await db.insert(jobs).values({
      companyId: company!.id,
      subscriptionId: codexPlan!.id,
      agentId: manualWorker!.id,
      taskId: manualTask.id,
      kind: 'conversation',
      prompt: 'after manual edit',
      timeoutMs: 5_000,
      status: 'done',
      createdAt: new Date('2026-11-22T08:05:00.000Z'),
      finishedAt: new Date('2026-11-22T08:10:00.000Z'),
    });
    await report(app.ctx, manualWorker!.id, manualTask.id, {
      done: true,
      summary: 'Completed after manual plan switch.',
      ...(await recorded(app.ctx, manualTask.id, manualWorker!.id)),
    });

    const beforeAutoFallback = (await app.inject({ url: '/api/world/rewards', ...as(ceo) })).json() as RewardsPayload;
    expect(beforeAutoFallback.earned.map(e => e.id)).not.toContain('backup_provider');

    /* Durable automatic fallback history in agentChanges (personId: null, byOrchestrator: false, agentFallbacks empty). */
    const fallbackAt = new Date('2026-11-22T09:00:00.000Z');
    await db.insert(agentChanges).values({
      companyId: company!.id,
      agentId: worker!.id,
      personId: null,
      actingAgentId: null,
      byOrchestrator: false,
      field: 'subscription',
      before: claudePlan!.id,
      after: codexPlan!.id,
      createdAt: fallbackAt,
    });

    const { task } = await createTask(app.ctx, { personId: owner!.id }, {
      title: 'Resilient stone',
      brief: 'Built on fallback plan after approval rework',
      body: 'Spec',
      departmentId: dev!.id,
      assigneeAgentId: worker!.id,
      executor: true,
    });

    const approvalReq = await ask(app.ctx, worker!.id, task.id, {
      kind: 'approval',
      text: 'Approve candidate 1?',
      commit: sha40(701),
      topic: 'release',
    });
    await answer(app.ctx, { personId: owner!.id }, approvalReq.request.id, {
      approve: false,
      answer: 'Add edge-case guard before landing.',
    });

    await db.insert(jobs).values({
      companyId: company!.id,
      subscriptionId: codexPlan!.id,
      agentId: worker!.id,
      taskId: task.id,
      kind: 'conversation',
      prompt: 'repair after declined approval',
      timeoutMs: 5_000,
      status: 'done',
      createdAt: new Date('2026-11-22T09:05:00.000Z'),
      finishedAt: new Date('2026-11-22T09:10:00.000Z'),
    });
    await report(app.ctx, worker!.id, task.id, {
      done: true,
      summary: 'Edge-case guard verified.',
      ...(await recorded(app.ctx, task.id, worker!.id)),
    });

    const rewardsHttp = await app.inject({ url: '/api/world/rewards', ...as(ceo) });
    const showcaseHttp = await app.inject({ url: '/api/world/rewards/showcase', ...as(ceo) });
    expect(rewardsHttp.statusCode).toBe(200);
    expect(showcaseHttp.statusCode).toBe(200);

    const res = rewardsHttp.json() as RewardsPayload;
    const earnedIds = res.earned.map(e => e.id);
    expect(earnedIds).toContain('backup_provider');
    expect(earnedIds).toContain('strict_judge');
    expect(earnedIds).toContain('answer_from_above');

    /* Ivan's 24.11 decision: zero property, table, or column named gold, treasury, or balance anywhere in API or schema! */
    const forbiddenFieldRe = /gold|treasury|balance/i;
    const apiKeys = [...collectObjectKeys(res), ...collectObjectKeys(showcaseHttp.json())];
    expect(apiKeys.filter(k => forbiddenFieldRe.test(k))).toEqual([]);

    const schemaNames: string[] = [];
    for (const [exportName, val] of Object.entries(schema)) {
      schemaNames.push(exportName);
      if (isTable(val)) {
        schemaNames.push(getTableName(val));
        for (const [colProp, col] of Object.entries(getTableColumns(val))) {
          schemaNames.push(colProp, col.name);
        }
      }
    }
    expect(schemaNames.filter(name => forbiddenFieldRe.test(name))).toEqual([]);
  });
});
