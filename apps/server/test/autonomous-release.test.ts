import { randomUUID } from 'node:crypto';
import { hashTestEnvironment } from '@hornhoof/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, departments, jobs, people, requests, taskEvents, tasks, teams, testParts, testRuns, turns } from '../src/db/schema.js';
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
  const branchHeads = new Map<string, string>();
  const nonMainBases = new Map<string, Set<string>>();

  ctx.readCommit = async (_repo, ref) => {
    const branch = 'branch' in ref ? ref.branch : `task-${ref.task}`;
    if (branchHeads.has(branch)) return { branch, commitSha: branchHeads.get(branch)! };
    if (branch === 'main') return { branch: 'main', commitSha: mainCommit };
    return { branch, commitSha: branchCommit };
  };
  ctx.readCompare = async (_repo, want) => {
    if (compareProblem) return { complete: false, reason: compareProblem };
    if (nonMainBases.has(want.base) && want.head !== want.base && !nonMainBases.get(want.base)!.has(want.head)) {
      return { complete: false, reason: 'not-an-ancestor' };
    }
    if (want.base === mainCommit && !fastForward) return { complete: false, reason: 'Branch diverged from main.' };
    return { complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' };
  };

  /* Create an echelons code task with turnId = null (integrating to main) by opening an echelons turn, creating the task, then clearing turnId and closing the helper turn. */
  const { echelonsTurn } = await import('./helpers.js');
  const openEchelonsTurn = () => echelonsTurn(db, head.companyId);
  const createMainCodeTask = async (changes: Parameters<typeof f.create>[0] = {}) => {
    const tempTurn = await openEchelonsTurn();
    const created = (await f.create({ small: true, paths: ['logic/totals.ts'], ...changes })).task;
    await db.update(tasks).set({ turnId: null }).where(eq(tasks.id, created.id));
    await db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, tempTurn.id));
    return (await loadTask(db, created.id));
  };
  const task = await createMainCodeTask();

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
    const branch = opts.branch ?? `task-${task.number}`;
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
    openEchelonsTurn,
    createMainCodeTask,
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
    setBranchHead: (branch: string, sha: string | null) => {
      if (sha === null) branchHeads.delete(branch);
      else branchHeads.set(branch, sha);
    },
    setFastForward: (ok: boolean) => {
      fastForward = ok;
    },
    setCompareProblem: (problem: string | null) => {
      compareProblem = problem;
    },
    markNonMainBase: (baseSha: string, descendants: string[] = []) => {
      nonMainBases.set(baseSha, new Set(descendants));
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

    /* Echelons acceptCandidate on main requires pre-push auto-approval on f.task, then succeeds without a human card. */
    const taskAuto = await headCall('ask_person', {
      task: f.task.number,
      question: 'Integrate ready candidate to main.',
      commit: CANDIDATE,
    });
    expect(taskAuto.isError).toBe(false);
    expect(taskAuto.text).not.toContain('waits for a person');
    f.setMain(CANDIDATE);
    const closed = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated under autonomous release.', acceptance });
    expect(closed.task.status).toBe('done');

    /* Company journal shows who requested each auto-approval, the 40-char SHA, base main SHA, run_tests number and reviewer PASS verdict. */
    const entries = (await f.journal()).json().entries;
    const deptEntries = (await f.app.inject({ method: 'GET', url: `/api/autonomous-releases?department=${f.departmentId}`, ...as(f.ceoToken) })).json().entries;
    expect(deptEntries).toEqual(entries);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskNumber: releaseTask.number,
          agentId: f.head.id,
          agentName: f.head.name,
          commitSha: CANDIDATE,
          baseCommitSha: MAIN_BASE,
          testRunId: fullRun.id,
          testRunNumber: fullRun.number,
          reviewerAgentId: f.reviewer.id,
          reviewerName: f.reviewer.name,
          verdictStage: 'review',
        }),
      ]),
    );
  });

  it('refuses main acceptance without a pre-push auto-approval row or after a non-fast-forward overwrite of main', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    /* 1. Skipping ask_person / request_approval before pushing to main cannot record a journal entry retroactively at acceptance. */
    f.setMain(CANDIDATE);
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Pushed without asking first.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });
    expect((await f.journal()).json().entries).toEqual([]);

    /* 2. Force-push / non-fast-forward scenario (B1): before push, C is not fast-forward from main so ask_person opens a card;
       even if main is then overwritten with C, acceptance refuses without human approval and writes no journal row. */
    f.setMain(MAIN_BASE);
    f.setFastForward(false);
    const { call: headCall } = await f.openTools(f.head);
    const beforePush = await headCall('ask_person', {
      task: f.task.number,
      question: 'Ship non-ff candidate?',
      commit: CANDIDATE,
    });
    expect(beforePush.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);

    f.setMain(CANDIDATE);
    await f.db.delete(requests).where(eq(requests.taskId, f.task.id));
    await f.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, f.task.id));
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Try acceptance after overwriting main.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });
    expect((await loadTask(f.db, f.task.id)).status).not.toBe('done');
    expect((await f.journal()).json().entries).toEqual([]);

    /* 3. Even after a valid pre-push auto-approval recorded baseCommitSha = MAIN_BASE, if recorded baseCommitSha is not an ancestor
       of integrationCommit when acceptance checks compare(baseCommitSha...integrationCommit), acceptance is refused. */
    f.setMain(MAIN_BASE);
    f.setFastForward(true);
    const approved = await headCall('ask_person', {
      task: f.task.number,
      question: 'Ship fast-forward candidate.',
      commit: CANDIDATE,
    });
    expect(approved.text).not.toContain('waits for a person');
    expect((await f.journal()).json().entries).toHaveLength(1);
    expect((await f.journal()).json().entries[0]).toMatchObject({ commitSha: CANDIDATE, baseCommitSha: MAIN_BASE });

    f.setMain(CANDIDATE);
    f.setCompareProblem('Recorded base is no longer an ancestor.');
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Broken ancestry.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });

    f.setCompareProblem(null);
    const done = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Verified ancestry.', acceptance });
    expect(done.task.status).toBe('done');
    expect((await f.journal()).json().entries).toHaveLength(1);
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
    const secTask = await f.createMainCodeTask({ riskClass: 'security', paths: ['logic/totals.ts'] });
    await f.runProductSuite({ commit: OTHER_SEC_SHA, branch: `task-${secTask.number}`, profile: 'full' });
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

    /* Orchestrator acting on a turn, EVEN when answering the CEO, is an agent and MUST be refused. */
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

  it('refuses auto-approval when PASS comes from a non-main branch or a turn feature task not integrating into main', async () => {
    /* 1. Candidate reviewed on a non-main branch like network-1 (even outside a turn) never receives auto-approval. */
    const net = await releaseFixture();
    expect((await net.setAutonomous(net.ceoToken, true)).statusCode).toBe(200);
    const NET_SHA = '3'.repeat(40);
    net.setBranchHead('network-1', NET_SHA);
    const netTask = await net.createMainCodeTask({ title: 'network-1 isolation', paths: ['logic/totals.ts'] });
    await submit(net.ctx, net.author.id, netTask.id, {
      summary: 'Network branch work: do not merge to main.',
      evidence: 'Focused checks.',
      review: { baseCommit: BASE, branch: 'network-1' },
    });
    await verdict(net.ctx, net.reviewer.id, netTask.id, {
      pass: true,
      comment: 'Looks good for network-1.',
      reviewedCommit: NET_SHA,
    });
    await net.runProductSuite({ commit: NET_SHA, branch: 'network-1', profile: 'full' });
    net.setBranchHead('network-1', NET_SHA);
    const { call: netHeadCall } = await net.openTools(net.head);
    const netRel = (
      await createTask(
        net.ctx,
        { agentId: net.head.id },
        { title: 'Try network-1 ship', brief: '', body: '', departmentId: net.departmentId, assigneeAgentId: net.head.id, resultKind: 'coordination' },
      )
    ).task;
    const netAsked = await netHeadCall('ask_person', { task: netRel.number, question: 'Push network-1 to main?', commit: NET_SHA });
    expect(netAsked.text).toContain('waits for a person');
    expect((await net.journal()).json().entries).toEqual([]);

    /* 2. Feature task inside an open turn (turnId != null, candidate on task-N integrating to turn-M rather than main) is refused. */
    const inTurn = await releaseFixture();
    expect((await inTurn.setAutonomous(inTurn.ceoToken, true)).statusCode).toBe(200);
    await inTurn.openEchelonsTurn();
    const FEAT_SHA = '4'.repeat(40);
    inTurn.setBranch(FEAT_SHA);
    const featTask = (await inTurn.create({ small: true, title: 'Feature in turn only', paths: ['logic/totals.ts'] })).task;
    await submit(inTurn.ctx, inTurn.author.id, featTask.id, {
      summary: 'Turn feature.',
      evidence: 'Checks.',
      review: { baseCommit: BASE },
    });
    await verdict(inTurn.ctx, inTurn.reviewer.id, featTask.id, {
      pass: true,
      comment: 'Good for turn branch.',
      reviewedCommit: FEAT_SHA,
    });
    await inTurn.runProductSuite({ commit: FEAT_SHA, branch: `task-${featTask.number}`, profile: 'full' });
    const { call: turnHeadCall } = await inTurn.openTools(inTurn.head);
    const turnCoord = (
      await createTask(
        inTurn.ctx,
        { agentId: inTurn.head.id },
        { title: 'Turn coord', brief: '', body: '', departmentId: inTurn.departmentId, assigneeAgentId: inTurn.head.id, resultKind: 'coordination' },
      )
    ).task;
    const featAsked = await turnHeadCall('ask_person', { task: turnCoord.number, question: 'Push unmerged turn feature to main?', commit: FEAT_SHA });
    expect(featAsked.text).toContain('waits for a person');
    expect((await inTurn.journal()).json().entries).toEqual([]);

    /* 3. Repository configured on a non-main branch (repoBranch = network-1) never receives autonomous release. */
    const nonMainRepo = await releaseFixture();
    expect((await nonMainRepo.setAutonomous(nonMainRepo.ceoToken, true)).statusCode).toBe(200);
    await nonMainRepo.verifyThroughEchelons();
    await nonMainRepo.runProductSuite({ commit: CANDIDATE, profile: 'full' });
    await nonMainRepo.db.update(departments).set({ repoBranch: 'network-1' }).where(eq(departments.id, nonMainRepo.departmentId));
    nonMainRepo.setBranchHead('network-1', MAIN_BASE);
    const { call: repoHeadCall } = await nonMainRepo.openTools(nonMainRepo.head);
    const repoAsked = await repoHeadCall('ask_person', { task: nonMainRepo.task.number, question: 'Push to network-1 repo?', commit: CANDIDATE });
    expect(repoAsked.text).toContain('waits for a person');
    expect((await nonMainRepo.journal()).json().entries).toEqual([]);
  });

  it('refuses auto-approval when the candidate moved past the reviewed SHA or an unrelated non-release task asks', async () => {
    /* 1. Candidate moved on from OLD_SHA to NEW_SHA at Tests (takeMainAtTests): asking for superseded OLD_SHA is refused. */
    const moved = await releaseFixture();
    expect((await moved.setAutonomous(moved.ceoToken, true)).statusCode).toBe(200);
    const OLD_SHA = CANDIDATE;
    const NEW_SHA = '5'.repeat(40);
    await submit(moved.ctx, moved.author.id, moved.task.id, { summary: 'Initial.', evidence: 'Checks.', review: { baseCommit: BASE } });
    await verdict(moved.ctx, moved.reviewer.id, moved.task.id, { pass: true, comment: 'Initial ok.', reviewedCommit: OLD_SHA });
    moved.setBranchHead('release-0.23.7', OLD_SHA);
    await moved.runProductSuite({ commit: OLD_SHA, branch: 'release-0.23.7', profile: 'full' });

    /* Advance f.task's currentCandidate to NEW_SHA via takeMainAtTests (bringing only main paths). */
    moved.setBranch(NEW_SHA);
    await submit(moved.ctx, moved.tester.id, moved.task.id, {
      summary: 'Merged main into candidate.',
      evidence: 'Checks.',
      review: { baseCommit: MAIN_BASE },
    });
    const { call: movedHeadCall } = await moved.openTools(moved.head);
    const staleAskTask = (
      await createTask(
        moved.ctx,
        { agentId: moved.head.id },
        { title: 'Ship superseded SHA?', brief: '', body: '', departmentId: moved.departmentId, assigneeAgentId: moved.head.id, resultKind: 'coordination' },
      )
    ).task;
    const staleAsked = await movedHeadCall('ask_person', { task: staleAskTask.number, question: 'Ship old SHA?', commit: OLD_SHA });
    expect(staleAsked.text).toContain('waits for a person');
    expect((await moved.journal()).json().entries).toEqual([]);

    /* 2. Verified main-bound CANDIDATE exists, but an unrelated non-release task (a worker turnkey task, another code task, or a task in another turn) asks. */
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.verifyThroughEchelons();
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    /* 2a. Unrelated turnkey worker task (e.g. network-1 fix task) cannot ask for autonomous release of CANDIDATE. */
    const [lane] = await f.db.insert(teams).values({ companyId: f.head.companyId, departmentId: f.departmentId, name: 'Turnkey', turnkey: true }).returning();
    const solo = await f.hire('Solo', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: lane!.id }).where(eq(agents.id, solo.id));
    const turnkeyTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'network-1: unrelated fix', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: solo.id, executor: true },
      )
    ).task;
    const { call: soloCall } = await f.openTools(solo);
    const soloAsked = await soloCall('ask_person', { task: turnkeyTask.number, question: 'Hijack verified commit?', commit: CANDIDATE });
    expect(soloAsked.text).toContain('waits for a person');

    /* 2b. Unrelated code task cannot ask for autonomous release of f.task's commit. */
    const otherCodeTask = await f.createMainCodeTask({ title: 'Other code work' });
    const { call: authorCall } = await f.openTools(f.author);
    const codeAsked = await authorCall('request_approval', {
      task: otherCodeTask.number,
      channel: 'commit',
      kind: 'main-release',
      text: 'Hijack from another code task?',
      commit: CANDIDATE,
    });
    expect(codeAsked.text).toContain('waits for a person');

    /* 2c. Coordination task inside a different open turn cannot ask for an outside-turn candidate. */
    await f.openEchelonsTurn();
    const otherTurnCoord = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Different turn coord', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const { call: headCall } = await f.openTools(f.head);
    const wrongTurnAsked = await headCall('ask_person', { task: otherTurnCoord.number, question: 'Cross-turn ask?', commit: CANDIDATE });
    expect(wrongTurnAsked.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('auto-approves a turn release candidate on release-X.Y.Z when asked by the release task or its turn coordination task', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.openEchelonsTurn();
    const REL_SHA = '6'.repeat(40);
    f.setBranchHead('release-0.24.0', REL_SHA);
    const relCodeTask = (await f.create({ small: true, title: 'Prepare release 0.24.0', paths: ['logic/totals.ts'] })).task;
    await submit(f.ctx, f.author.id, relCodeTask.id, {
      summary: 'Assemble turn release 0.24.0.',
      evidence: 'Checks.',
      review: { baseCommit: BASE, branch: 'release-0.24.0' },
    });
    await verdict(f.ctx, f.reviewer.id, relCodeTask.id, {
      pass: true,
      comment: 'Release candidate verified.',
      reviewedCommit: REL_SHA,
    });
    await f.runProductSuite({ commit: REL_SHA, branch: 'release-0.24.0', profile: 'full' });
    f.setBranchHead('release-0.24.0', REL_SHA);

    const turnCoord = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Turn 0.24.0 release', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const { call: headCall } = await f.openTools(f.head);
    const coordAsked = await headCall('ask_person', { task: turnCoord.number, question: 'Publish 0.24.0 to main.', commit: REL_SHA });
    expect(coordAsked.isError).toBe(false);
    expect(coordAsked.text).not.toContain('waits for a person');
    expect((await f.journal()).json().entries).toHaveLength(1);
    expect((await f.journal()).json().entries[0]).toMatchObject({
      taskNumber: turnCoord.number,
      commitSha: REL_SHA,
      baseCommitSha: MAIN_BASE,
    });
  });

  it('C1 (wrong turn): refuses auto-approval when the PASS verdict comes from another turn', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const outCoord = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Outside turn coord', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;

    const turn1 = await f.openEchelonsTurn();
    const TURN1_SHA = '8'.repeat(40);
    f.setBranchHead('release-0.24.0', TURN1_SHA);
    const relTask1 = (await f.create({ small: true, title: 'Turn 1 release', paths: ['logic/totals.ts'] })).task;
    await submit(f.ctx, f.author.id, relTask1.id, {
      summary: 'Turn 1 release candidate.',
      evidence: 'Checks.',
      review: { baseCommit: MAIN_BASE, branch: 'release-0.24.0' },
    });
    await verdict(f.ctx, f.reviewer.id, relTask1.id, {
      pass: true,
      comment: 'Turn 1 verified.',
      reviewedCommit: TURN1_SHA,
    });
    await f.runProductSuite({ commit: TURN1_SHA, branch: 'release-0.24.0', profile: 'full' });
    f.setBranchHead('release-0.24.0', TURN1_SHA);

    const { call: headCall } = await f.openTools(f.head);
    /* Out-of-turn task (turnId = null) asking while Turn 1 is open is refused. */
    const outAsked = await headCall('ask_person', { task: outCoord.number, question: 'Out-of-turn ask for Turn 1 SHA?', commit: TURN1_SHA });
    expect(outAsked.text).toContain('waits for a person');

    /* Close Turn 1 and open Turn 2: Turn 2 coordination task (turn2.id != turn1.id) asking for Turn 1 SHA is refused. */
    await f.db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, turn1.id));
    const turn2 = await f.openEchelonsTurn();
    expect(turn2.id).not.toBe(turn1.id);
    const turn2Coord = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Turn 2 coord', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const turn2Asked = await headCall('ask_person', { task: turn2Coord.number, question: 'Turn 2 ask for Turn 1 SHA?', commit: TURN1_SHA });
    expect(turn2Asked.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('C1 (PASS on another SHA): refuses auto-approval when PASS was given on an ancestor or another commit rather than the asked SHA', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.openEchelonsTurn();

    /* 1. PASS was recorded on ANCESTOR_SHA; candidate then advances via takeMainAtTests to DESCENDANT_SHA with green full run_tests on DESCENDANT_SHA.
       Asking for DESCENDANT_SHA must open a human card because reviewedCommit != DESCENDANT_SHA. */
    const ANCESTOR_SHA = 'c'.repeat(40);
    const DESCENDANT_SHA = 'd'.repeat(40);
    f.setBranchHead('release-0.24.1', ANCESTOR_SHA);
    const relTask = (await f.create({ small: true, title: 'Release 0.24.1', paths: ['logic/totals.ts'] })).task;
    await submit(f.ctx, f.author.id, relTask.id, {
      summary: 'Initial release candidate.',
      evidence: 'Checks.',
      review: { baseCommit: BASE, branch: 'release-0.24.1' },
    });
    await verdict(f.ctx, f.reviewer.id, relTask.id, {
      pass: true,
      comment: 'Verified ancestor commit.',
      reviewedCommit: ANCESTOR_SHA,
    });

    f.setBranchHead('release-0.24.1', DESCENDANT_SHA);
    await submit(f.ctx, f.tester.id, relTask.id, {
      summary: 'Took main into release-0.24.1.',
      evidence: 'Checks.',
      review: { baseCommit: MAIN_BASE, branch: 'release-0.24.1' },
    });
    await f.runProductSuite({ commit: DESCENDANT_SHA, branch: 'release-0.24.1', profile: 'full' });
    f.setBranchHead('release-0.24.1', DESCENDANT_SHA);

    const { call: testerCall } = await f.openTools(f.tester);
    const onDescendantSelf = await testerCall('ask_person', {
      task: relTask.number,
      question: 'Ship descendant after PASS on ancestor?',
      commit: DESCENDANT_SHA,
    });
    expect(onDescendantSelf.text).toContain('waits for a person');

    const { call: headCall } = await f.openTools(f.head);
    const turnCoord = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Coord ask on descendant', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const onDescendantCoord = await headCall('ask_person', {
      task: turnCoord.number,
      question: 'Coord ship descendant after PASS on ancestor?',
      commit: DESCENDANT_SHA,
    });
    expect(onDescendantCoord.text).toContain('waits for a person');

    /* 2. Even if an earlier verdict on a candidate had reviewedCommit = EXACT_SHA, a newer verdict on that candidate with another SHA or pass=false invalidates it. */
    const EXACT_SHA = 'e'.repeat(40);
    f.setBranchHead('release-0.24.2', EXACT_SHA);
    const relTask2 = (await f.create({ small: true, title: 'Release 0.24.2', paths: ['logic/totals.ts'] })).task;
    await submit(f.ctx, f.author.id, relTask2.id, {
      summary: 'Candidate 0.24.2.',
      evidence: 'Checks.',
      review: { baseCommit: MAIN_BASE, branch: 'release-0.24.2' },
    });
    await verdict(f.ctx, f.reviewer.id, relTask2.id, {
      pass: true,
      comment: 'Initial PASS.',
      reviewedCommit: EXACT_SHA,
    });
    const candId = (await f.detail(relTask2.id)).echelons.candidateId!;
    await f.db.insert(taskEvents).values({
      companyId: f.head.companyId,
      taskId: relTask2.id,
      agentId: f.reviewer.id,
      kind: 'verdict',
      text: 'Superseded by FAIL referencing ancestor.',
      data: { pass: false, stage: 'review', candidateId: candId, reviewedCommit: ANCESTOR_SHA },
    });
    await f.runProductSuite({ commit: EXACT_SHA, branch: 'release-0.24.2', profile: 'full' });
    f.setBranchHead('release-0.24.2', EXACT_SHA);

    const turnCoord2 = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Coord ask after superseded verdict', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const supersededAsk = await headCall('ask_person', {
      task: turnCoord2.number,
      question: 'Ship after superseded verdict?',
      commit: EXACT_SHA,
    });
    expect(supersededAsk.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('C1 (base from network-1): refuses auto-approval in the same turn when review.baseCommit is not an ancestor of origin/main', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const turn = await f.openEchelonsTurn();

    /* Graph: MAIN_BASE -> NETWORK_BASE (network-1, ahead of origin/main) -> NET_TURN_SHA.
       NET_TURN_SHA is a fast-forward descendant of MAIN_BASE and is in the same open turn, with PASS on NET_TURN_SHA
       and a green full run, yet review.baseCommit = NETWORK_BASE is NOT an ancestor of origin/main (MAIN_BASE). */
    const NETWORK_BASE = 'c'.repeat(40);
    const NET_TURN_SHA = 'd'.repeat(40);
    f.markNonMainBase(NETWORK_BASE, [NET_TURN_SHA]);
    f.setBranchHead('release-0.24.0', NET_TURN_SHA);

    const netTurnTask = (await f.create({ small: true, title: 'Branch from network-1 in same turn', paths: ['logic/totals.ts'] })).task;
    expect(netTurnTask.turnId).toBe(turn.id);
    await submit(f.ctx, f.author.id, netTurnTask.id, {
      summary: 'Built on network-1 base.',
      evidence: 'Checks.',
      review: { baseCommit: NETWORK_BASE, branch: 'release-0.24.0' },
    });
    await verdict(f.ctx, f.reviewer.id, netTurnTask.id, {
      pass: true,
      comment: 'Reviewed diff from network-1 only.',
      reviewedCommit: NET_TURN_SHA,
    });
    await f.runProductSuite({ commit: NET_TURN_SHA, branch: 'release-0.24.0', profile: 'full' });
    f.setBranchHead('release-0.24.0', NET_TURN_SHA);

    const turnCoord = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Same-turn release coord', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    expect(turnCoord.turnId).toBe(turn.id);

    const { call: headCall } = await f.openTools(f.head);
    const coordAsked = await headCall('ask_person', {
      task: turnCoord.number,
      question: 'Ship branch based on network-1 in same turn?',
      commit: NET_TURN_SHA,
    });
    expect(coordAsked.text).toContain('waits for a person');

    const { call: testerCall } = await f.openTools(f.tester);
    const selfAsked = await testerCall('ask_person', {
      task: netTurnTask.number,
      question: 'Ship own task based on network-1?',
      commit: NET_TURN_SHA,
    });
    expect(selfAsked.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('C1 (both outside a turn): refuses auto-approval when both turnIds are null unless PASS is on the asked SHA and review.baseCommit is an ancestor of origin/main', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);

    /* 1. Both outVerdictTask and outRelTask have turnId === null, PASS is on NET_OUT_SHA and full run_tests is green on NET_OUT_SHA,
       and NET_OUT_SHA is fast-forward from MAIN_BASE, while review.baseCommit = NETWORK_BASE (from network-1) is NOT an ancestor of origin/main. */
    const NETWORK_BASE = '3'.repeat(40);
    const NET_OUT_SHA = '5'.repeat(40);
    f.markNonMainBase(NETWORK_BASE, [NET_OUT_SHA]);
    f.setBranch(NET_OUT_SHA);

    const outVerdictTask = await f.createMainCodeTask({ title: 'Out-of-turn task started from network-1', paths: ['logic/totals.ts'] });
    expect(outVerdictTask.turnId).toBeNull();
    await submit(f.ctx, f.author.id, outVerdictTask.id, {
      summary: 'Network work outside a turn: do not merge to main.',
      evidence: 'Checks.',
      review: { baseCommit: NETWORK_BASE },
    });
    await verdict(f.ctx, f.reviewer.id, outVerdictTask.id, {
      pass: true,
      comment: 'Reviewed only against network-1.',
      reviewedCommit: NET_OUT_SHA,
    });
    await f.runProductSuite({ commit: NET_OUT_SHA, branch: `task-${outVerdictTask.number}`, profile: 'full' });

    const outRelTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Out-of-turn release coord', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    expect(outRelTask.turnId).toBeNull();

    const { call: headCall } = await f.openTools(f.head);
    const coordAsked = await headCall('ask_person', {
      task: outRelTask.number,
      question: 'Ship out-of-turn network-based commit from coord?',
      commit: NET_OUT_SHA,
    });
    expect(coordAsked.text).toContain('waits for a person');

    const { call: testerCall } = await f.openTools(f.tester);
    const selfAsked = await testerCall('ask_person', {
      task: outVerdictTask.number,
      question: 'Ship out-of-turn network-based commit from task?',
      commit: NET_OUT_SHA,
    });
    expect(selfAsked.text).toContain('waits for a person');

    /* 2. Both turnIds are null and review.baseCommit IS on main, while PASS was only on ANCESTOR_SHA before takeMainAtTests to DESCENDANT_SHA: refused. */
    const ANCESTOR_SHA = 'e'.repeat(40);
    const DESCENDANT_SHA = 'f'.repeat(40);
    f.setBranch(ANCESTOR_SHA);
    const outMainTask = await f.createMainCodeTask({ title: 'Out-of-turn main task', paths: ['logic/totals.ts'] });
    await submit(f.ctx, f.author.id, outMainTask.id, {
      summary: 'Main-line work.',
      evidence: 'Checks.',
      review: { baseCommit: BASE },
    });
    await verdict(f.ctx, f.reviewer.id, outMainTask.id, {
      pass: true,
      comment: 'PASS on ancestor.',
      reviewedCommit: ANCESTOR_SHA,
    });
    f.setBranch(DESCENDANT_SHA);
    await submit(f.ctx, f.tester.id, outMainTask.id, {
      summary: 'Merged main at Tests.',
      evidence: 'Checks.',
      review: { baseCommit: MAIN_BASE },
    });
    await f.runProductSuite({ commit: DESCENDANT_SHA, branch: `task-${outMainTask.number}`, profile: 'full' });

    const outRelTask2 = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Out-of-turn release coord 2', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const ancestorAsked = await headCall('ask_person', {
      task: outRelTask2.number,
      question: 'Ship descendant when PASS was on ancestor?',
      commit: DESCENDANT_SHA,
    });
    expect(ancestorAsked.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('M3: runs readCommit and readCompare before the transaction so CEO turn-off never waits on a network request', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();
    await f.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    let txDepth = 0;
    const realTransaction = f.ctx.db.transaction.bind(f.ctx.db);
    f.ctx.db.transaction = (async <T>(
      fn: Parameters<typeof f.ctx.db.transaction>[0],
      config?: Parameters<typeof f.ctx.db.transaction>[1],
    ): Promise<T> => {
      txDepth += 1;
      try {
        return (await realTransaction(fn, config)) as T;
      } finally {
        txDepth -= 1;
      }
    }) as typeof f.ctx.db.transaction;

    const callsInsideTx: string[] = [];
    const realReadCommit = f.ctx.readCommit;
    const realReadCompare = f.ctx.readCompare!;
    f.ctx.readCommit = async (repo, ref, ms) => {
      if (txDepth > 0) callsInsideTx.push('readCommit');
      return realReadCommit(repo, ref, ms);
    };
    f.ctx.readCompare = async (repo, want, ms) => {
      if (txDepth > 0) callsInsideTx.push(`readCompare:${want.base.slice(0, 6)}..${want.head.slice(0, 6)}`);
      return realReadCompare(repo, want, ms);
    };

    const { call: headCall } = await f.openTools(f.head);
    const approved = await headCall('ask_person', { task: f.task.number, question: 'Publish verified commit.', commit: CANDIDATE });
    expect(approved.isError).toBe(false);
    expect(approved.text).not.toContain('waits for a person');
    expect(callsInsideTx).toEqual([]);

    f.setMain(CANDIDATE);
    const closed = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated.', acceptance });
    expect(closed.task.status).toBe('done');
    expect(callsInsideTx).toEqual([]);

    /* Behavioral check: while readCompare is suspended mid-flight, CEO turning autonomous release off completes without waiting. */
    const f2 = await releaseFixture();
    expect((await f2.setAutonomous(f2.ceoToken, true)).statusCode).toBe(200);
    await f2.verifyThroughEchelons();
    await f2.runProductSuite({ commit: CANDIDATE, profile: 'full' });

    let notifyCompareStarted: (() => void) | null = null;
    const compareStarted = new Promise<void>(resolve => {
      notifyCompareStarted = resolve;
    });
    let releaseCompare: (() => void) | null = null;
    const compareGate = new Promise<void>(resolve => {
      releaseCompare = resolve;
    });
    let compareResolved = false;
    const baseReadCompare = f2.ctx.readCompare!;
    f2.ctx.readCompare = async (repo, want, ms) => {
      notifyCompareStarted?.();
      await compareGate;
      compareResolved = true;
      return baseReadCompare(repo, want, ms);
    };

    const { call: headCall2 } = await f2.openTools(f2.head);
    const pendingAsk = headCall2('ask_person', { task: f2.task.number, question: 'Ship while CEO disables?', commit: CANDIDATE });
    await compareStarted;

    const offWhileComparing = await f2.setAutonomous(f2.ceoToken, false);
    expect(compareResolved).toBe(false);
    expect(offWhileComparing.statusCode).toBe(200);
    expect(offWhileComparing.json().autonomousRelease).toBe(false);

    releaseCompare!();
    const askedAfterOff = await pendingAsk;
    expect(askedAfterOff.text).toContain('waits for a person');
    expect((await f2.journal()).json().entries).toEqual([]);
  });
});
