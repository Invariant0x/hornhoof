import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, approvalPolicies, departments, jobs, people, requests, taskEvents, tasks, teams } from '../src/db/schema.js';
import { createTask, loadTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import type { CiAt } from '../src/modules/testruns/github-ci.js';
import { NAME_IT } from '../src/modules/testruns/github-workflow.js';
import { company } from './department-owner-fixture.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { as, listen, mcp } from './helpers.js';

const MAIN_BASE = '1'.repeat(40);
const CANDIDATE = HEAD;
const OTHER_SHA = '9'.repeat(40);

type ToolRes = { content: { type: string; text: string }[]; isError?: boolean };

async function releaseFixture(options: { product?: boolean } = {}) {
  const f = await fixture({ turn: null });
  await listen(f.app);
  /* A product of the department that keeps a repository of its own has no turn: its echelons code tasks integrate to its
     main line straight, each with an approval of its own. We still drive full echelons + MCP tools on the repository. */
  const { app, ctx, db, ceoToken, head, author, reviewer, tester } = f;
  const [ceo] = await db.select().from(people);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const departmentId = head.departmentId!;
  await db.insert(approvalPolicies).values({ companyId: head.companyId, departmentId, channel: 'commit', mode: 'every' });
  /* Without the product, the work is of the department itself, which releases turns: its main approval comes at the release. */
  const [product] = options.product === false ? [] : await db.insert(departments).values({ companyId: head.companyId, name: 'Shop app', parentId: departmentId, roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop-app.git', repoReleaseWorkflow: '.github/workflows/release.yml' }).returning();
  const productId = product?.id ?? null;
  if (productId) await db.update(tasks).set({ productId }).where(eq(tasks.id, f.task.id));

  let mainCommit = MAIN_BASE;
  let branchCommit = CANDIDATE;
  let fastForward = true;
  let compareProblem: string | null = null;
  let capped = false;
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
    /* GitHub listed 300 files of the comparison: it proves the line, never the files. */
    if (capped) return { complete: false, reason: 'too-many-files', lineage: { baseSha: want.base, headSha: want.head, commits: [] } };
    return { complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' };
  };

  /* A running coordination task of the product over the task with the verdict: its parent, the one coordination task that
     may ask for that task's commit besides the task itself. */
  const coordinating = async (title: string, over: { id: string }) => {
    const { task: coordination } = await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId, productId, assigneeAgentId: head.id, resultKind: 'coordination' });
    await db.update(tasks).set({ parentId: coordination.id }).where(eq(tasks.id, over.id));
    return coordination;
  };
  /* An echelons code task of the product, integrating to its main line. */
  const createMainCodeTask = async (changes: Parameters<typeof f.create>[0] = {}) => {
    const created = (await f.create({ small: true, paths: ['logic/totals.ts'], productId, ...changes })).task;
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

  /* What the repository's CI says of each commit, as its host answers the server: a commit nobody set says its checks are still
     under way, so nothing is approved on it. greenCi sets a green answer of four checks, ciSays any other one. As the host's
     reader does, a repository that keeps CI but is asked without its release workflow named says so, and nothing counts. */
  const ciOf = new Map<string, CiAt>();
  const asked: string[] = [];
  ctx.readCi = async (repo, commit) => {
    asked.push(commit);
    const said: CiAt = ciOf.get(commit) ?? { state: 'pending', check: 'test (1)', url: 'https://github.com/acme/shop-app/actions/runs/1', outcome: 'in_progress' };
    return said.state !== 'none' && productId && !repo.releaseWorkflow?.trim() ? { state: 'unnamed', why: NAME_IT } : said;
  };
  const ciSays = (commit: string, said: CiAt) => void ciOf.set(commit, said);
  const greenCi = (commit: string) => ciSays(commit, { state: 'green', checks: 4 });

  /* Advance `task` through Author submit -> independent Reviewer PASS verdict -> Tests verification so it stands ready for main. */
  const verifyThroughEchelons = async () => {
    await submit(ctx, author.id, task.id, { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit: BASE } });
    await verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Independent review passed.', reviewedCommit: CANDIDATE });
    const snap = (await f.detail(task.id)).echelons;
    await report(ctx, tester.id, task.id, {
      done: true,
      summary: 'Candidate verified.',
      verification: { candidateId: snap.candidateId!, revision: snap.revision },
    });
    const ready = (await f.detail(task.id)).echelons;
    return {
      acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: CANDIDATE },
    };
  };

  return {
    ...f,
    ceo: ceo!,
    orchestrator: orchestrator!,
    departmentId,
    productId,
    task,
    openTools,
    coordinating,
    createMainCodeTask,
    setAutonomous,
    policy,
    journal,
    ciSays,
    greenCi,
    asked,
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
    setCapped: (on: boolean) => {
      capped = on;
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
    f.greenCi(CANDIDATE);

    /* Echelons acceptance to main without a human card is refused while off. */
    f.setMain(CANDIDATE);
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Ship without card.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });

    /* ask_person with commit opens a waiting human card while off. */
    f.setMain(MAIN_BASE);
    const releaseTask = (await f.coordinating('Release 0.23.7', f.task));
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
    f.greenCi(CANDIDATE);

    const releaseTask = (await f.coordinating('Release 0.23.7', f.task));
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
    const reqTask = (await f.coordinating('Publish commit', f.task));
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

    /* Company journal shows who requested each auto-approval, the 40-char SHA, base main SHA, what the repository's CI said and the reviewer PASS verdict. */
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
          testRunId: null,
          testRunNumber: null,
          ciState: 'green',
          ciChecks: 4,
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
    f.greenCi(CANDIDATE);

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

  it("refuses auto-approval unless the repository's CI is green on the exact commit: under way, red, nothing succeeded, unread, rate limited, or green on another commit", async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();

    const expectNeedsCard = async (label: string, sha = CANDIDATE) => {
      const { call: headCall } = await f.openTools(f.head);
      const t = (await f.coordinating(label, f.task));
      const res = await headCall('ask_person', { task: t.number, question: `Release (${label})?`, commit: sha });
      expect(res.isError, label).toBe(false);
      expect(res.text, label).toContain('waits for a person');
      expect((await loadTask(f.db, t.id)).status, label).toBe('waiting');
      return (await f.db.select().from(requests).where(eq(requests.taskId, t.id)))[0]!.text;
    };

    /* Its checks are still under way, as a commit nobody says anything of. The card says so, with the link of the check. */
    expect(await expectNeedsCard('under-way')).toContain("The repository's CI has not finished on this commit: test (1) is in_progress (https://github.com/acme/shop-app/actions/runs/1).");

    f.ciSays(CANDIDATE, { state: 'red', check: 'test (2)', url: 'https://github.com/acme/shop-app/actions/runs/1/job/2', outcome: 'failure' });
    expect(await expectNeedsCard('red')).toContain("The repository's CI is red on this commit: check test (2) ended with failure (https://github.com/acme/shop-app/actions/runs/1/job/2).");

    f.ciSays(CANDIDATE, { state: 'idle', checks: 3 });
    expect(await expectNeedsCard('nothing-succeeded')).toContain('none succeeded');

    f.ciSays(CANDIDATE, { state: 'unread', why: 'GitHub answered 502 when reading the checks' });
    expect(await expectNeedsCard('unread')).toContain("The repository's CI could not be read now: GitHub answered 502 when reading the checks.");

    f.ciSays(CANDIDATE, { state: 'limited', limit: { remaining: 0, resetAt: Date.UTC(2026, 10, 24, 14, 10) } });
    expect(await expectNeedsCard('rate-limited')).toContain('request limit is used up until 14:10 UTC');

    /* Green on a different 40-char SHA proves nothing about CANDIDATE, and that SHA is never asked about. */
    f.greenCi(OTHER_SHA);
    await expectNeedsCard('other-sha');
    expect(new Set(f.asked)).toEqual(new Set([CANDIDATE]));

    /* Echelons main acceptance also refuses while it is not green. */
    f.setMain(CANDIDATE);
    await expect(
      report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Not green.', acceptance }).then(() => null),
    ).rejects.toMatchObject({ status: 403 });
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('approves on a repository with no CI, logging that there was none, and refuses acceptance once CI turned red after the approval', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();
    f.ciSays(CANDIDATE, { state: 'none', why: 'no check, no status and no workflow file belongs to this commit' });
    const { call: headCall } = await f.openTools(f.head);
    const asked = await headCall('ask_person', { task: f.task.number, question: 'Integrate ready candidate to main.', commit: CANDIDATE });
    expect(asked.text).not.toContain('waits for a person');
    expect(asked.text).toContain("the repository has no CI");
    expect((await f.journal()).json().entries).toEqual([expect.objectContaining({ commitSha: CANDIDATE, testRunId: null, testRunNumber: null, ciState: 'none', ciChecks: null })]);
    f.setMain(CANDIDATE);
    f.ciSays(CANDIDATE, { state: 'red', check: 'test (2)', url: null, outcome: 'failure' });
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Red now.', acceptance }).then(() => null)).rejects.toMatchObject({ status: 403 });
    f.ciSays(CANDIDATE, { state: 'green', checks: 2 });
    expect((await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Green again.', acceptance })).task.status).toBe('done');
  });

  it('refuses auto-approval when there is no independent non-author PASS verdict on that commit', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    f.greenCi(CANDIDATE);

    const checkRequiresCard = async (title: string) => {
      const { call: turnCall } = await f.openTools(f.head);
      const rel = (await f.coordinating(title, f.task));
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
    f.greenCi(OTHER_SEC_SHA);
    await submit(f.ctx, f.author.id, secTask.id, { summary: 'Auth change.', evidence: 'Checks.', review: { baseCommit: BASE } });
    await verdict(f.ctx, f.reviewer.id, secTask.id, { pass: true, comment: 'Review ok.', reviewedCommit: OTHER_SEC_SHA });
    const beforeSec = (await f.coordinating('missing-sec-pass', secTask));
    const { call: secHeadCall } = await f.openTools(f.head);
    const beforeSecRes = await secHeadCall('ask_person', { task: beforeSec.number, question: 'Ship before security?', commit: OTHER_SEC_SHA });
    expect(beforeSecRes.text).toContain('waits for a person');
    await verdict(f.ctx, f.security.id, secTask.id, { pass: true, comment: 'Security ok.', reviewedCommit: OTHER_SEC_SHA });
    const afterSec = (await f.coordinating('after-sec-pass', secTask));
    const afterSecRes = await secHeadCall('ask_person', { task: afterSec.number, question: 'Ship after security.', commit: OTHER_SEC_SHA });
    expect(afterSecRes.text).not.toContain('waits for a person');
  });

  it('refuses auto-approval when the commit is not a fast-forward from current origin/main', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.verifyThroughEchelons();
    f.greenCi(CANDIDATE);
    const { call: headCall } = await f.openTools(f.head);

    /* Diverged / behind origin/main (not fast-forward). */
    f.setFastForward(false);
    const divergedTask = (await f.coordinating('Diverged release', f.task));
    const diverged = await headCall('ask_person', { task: divergedTask.number, question: 'Ship diverged?', commit: CANDIDATE });
    expect(diverged.text).toContain('waits for a person');
    expect((await loadTask(f.db, divergedTask.id)).status).toBe('waiting');

    /* Compare unavailable also falls back to a human card rather than guessing fast-forward. */
    f.setFastForward(true);
    f.setCompareProblem('GitHub compare timed out.');
    const blindTask = (await f.coordinating('Blind compare', f.task));
    const blind = await headCall('ask_person', { task: blindTask.number, question: 'Ship blind?', commit: CANDIDATE });
    expect(blind.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('auto-approves where main moved by more files than GitHub lists, as the comparisons still prove the base and the fast-forward', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.verifyThroughEchelons();
    f.greenCi(CANDIDATE);
    const { call: headCall } = await f.openTools(f.head);
    f.setCapped(true);
    const releaseTask = (await f.coordinating('Release after a large main', f.task));
    const asked = await headCall('ask_person', { task: releaseTask.number, question: 'Release to main.', commit: CANDIDATE });
    expect(asked.text).not.toContain('waits for a person');
    expect((await f.journal()).json().entries).toHaveLength(1);

    /* A capped comparison of a branch that is no fast-forward still proves nothing. */
    f.setFastForward(false);
    const diverged = (await f.coordinating('Diverged after a large main', f.task));
    expect((await headCall('ask_person', { task: diverged.number, question: 'Ship diverged?', commit: CANDIDATE })).text).toContain('waits for a person');
  });

  it('lets a signed-in person who runs a department turn its own autonomous release on and off, and no other department\'s', async () => {
    const c = await company();
    const toggle = (token: string, departmentId: string, enabled: boolean) =>
      c.app.inject({ method: 'PUT', url: `/api/departments/${departmentId}/approval-policy/autonomous-release`, payload: { enabled }, ...as(token) });

    /* Sam runs Sales without being the CEO: Sales is his to switch, from its own approvals. */
    expect((await c.policy(c.samToken, c.sales.id)).json()).toMatchObject({ autonomousRelease: false, canSetAutonomousRelease: true });
    const on = await toggle(c.samToken, c.sales.id, true);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ autonomousRelease: true, canSetAutonomousRelease: true });
    /* It is Sales' alone: Development keeps its own, off. */
    expect((await c.policy(c.ceoToken, c.dev.id)).json()).toMatchObject({ autonomousRelease: false });
    expect((await c.db.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, c.dev.id)))[0]!.on).toBe(false);

    /* Another department's is not his: Development refuses him, and so does Dana for Sales. */
    expect((await toggle(c.samToken, c.dev.id, true)).statusCode).toBe(403);
    expect((await toggle(c.danaToken, c.sales.id, false)).statusCode).toBe(403);
    expect((await c.policy(c.ceoToken, c.sales.id)).json()).toMatchObject({ autonomousRelease: true });

    /* Dana runs Development and the CEO every department. */
    expect((await toggle(c.danaToken, c.dev.id, true)).json()).toMatchObject({ autonomousRelease: true });
    expect((await toggle(c.ceoToken, c.sales.id, false)).json()).toMatchObject({ autonomousRelease: false });
    expect((await toggle(c.danaToken, c.dev.id, false)).json()).toMatchObject({ autonomousRelease: false });
  });

  it("lets a department's head and the orchestrator change its release policy under the same authority as its commit rule", async () => {
    const c = await company();
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, c.ids.wes));

    /* Sam runs Sales only. */
    for (const token of [c.samToken]) {
      const res = await c.app.inject({
        method: 'PUT',
        url: `/api/departments/${c.dev.id}/approval-policy/autonomous-release`,
        payload: { enabled: true },
        ...as(token),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('autonomous_release_not_allowed');
      expect((await c.policy(c.ceoToken, c.dev.id)).json()).toMatchObject({ autonomousRelease: false });
    }
    expect((await c.policy(c.wholeToken, c.dev.id)).json()).toMatchObject({ canSetAutonomousRelease: true });

    /* Development's head switches the policy for Dana, who runs it. */
    const headDirect = await c.app.inject({
      method: 'PUT',
      url: `/api/departments/${c.dev.id}/approval-policy/autonomous-release`,
      headers: orchestratorHeaders(c.ids.dana, c.head.id),
      payload: { enabled: true },
    });
    expect(headDirect.statusCode).toBe(200);
    expect(headDirect.json()).toMatchObject({ autonomousRelease: true, canSetAutonomousRelease: true });

    const headTools = await c.tools(c.head, c.ids.dana);
    const setRelease = (department: string, enabled: boolean) => headTools.callTool({
      name: 'set_autonomous_release', arguments: { department, enabled },
    }) as Promise<ToolRes>;
    expect((await setRelease(c.sales.id, false)).isError).toBe(true);
    expect((await setRelease(c.dev.id, false)).isError).toBeFalsy();
    expect((await c.policy(c.ceoToken, c.dev.id)).json().autonomousRelease).toBe(false);
    expect((await setRelease(c.dev.id, true)).isError).toBeFalsy();

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

    /* Commit rules are set by the same people as the other rules. */
    const orchTools = await c.tools(c.orchestrator, c.ids.ceo);
    const relaxCommit = (await orchTools.callTool({
      name: 'set_approval_policy',
      arguments: { department: c.dev.id, channel: 'commit', mode: 'new_kinds' },
    })) as ToolRes;
    expect(relaxCommit.isError).toBeFalsy();
    const relaxRoute = await c.setRule(c.ceoToken, c.dev.id, 'commit', { mode: 'within_limits', limit: 10 });
    expect(relaxRoute.statusCode).toBe(200);

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

    expect((await c.policy(c.ceoToken, c.dev.id)).json().autonomousRelease).toBe(true);

    /* The orchestrator acts as the CEO, who runs every department. */
    const orchDirect = await c.app.inject({
      method: 'PUT',
      url: `/api/departments/${c.dev.id}/approval-policy/autonomous-release`,
      headers: orchestratorHeaders(c.ids.ceo, c.orchestrator.id),
      payload: { enabled: true },
    });
    expect(orchDirect.json()).toMatchObject({ autonomousRelease: true, canSetAutonomousRelease: true });
  });

  it('immediately restores human approval cards when the CEO turns autonomous release off, while preserving journal history', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();
    f.greenCi(CANDIDATE);

    const { call: headCall } = await f.openTools(f.head);
    const firstRel = (await f.coordinating('First auto release', f.task));
    const first = await headCall('ask_person', { task: firstRel.number, question: 'Auto ship 1', commit: CANDIDATE });
    expect(first.text).not.toContain('waits for a person');
    expect((await f.journal()).json().entries).toHaveLength(1);

    /* CEO turns autonomous release off. */
    const off = await f.setAutonomous(f.ceoToken, false);
    expect(off.statusCode).toBe(200);
    expect(off.json().autonomousRelease).toBe(false);

    /* Immediately requires a card again, even for the exact same verified commit! */
    const secondRel = (await f.coordinating('Second release after off', f.task));
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
    /* The repository's CI is green; only the verdict's branch stands in the way. */
    net.greenCi(NET_SHA);
    net.setBranchHead('network-1', NET_SHA);
    const { call: netHeadCall } = await net.openTools(net.head);
    const netRel = (await net.coordinating('Try network-1 ship', netTask));
    const netAsked = await netHeadCall('ask_person', { task: netRel.number, question: 'Push network-1 to main?', commit: NET_SHA });
    expect(netAsked.text).toContain('waits for a person');
    expect((await net.journal()).json().entries).toEqual([]);

    /* 2. A feature task of the department itself, whose results join its open turn rather than main, is refused: main moves
       for that department only by the release of its turn. */
    const inTurn = await releaseFixture({ product: false });
    expect((await inTurn.setAutonomous(inTurn.ceoToken, true)).statusCode).toBe(200);
    const FEAT_SHA = '4'.repeat(40);
    inTurn.setBranch(FEAT_SHA);
    const featTask = (await inTurn.create({ small: true, productId: inTurn.productId, title: 'Feature in turn only', paths: ['logic/totals.ts'] })).task;
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
    inTurn.greenCi(FEAT_SHA);
    const { call: turnHeadCall } = await inTurn.openTools(inTurn.head);
    const turnCoord = (await inTurn.coordinating('Turn coord', featTask));
    const featAsked = await turnHeadCall('ask_person', { task: turnCoord.number, question: 'Push unmerged turn feature to main?', commit: FEAT_SHA });
    expect(featAsked.text).toContain('waits for a person');
    expect((await inTurn.journal()).json().entries).toEqual([]);

    /* 3. Repository configured on a non-main branch (repoBranch = network-1) never receives autonomous release. */
    const nonMainRepo = await releaseFixture();
    expect((await nonMainRepo.setAutonomous(nonMainRepo.ceoToken, true)).statusCode).toBe(200);
    await nonMainRepo.verifyThroughEchelons();
    nonMainRepo.greenCi(CANDIDATE);
    await nonMainRepo.db.update(departments).set({ repoBranch: 'network-1' }).where(eq(departments.id, nonMainRepo.productId!));
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
    moved.greenCi(OLD_SHA);

    /* Advance f.task's currentCandidate to NEW_SHA via takeMainAtTests (bringing only main paths). */
    moved.setBranch(NEW_SHA);
    await submit(moved.ctx, moved.tester.id, moved.task.id, {
      summary: 'Merged main into candidate.',
      evidence: 'Checks.',
      review: { baseCommit: MAIN_BASE },
    });
    const { call: movedHeadCall } = await moved.openTools(moved.head);
    const staleAskTask = (await moved.coordinating('Ship superseded SHA?', moved.task));
    const staleAsked = await movedHeadCall('ask_person', { task: staleAskTask.number, question: 'Ship old SHA?', commit: OLD_SHA });
    expect(staleAsked.text).toContain('waits for a person');
    expect((await moved.journal()).json().entries).toEqual([]);

    /* 2. Verified main-bound CANDIDATE exists, but an unrelated non-release task (a worker turnkey task, another code task, or a task in another turn) asks. */
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.verifyThroughEchelons();
    f.greenCi(CANDIDATE);

    /* 2a. Unrelated turnkey worker task (e.g. network-1 fix task) cannot ask for autonomous release of CANDIDATE. */
    const [lane] = await f.db.insert(teams).values({ companyId: f.head.companyId, departmentId: f.departmentId, name: 'Turnkey', turnkey: true }).returning();
    const solo = await f.hire('Solo', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: lane!.id }).where(eq(agents.id, solo.id));
    const turnkeyTask = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'network-1: unrelated fix', brief: '', body: '', departmentId: f.departmentId, productId: f.productId, assigneeAgentId: solo.id, executor: true },
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

    /* 2c. A coordination task of the department itself, outside the product's repository, cannot ask for its candidate. */
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

  it('auto-approves a release candidate of the product on release-X.Y.Z when a coordination task of the product asks', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const REL_SHA = '6'.repeat(40);
    f.setBranchHead('release-0.24.0', REL_SHA);
    const relCodeTask = (await f.create({ small: true, productId: f.productId, title: 'Prepare release 0.24.0', paths: ['logic/totals.ts'] })).task;
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
    f.greenCi(REL_SHA);
    f.setBranchHead('release-0.24.0', REL_SHA);

    const turnCoord = (await f.coordinating('Turn 0.24.0 release', relCodeTask));
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

  it('C1 (a department that releases turns): never auto-approves a commit of the department itself, which reaches main only by the release of its turn', async () => {
    const f = await releaseFixture({ product: false });
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();
    f.greenCi(CANDIDATE);
    const coord = (
      await createTask(
        f.ctx,
        { agentId: f.head.id },
        { title: 'Ship the change', brief: '', body: '', departmentId: f.departmentId, assigneeAgentId: f.head.id, resultKind: 'coordination' },
      )
    ).task;
    const { call: headCall } = await f.openTools(f.head);
    expect((await headCall('ask_person', { task: coord.number, question: 'Push the checked change to main?', commit: CANDIDATE })).text).toContain('waits for a person');
    /* Its head, who holds it after Tests, asking on the task itself. */
    expect((await headCall('ask_person', { task: f.task.number, question: 'Push the checked change to main?', commit: CANDIDATE })).text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
    /* Its result goes into the open turn instead, with no approval of its own. */
    const accepted = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Into the turn.', acceptance });
    expect(accepted.task.turnId).not.toBeNull();
  });

  it('C1 (kinship): only the task with the verdict or a coordination task above it by its parents asks, never another coordination task of the same repository', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    await f.verifyThroughEchelons();
    f.greenCi(CANDIDATE);
    const coordination = (title: string) => createTask(f.ctx, { agentId: f.head.id }, { title, brief: '', body: '', departmentId: f.departmentId, productId: f.productId, assigneeAgentId: f.head.id, resultKind: 'coordination' }).then(made => made.task);
    const { call: headCall } = await f.openTools(f.head);

    /* A running coordination task of the same product, related to the verdict task by nothing, is refused. */
    const stranger = await coordination('Another release');
    expect((await headCall('ask_person', { task: stranger.number, question: 'Ship a commit of a task I do not coordinate?', commit: CANDIDATE })).text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);

    /* One above it by its parents, two levels up, asks for it. */
    const release = await coordination('Release 0.23.7');
    const batch = await coordination('Totals batch');
    await f.db.update(tasks).set({ parentId: release.id }).where(eq(tasks.id, batch.id));
    await f.db.update(tasks).set({ parentId: batch.id }).where(eq(tasks.id, f.task.id));
    const asked = await headCall('ask_person', { task: release.number, question: 'Ship the checked change of the batch.', commit: CANDIDATE });
    expect(asked.text).not.toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([expect.objectContaining({ taskNumber: release.number, commitSha: CANDIDATE })]);
  });

  it('C1 (PASS on another SHA): refuses auto-approval when PASS was given on an ancestor or another commit rather than the asked SHA', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);

    /* 1. PASS was recorded on ANCESTOR_SHA; candidate then advances via takeMainAtTests to DESCENDANT_SHA with green full run_tests on DESCENDANT_SHA.
       Asking for DESCENDANT_SHA must open a human card because reviewedCommit != DESCENDANT_SHA. */
    const ANCESTOR_SHA = 'c'.repeat(40);
    const DESCENDANT_SHA = 'd'.repeat(40);
    f.setBranchHead('release-0.24.1', ANCESTOR_SHA);
    const relTask = (await f.create({ small: true, productId: f.productId, title: 'Release 0.24.1', paths: ['logic/totals.ts'] })).task;
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
    f.greenCi(DESCENDANT_SHA);
    f.setBranchHead('release-0.24.1', DESCENDANT_SHA);

    const { call: testerCall } = await f.openTools(f.tester);
    const onDescendantSelf = await testerCall('ask_person', {
      task: relTask.number,
      question: 'Ship descendant after PASS on ancestor?',
      commit: DESCENDANT_SHA,
    });
    expect(onDescendantSelf.text).toContain('waits for a person');

    const { call: headCall } = await f.openTools(f.head);
    const turnCoord = (await f.coordinating('Coord ask on descendant', relTask));
    const onDescendantCoord = await headCall('ask_person', {
      task: turnCoord.number,
      question: 'Coord ship descendant after PASS on ancestor?',
      commit: DESCENDANT_SHA,
    });
    expect(onDescendantCoord.text).toContain('waits for a person');

    /* 2. Even if an earlier verdict on a candidate had reviewedCommit = EXACT_SHA, a newer verdict on that candidate with another SHA or pass=false invalidates it. */
    const EXACT_SHA = 'e'.repeat(40);
    f.setBranchHead('release-0.24.2', EXACT_SHA);
    const relTask2 = (await f.create({ small: true, productId: f.productId, title: 'Release 0.24.2', paths: ['logic/totals.ts'] })).task;
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
    f.greenCi(EXACT_SHA);
    f.setBranchHead('release-0.24.2', EXACT_SHA);

    const turnCoord2 = (await f.coordinating('Coord ask after superseded verdict', relTask2));
    const supersededAsk = await headCall('ask_person', {
      task: turnCoord2.number,
      question: 'Ship after superseded verdict?',
      commit: EXACT_SHA,
    });
    expect(supersededAsk.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('C1 (base from network-1): refuses auto-approval when review.baseCommit is not an ancestor of origin/main', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);

    /* Graph: MAIN_BASE -> NETWORK_BASE (network-1, ahead of origin/main) -> NET_TURN_SHA.
       NET_TURN_SHA is a fast-forward descendant of MAIN_BASE, with PASS on NET_TURN_SHA
       and a green full run, yet review.baseCommit = NETWORK_BASE is NOT an ancestor of origin/main (MAIN_BASE). */
    const NETWORK_BASE = 'c'.repeat(40);
    const NET_TURN_SHA = 'd'.repeat(40);
    f.setBranchHead('release-0.24.0', NET_TURN_SHA);

    const netTurnTask = (await f.create({ small: true, productId: f.productId, title: 'Branch from network-1 in same turn', paths: ['logic/totals.ts'] })).task;
    expect(netTurnTask.turnId).toBeNull();
    /* A hand-in refuses a base main does not hold: this one was handed in while main still held it, as before that check or
       before main was rewritten, so autonomous release meets it on its own. */
    await submit(f.ctx, f.author.id, netTurnTask.id, {
      summary: 'Built on network-1 base.',
      evidence: 'Checks.',
      review: { baseCommit: NETWORK_BASE, branch: 'release-0.24.0' },
    });
    f.markNonMainBase(NETWORK_BASE, [NET_TURN_SHA]);
    await verdict(f.ctx, f.reviewer.id, netTurnTask.id, {
      pass: true,
      comment: 'Reviewed diff from network-1 only.',
      reviewedCommit: NET_TURN_SHA,
    });
    f.greenCi(NET_TURN_SHA);
    f.setBranchHead('release-0.24.0', NET_TURN_SHA);

    const turnCoord = (await f.coordinating('Same-turn release coord', netTurnTask));
    expect(turnCoord.turnId).toBeNull();

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
    f.setBranch(NET_OUT_SHA);

    const outVerdictTask = await f.createMainCodeTask({ title: 'Out-of-turn task started from network-1', paths: ['logic/totals.ts'] });
    expect(outVerdictTask.turnId).toBeNull();
    /* Handed in while main still held its base, as above. */
    await submit(f.ctx, f.author.id, outVerdictTask.id, {
      summary: 'Network work outside a turn: do not merge to main.',
      evidence: 'Checks.',
      review: { baseCommit: NETWORK_BASE },
    });
    f.markNonMainBase(NETWORK_BASE, [NET_OUT_SHA]);
    await verdict(f.ctx, f.reviewer.id, outVerdictTask.id, {
      pass: true,
      comment: 'Reviewed only against network-1.',
      reviewedCommit: NET_OUT_SHA,
    });
    f.greenCi(NET_OUT_SHA);

    const outRelTask = (await f.coordinating('Out-of-turn release coord', outVerdictTask));
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
    f.greenCi(DESCENDANT_SHA);

    const outRelTask2 = (await f.coordinating('Out-of-turn release coord 2', outMainTask));
    const ancestorAsked = await headCall('ask_person', {
      task: outRelTask2.number,
      question: 'Ship descendant when PASS was on ancestor?',
      commit: DESCENDANT_SHA,
    });
    expect(ancestorAsked.text).toContain('waits for a person');
    expect((await f.journal()).json().entries).toEqual([]);
  });

  it('M3: runs readCommit, readCompare and readCi before the transaction so CEO turn-off never waits on a network request', async () => {
    const f = await releaseFixture();
    expect((await f.setAutonomous(f.ceoToken, true)).statusCode).toBe(200);
    const { acceptance } = await f.verifyThroughEchelons();
    f.greenCi(CANDIDATE);

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
    const realReadCi = f.ctx.readCi!;
    f.ctx.readCi = async (repo, commit, ms) => {
      if (txDepth > 0) callsInsideTx.push('readCi');
      return realReadCi(repo, commit, ms);
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
    f2.greenCi(CANDIDATE);

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
