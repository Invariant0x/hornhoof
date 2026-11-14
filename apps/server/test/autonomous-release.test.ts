import { randomUUID } from 'node:crypto';
import { hashTestEnvironment } from '@hornhoof/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, jobs, people, requests, taskEvents, tasks, testParts, testRuns } from '../src/db/schema.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { createTask, loadTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { acceptDescription, noteTestCapabilities } from '../src/modules/testruns/describe.js';
import { partDone, pumpTests, startRun } from '../src/modules/testruns/runs.js';
import { company } from './department-owner-fixture.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';
import { as, listen, mcp } from './helpers.js';

const MAIN_BASE = '1'.repeat(40);
const CANDIDATE = HEAD;
const OTHER_SHA = '9'.repeat(40);

type ToolRes = { content: { type: string; text: string }[]; isError?: boolean };

async function releaseFixture() {
  const f = await fixture({ turn: null });
  await listen(f.app);
  /* Outside a turn, echelons code tasks integrate to main; we still drive full echelons + MCP tools on the repository. */
  const { app, ctx, db, ceoToken, head, author, reviewer, tester } = f;
  const [ceo] = await db.select().from(people);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const departmentId = head.departmentId!;

  let mainCommit = MAIN_BASE;
  let branchCommit = CANDIDATE;
  let fastForward = true;
  let compareProblem: string | null = null;

  ctx.readCommit = async (_repo, ref) => {
    const branch = 'branch' in ref ? ref.branch : `task-${ref.task}`;
    if (branch === 'main') return { branch: 'main', commitSha: mainCommit };
    return { branch, commitSha: branchCommit };
  };
  ctx.readCompare = async (_repo, want) => {
    if (compareProblem) return { complete: false, reason: compareProblem };
    if (want.base === mainCommit && !fastForward) return { complete: false, reason: 'Branch diverged from main.' };
    return { complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' };
  };

  /* Create an echelons code task with turnId = null (integrating to main) by opening an echelons turn, creating the task, then clearing turnId. */
  const { echelonsTurn } = await import('./helpers.js');
  await echelonsTurn(db, head.companyId);
  const { task } = await f.create({ small: true, paths: ['logic/totals.ts'] });
  await db.update(tasks).set({ turnId: null }).where(eq(tasks.id, task.id));

  let tokenSeq = 0;
  const openTools = async (agent: typeof head, createdBy: string | null = null) => {
    const token = `auto-rel-token-${++tokenSeq}-0123456789abcdef0123456789`;
    const [job] = await db
      .insert(jobs)
      .values({
        companyId: head.companyId,
        subscriptionId: agent.subscriptionId!,
        agentId: agent.id,
        taskId: task.id,
        kind: 'conversation',
        prompt: 'Release check',
        timeoutMs: 900_000,
        status: 'running',
        startedAt: new Date(Date.now() + tokenSeq * 1_000),
        toolTokenHash: hashToken(token),
        createdBy,
        answersCeo: createdBy !== null,
      })
      .returning();
    const client = await mcp(app, token);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as ToolRes;
      return { text: res.content[0]?.text ?? '', isError: res.isError === true };
    };
    return { job: job!, client, call };
  };

  const setAutonomous = (token: string, enabled: boolean, deptId = departmentId) =>
    app.inject({
      method: 'PUT',
      url: `/api/departments/${deptId}/approval-policy/autonomous-release`,
      payload: { enabled },
      ...as(token),
    });

  const policy = (token = ceoToken, deptId = departmentId) =>
    app.inject({ method: 'GET', url: `/api/departments/${deptId}/approval-policy`, ...as(token) });

  const journal = (token = ceoToken, query = '') =>
    app.inject({ method: 'GET', url: `/api/autonomous-releases${query}`, ...as(token) });

  /* Run an authenticated product-manifest test run on `commit` with the chosen profile ('full' or 'fast'), optional suite, or file cache reuse. */
  const runProductSuite = async (opts: {
    commit?: string;
    branch?: string;
    profile?: 'full' | 'fast';
    suite?: string;
    reused?: number;
    status?: 'passed' | 'failed';
    candidate?: { candidateId: string; revision: number; baseCommit: string };
  } = {}) => {
    const sha = opts.commit ?? CANDIDATE;
    const runTask = opts.candidate ? task : f.task;
    const runner = opts.candidate ? tester : author;
    const branch = opts.branch ?? `task-${runTask.number}`;
    const chosenProfile = opts.profile ?? 'full';
    const prevBranchCommit = branchCommit;
    branchCommit = sha;

    const { job } = await openTools(runner);
    await startRun(
      ctx,
      { id: job.id, companyId: head.companyId, agentId: runner.id, agentKind: runner.kind, departmentId },
      {
        task: runTask.id,
        branch,
        profile: chosenProfile,
        ...(opts.suite ? { suite: opts.suite } : {}),
        ...(opts.candidate ? { candidate: { candidateId: opts.candidate.candidateId, revision: opts.candidate.revision } } : {}),
      },
    );
    const [started] = await db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.taskId, runTask.id), eq(testRuns.agentId, runner.id)))
      .orderBy(desc(testRuns.number))
      .limit(1);
    const request = { ...started!.environmentRequest!, requestId: randomUUID(), builtin: true, sentAt: new Date().toISOString() };
    await db.update(testRuns).set({ environmentRequest: request }).where(eq(testRuns.id, started!.id));

    const { snapshot: environment } = await planningEnvironment();
    const { description } = environment;
    const { manifest } = description;
    manifest.runtimes = [{ id: 'node', version: '22' }];
    manifest.profiles = [
      { id: 'fast', requiredSuiteIds: ['vitest'] },
      { id: 'full', requiredSuiteIds: ['vitest', 'e2e'] },
    ];
    manifest.suites = [
      { ...manifest.suites[0]!, id: 'vitest', profiles: ['fast', 'full'], finalChecks: [] },
      { ...manifest.suites[0]!, id: 'e2e', files: ['test/e2e.test.ts'], profiles: ['full'], finalChecks: [] },
    ];
    manifest.execution = { version: 2, fullRun: { everyTurns: 5, replaces: 'fast', profile: 'full' } };
    description.repositoryScope = request.repositoryScope;
    description.commitSha = sha;
    description.inventory = [
      { ...description.inventory[0]!, suiteId: 'vitest', file: 'logic/totals.test.ts' },
      { ...description.inventory[0]!, suiteId: 'e2e', file: 'test/e2e.test.ts' },
    ];
    description.manifestSource = JSON.stringify(manifest);
    description.manifestHash = await hashTestEnvironment(description.manifestSource);
    const runtimes = [
      { id: 'node', version: '22.0.0', fingerprint: 'e'.repeat(64) },
      { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'f'.repeat(64) },
    ];
    description.runtimeCapabilities = runtimes;
    const fingerprints = description.inventory.map((unit, idx) => ({
      suiteId: unit.suiteId,
      file: unit.file,
      fingerprint: String(idx + 1).repeat(64),
    }));
    noteTestCapabilities(ctx, BUILTIN, { testEnvironmentVersion: 1, testRuntimes: runtimes });
    await acceptDescription(ctx, BUILTIN, {
      type: 'tests.described',
      requestId: request.requestId,
      commitSha: sha,
      result: {
        status: 'ready',
        description,
        fingerprints,
        ...(opts.candidate
          ? {
              baseFingerprints: {
                commitSha: opts.candidate.baseCommit,
                fingerprints: fingerprints.map(fp => ({ ...fp, fingerprint: '8'.repeat(64) })),
              },
            }
          : {}),
      },
    });

    const planned = await db.select().from(testParts).where(eq(testParts.runId, started!.id));
    const pass = (opts.status ?? 'passed') === 'passed';
    for (const part of planned.sort((a, b) => a.part - b.part)) {
      const selection = part.environmentSelection!.selection;
      const identity = {
        commitSha: sha,
        manifestHash: description.manifestHash,
        runtimes,
        dependencies: { key: null, hit: false },
        environments: [],
        phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 },
      };
      const count = selection.kind === 'batch' ? selection.selections.length : 1;
      const receipt =
        selection.kind === 'batch'
          ? {
              ...identity,
              version: 2 as const,
              profile: chosenProfile,
              selection,
              outcomes: Array.from({ length: count }, (_, index) => ({
                index,
                status: (pass ? 'passed' : 'failed') as 'passed' | 'failed',
                exitCode: pass ? 0 : 1,
              })),
            }
          : selection.kind === 'suite'
            ? { ...identity, version: 1 as const, kind: 'suite' as const, suiteId: selection.suiteId, files: selection.files }
            : null;
      await db.update(testParts).set({ status: 'running', builtin: true, startedAt: new Date() }).where(eq(testParts.id, part.id));
      await partDone(ctx, BUILTIN, {
        type: 'tests.done',
        partId: part.id,
        ok: pass,
        error: null,
        exitCode: pass ? 0 : 1,
        commit: sha,
        log: pass ? 'Full suite passed.' : 'Suite failed.',
        ...(receipt ? { environmentReceipt: receipt } : {}),
      });
    }
    await pumpTests(ctx);
    if (opts.reused) {
      await db
        .update(testRuns)
        .set({
          fileCache: {
            mode: 'cached',
            turn: null,
            mainLine: false,
            fingerprints: [],
            reused: opts.reused,
            preparationReused: false,
            wouldSkip: [],
            compared: opts.reused,
            mismatches: [],
            notes: [],
          } as never,
        })
        .where(eq(testRuns.id, started!.id));
    }
    branchCommit = prevBranchCommit;
    const [finished] = await db.select().from(testRuns).where(eq(testRuns.id, started!.id));
    return finished!;
  };

  /* Advance `task` through Author submit -> independent Reviewer PASS verdict -> Tests verification so it stands ready for main. */
  const verifyThroughEchelons = async () => {
    await submit(ctx, author.id, task.id, { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit: BASE } });
    await verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Independent review passed.', reviewedCommit: CANDIDATE });
    const snap = (await f.detail(task.id)).echelons;
    const candidateRun = await runProductSuite({
      commit: CANDIDATE,
      profile: 'full',
      candidate: { candidateId: snap.candidateId!, revision: snap.revision, baseCommit: BASE },
    });
    await report(ctx, tester.id, task.id, {
      done: true,
      summary: 'Candidate verified.',
      verification: { candidateId: snap.candidateId!, revision: snap.revision, runIds: [candidateRun.id] },
    });
    const ready = (await f.detail(task.id)).echelons;
    return {
      candidateRun,
      acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: CANDIDATE },
    };
  };

  return {
    ...f,
    ceo: ceo!,
    orchestrator: orchestrator!,
    departmentId,
    task,
    openTools,
    setAutonomous,
    policy,
    journal,
    runProductSuite,
    verifyThroughEchelons,
    setMain: (sha: string) => {
      mainCommit = sha;
    },
    setBranch: (sha: string) => {
      branchCommit = sha;
    },
    setFastForward: (ok: boolean) => {
      fastForward = ok;
    },
    setCompareProblem: (problem: string | null) => {
      compareProblem = problem;
    },
  };
}

describe('autonomous release for exact commits to main', () => {
  it('defaults to off and requires a human approval card when off even if all three conditions hold', async () => {
    const f = await releaseFixture();
    const view = (await f.policy()).json();
    expect(view).toMatchObject({ autonomousRelease: false, canSetAutonomousRelease: true });

    const { call: headCall } = await f.openTools(f.head);
    const mcpPolicy = JSON.parse((await headCall('approval_policy', { department: f.departmentId })).text);
    expect(mcpPolicy.autonomousRelease).toBe(false);

    const { acceptance } = await f.verifyThroughEchelons();
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    /* Echelons acceptance to main without a human card is refused while off. */
    f.setMain(CANDIDATE);
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Ship without card.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });

    /* ask_person with commit opens a waiting human card while off. */
    f.setMain(MAIN_BASE);
    const releaseTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Release 0.23.7', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const asked = await headCall('ask_person', { task: releaseTask.number, question: 'Approve release?', commit: CANDIDATE });
    expect(asked.isError).toBe(false);
    expect(asked.text).toContain('waits for a person');
    expect((await loadTask(f.db, releaseTask.id)).status).toBe('waiting');
    const open = await f.db.select().from(requests).where(and(eq(requests.taskId, releaseTask.id), eq(requests.status, 'open')));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'approval', commit: CANDIDATE, decisionTopic: 'release' });
  });

  it('passes without a card and records a company journal entry when enabled by the human CEO and all three conditions hold', async () => {
    const f = await releaseFixture();
    const toggled = await f.setAutonomous(f.ceoToken, true);
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json()).toMatchObject({ autonomousRelease: true, canSetAutonomousRelease: true });

    const { acceptance } = await f.verifyThroughEchelons();
    const fullRun = await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    const releaseTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Release 0.23.7', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const { call: headCall } = await f.openTools(f.head);
    const mcpPolicy = JSON.parse((await headCall('approval_policy', { department: f.departmentId })).text);
    expect(mcpPolicy.autonomousRelease).toBe(true);

    /* ask_person with exact commit auto-approves without opening a human card. */
    const autoAsked = await headCall('ask_person', { task: releaseTask.number, question: 'Release 0.23.7 to main.', commit: CANDIDATE });
    expect(autoAsked.isError).toBe(false);
    expect(autoAsked.text).not.toContain('waits for a person');
    expect(autoAsked.text).toContain(CANDIDATE);
    expect((await loadTask(f.db, releaseTask.id)).status).toBe('open');
    expect(await f.db.select().from(requests).where(eq(requests.taskId, releaseTask.id))).toEqual([]);

    /* request_approval on channel commit with exact commit also auto-approves without opening a card. */
    const reqTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Publish commit', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const autoReq = await headCall('request_approval', {
      task: reqTask.number,
      channel: 'commit',
      kind: 'main-release',
      text: 'Push verified release commit.',
      commit: CANDIDATE,
    });
    expect(autoReq.isError).toBe(false);
    expect(autoReq.text).not.toContain('waits for a person');
    expect(await f.db.select().from(requests).where(eq(requests.taskId, reqTask.id))).toEqual([]);

    /* Echelons acceptCandidate on main succeeds without any human request card. */
    f.setMain(CANDIDATE);
    const closed = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated under autonomous release.', acceptance });
    expect(closed.task.status).toBe('done');

    /* Company journal shows who requested each auto-approval, the 40-char SHA, the run_tests number and the reviewer PASS verdict. */
    const entries = (await f.journal()).json().entries;
    const deptEntries = (await f.app.inject({ method: 'GET', url: `/api/autonomous-releases?department=${f.departmentId}`, ...as(f.ceoToken) })).json().entries;
    expect(deptEntries).toEqual(entries);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskNumber: releaseTask.number,
          agentId: f.head.id,
          agentName: f.head.name,
          commitSha: CANDIDATE,
          testRunId: fullRun.id,
          testRunNumber: fullRun.number,
          reviewerAgentId: f.reviewer.id,
          reviewerName: f.reviewer.name,
          verdictStage: 'review',
        }),
      ]),
    );
  });

  it('refuses auto-approval without a green full run, with a narrow/cached/stale/failed run, or with a full run on another SHA', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();

    const expectNeedsCard = async (label: string, sha = CANDIDATE) => {
      const { call: headCall } = await f.openTools(f.head);
      const t = (
        await createTask(
          f.ctx,
          { agentId: f.head.id },
          { title: label, brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
        )
      ).task;
      const res = await headCall('ask_person', { task: t.number, question: `Release (${label})?`, commit: sha });
      expect(res.isError, label).toBe(false);
      expect(res.text, label).toContain('waits for a person');
      expect((await loadTask(f.db, t.id)).status, label).toBe('waiting');
    };

    /* Only candidate-delta run exists so far (not a whole-suite run). */
    await expectNeedsCard('candidate-delta-only');

    /* Narrow fast profile leaves out e2e suite. */
    await f.runProductSuite({ commit: CANDIDATE, profile: 'fast' });
    await expectNeedsCard('fast-profile');

    /* Single-suite run leaves out the rest. */
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full', suite: 'vitest' });
    await expectNeedsCard('single-suite');

    /* Cached file-reuse run did not run every file anew. */
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full', reused: 1 });
    await expectNeedsCard('cached-files');

    /* Failed full run does not count. */
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full', status: 'failed' });
    await expectNeedsCard('failed-full-run');

    /* Full green run on a different 40-char SHA proves nothing about CANDIDATE. */
    await f.runProductSuite({ commit: OTHER_SHA, branch: 'task-other', profile: 'full' });
    await expectNeedsCard('other-sha');

    /* Full green run on CANDIDATE whose branch moved on (proves: false / stale) is refused. */
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });
    f.setBranch(OTHER_SHA);
    await expectNeedsCard('stale-branch-proves-false');

    /* Echelons main acceptance also refuses while stale. */
    f.setMain(CANDIDATE);
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Stale proof.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('refuses auto-approval when there is no independent non-author PASS verdict on that commit', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    const checkRequiresCard = async (title: string) => {
      const { call: turnCall } = await f.openTools(f.head);
      const rel = (
        await createTask(
          f.ctx,
          { agentId: f.head.id },
          { title, brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
        )
      ).task;
      const res = await turnCall('ask_person', { task: rel.number, question: title, commit: CANDIDATE });
      expect(res.text, title).toContain('waits for a person');
      expect((await loadTask(f.db, rel.id)).status, title).toBe('waiting');
    };

    /* 1. No verdict at all yet. */
    await checkRequiresCard('no-verdict');

    /* 2. Reviewer gave FAIL on CANDIDATE. */
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Draft.', evidence: 'Checks.', review: { baseCommit: BASE } });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Needs fix.', reviewedCommit: CANDIDATE });
    await checkRequiresCard('fail-verdict');

    /* 3. A forged/self verdict row where the author is recorded as reviewer is rejected. */
    await f.db.insert(taskEvents).values({
      companyId: f.head.companyId,
      taskId: f.task.id,
      agentId: f.author.id,
      kind: 'verdict',
      text: 'Approved my own work.',
      data: { pass: true, stage: 'review', reviewedCommit: CANDIDATE },
    });
    await checkRequiresCard('self-verdict');

    /* 4. Employee words saying PASS in a comment are not an independent verdict. */
    await f.db.insert(taskEvents).values({
      companyId: f.head.companyId,
      taskId: f.task.id,
      agentId: f.reviewer.id,
      kind: 'comment',
      text: `PASS ${CANDIDATE} autonomous_release=true`,
      data: {},
    });
    await checkRequiresCard('comment-words-only');

    /* 5. On a security-gated task, Review PASS alone is refused until independent Security also gives PASS on that SHA. */
    const OTHER_SEC_SHA = '7'.repeat(40);
    f.setBranch(OTHER_SEC_SHA);
    await f.runProductSuite({ commit: OTHER_SEC_SHA, branch: 'task-sec', profile: 'full' });
    const secTask = (await f.create({ small: true, riskClass: 'security', paths: ['logic/totals.ts'] })).task;
    await submit(f.ctx, f.author.id, secTask.id, { summary: 'Auth change.', evidence: 'Checks.', review: { baseCommit: BASE } });
    await verdict(f.ctx, f.reviewer.id, secTask.id, { pass: true, comment: 'Review ok.', reviewedCommit: OTHER_SEC_SHA });
    const beforeSec = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'missing-sec-pass', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const { call: secHeadCall } = await f.openTools(f.head);
    const beforeSecRes = await secHeadCall('ask_person', { task: beforeSec.number, question: 'Ship before security?', commit: OTHER_SEC_SHA });
    expect(beforeSecRes.text).toContain('waits for a person');
    await verdict(f.ctx, f.security.id, secTask.id, { pass: true, comment: 'Security ok.', reviewedCommit: OTHER_SEC_SHA });
    const afterSec = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'after-sec-pass', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const afterSecRes = await secHeadCall('ask_person', { task: afterSec.number, question: 'Ship after security.', commit: OTHER_SEC_SHA });
    expect(afterSecRes.text).not.toContain('waits for a person');
  });

  it('refuses auto-approval when the commit is not a fast-forward from current origin/main', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.verifyThroughEchelons();
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });
    const { call: headCall } = await f.openTools(f.head);

    /* Diverged / behind origin/main (not fast-forward). */
    f.setFastForward(false);
    const divergedTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Diverged release', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const diverged = await headCall('ask_person', { task: divergedTask.number, question: 'Ship diverged?', commit: CANDIDATE });
    expect(diverged.text).toContain('waits for a person');
    expect((await loadTask(f.db, divergedTask.id)).status).toBe('waiting');

    /* Compare unavailable also falls back to a human card rather than guessing fast-forward. */
    f.setFastForward(true);
    f.setCompareProblem('GitHub compare timed out.');
    const blindTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Blind compare', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const blind = await headCall('ask_person', { task: blindTask.number, question: 'Ship blind?', commit: CANDIDATE });
    expect(blind.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('forbids agents, employee/external words, assistants, delegates and department owners from enabling or disabling autonomous release', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, c.ids.wes));

    /* Non-CEO humans (department owner Dana, CEO delegate Wes, unrelated Sam) cannot toggle it. */
    for (const token of [c.danaToken, c.wholeToken, c.samToken]) {
      const res = await c.app.inject({
        method: 'PUT',
        url: `/api/departments/${c.dev.id}/approval-policy/autonomous-release`,
        payload: { enabled: true },
        ...as(token),
      });
      expect(res.statusCode).toBe(403);
      expect((await c.policy(c.ceoToken, c.dev.id)).json()).toMatchObject({ autonomousRelease: false });
      expect((await c.policy(token === c.samToken ? c.wholeToken : token, c.dev.id)).json()).toMatchObject({
        canSetAutonomousRelease: false,
      });
    }

    /* Someone without department access cannot inspect that department's autonomous release journal. */
    const hiddenDeptJournal = await c.app.inject({
      method: 'GET',
      url: `/api/autonomous-releases?department=${c.dev.id}`,
      ...as(c.samToken),
    });
    expect(hiddenDeptJournal.statusCode).toBe(404);
    const filteredJournal = await c.app.inject({
      method: 'GET',
      url: '/api/autonomous-releases',
      ...as(c.samToken),
    });
    expect(filteredJournal.statusCode).toBe(200);
    expect(filteredJournal.json().entries).toEqual([]);

    /* Orchestrator acting on a turn — EVEN when answering the CEO — is an agent and MUST be refused. */
    const orchDirect = await c.app.inject({
      method: 'PUT',
      url: `/api/departments/${c.dev.id}/approval-policy/autonomous-release`,
      headers: orchestratorHeaders(c.ids.ceo, c.orchestrator.id),
      payload: { enabled: true },
    });
    expect(orchDirect.statusCode).toBe(403);
    expect(orchDirect.json().error.reason).toBe('autonomous_release_ceo_only');

    /* Orchestrator cannot relax the commit channel via set_approval_policy either. */
    const orchTools = await c.tools(c.orchestrator, c.ids.ceo);
    const relaxCommit = (await orchTools.callTool({
      name: 'set_approval_policy',
      arguments: { department: c.dev.id, channel: 'commit', mode: 'new_kinds' },
    })) as ToolRes;
    expect(relaxCommit.isError).toBe(true);
    const relaxRoute = await c.setRule(c.ceoToken, c.dev.id, 'commit', { mode: 'within_limits', limit: 10 });
    expect(relaxRoute.statusCode).toBe(400);

    /* A personal assistant of the CEO (an outside agent) is also refused. */
    const added = await c.app.inject({
      method: 'POST',
      url: '/api/people/assistants',
      payload: { name: 'Ava', owner: c.ids.ceo, program: 'avaclone' },
      ...as(c.ceoToken),
    });
    const assistantId = (added.json() as { person: { id: string } }).person.id;
    const { key: assistantKey } = (
      await c.app.inject({ method: 'POST', url: `/api/people/${assistantId}/key`, ...as(c.ceoToken) })
    ).json() as { key: string };
    const botAttempt = await c.app.inject({
      method: 'PUT',
      url: `/api/departments/${c.dev.id}/approval-policy/autonomous-release`,
      headers: { authorization: `Bearer ${assistantKey}` },
      payload: { enabled: true },
    });
    expect(botAttempt.statusCode).toBeGreaterThanOrEqual(400);

    expect((await c.policy(c.ceoToken, c.dev.id)).json().autonomousRelease).toBe(false);
  });

  it('immediately restores human approval cards when the CEO turns autonomous release off, while preserving journal history', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    const { call: headCall } = await f.openTools(f.head);
    const firstRel = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'First auto release', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const first = await headCall('ask_person', { task: firstRel.number, question: 'Auto ship 1', commit: CANDIDATE });
    expect(first.text).not.toContain('waits for a person');
    expect((await f.journal()).json().entries).toHaveLength(1);

    /* CEO turns autonomous release off. */
    const off = await f.setAutonomous(f.ceoToken, false);
    expect(off.statusCode).toBe(200);
    expect(off.json().autonomousRelease).toBe(false);

    /* Immediately requires a card again, even for the exact same verified commit! */
    const secondRel = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Second release after off', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const second = await headCall('ask_person', { task: secondRel.number, question: 'Ship after off?', commit: CANDIDATE });
    expect(second.text).toContain('waits for a person');
    expect((await loadTask(f.db, secondRel.id)).status).toBe('waiting');

    /* And acceptCandidate on main without a human card is refused again once turned off. */
    f.setMain(CANDIDATE);
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Try after toggle off.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });

    /* Prior journal entry remains visible to people. */
    expect((await f.journal()).json().entries).toHaveLength(1);
  });
});
