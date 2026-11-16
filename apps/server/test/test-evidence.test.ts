import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, requests, subscriptions, taskEvents, tasks, testRuns, turns } from '../src/db/schema.js';
import { answer, ask, createTask, submit, type Task } from '../src/modules/tasks/engine.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { commitProof, proofLine } from '../src/modules/testruns/commit-proof.js';
import { as, connectNode, listen, mcp, setUpCompany, testApp, TEST_COMMIT, until } from './helpers.js';
import { BUILTIN } from './builtin.js';

const NEW_COMMIT = 'b'.repeat(40);
const OLD_COMMIT = 'c'.repeat(40);
const BRANCH = 'task-2-checkout';
const NODE_KEY = 'builtin-node-key-0123456789abcdef';
type Res = { content: { text: string }[]; isError?: boolean };
type Evidence = { run: number; status: string; branch: string | null; command: string; commitSha: string | null; head: string | null; freshness: string; why: string | null; proves: boolean };

/* Development works in a repository in turn 4: Bruno builds the checkout, Rita reviews code. Sales has a repository of its
   own, whose branches may be named the same. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY, NODE_PING_MS: '2147483647' });
  const url = await listen(app);
  const ceoToken = await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [reviewPlan] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Independent review', ownerPersonId: ceo!.id, status: 'ready' }).returning();
  const repo = (name: string) => ({ repoUrl: `https://github.com/acme/${name}.git`, repoTokenEnc: encryptSecret('ghp_shop0123456789', ctx.config.secret), repoTokenLast4: '6789' });
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1, ...repo('shop') },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2, ...repo('crm') },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, subscriptionId = sub!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: subscriptionId === reviewPlan!.id ? 'gpt-6.1-sol' : 'claude-opus-5-5', subscriptionId, skills: ctx.templates.roles.get(roleKey)!.skills.filter(skill => skill.on).map(skill => skill.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV', reviewPlan!.id);
  await hire('Tess', 'worker', 'DEV-TEST');
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  await db.insert(turns).values({ companyId, departmentId: dev!.id, number: 4, title: 'Payments', goal: 'Card payments.', status: 'open', openedAt: new Date() });
  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const member = async (title: string, over: object = {}) =>
    (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: rita.id, ...over })).task;
  const task = await member('Checkout');
  let tokens = 0;
  const turn = async (agent: { id: string }, taskId: string | null = task.id) => {
    const token = `tool-token-${++tokens}-0123456789abcdef0123456789`;
    const [job] = await db
      .insert(jobs)
      .values({ companyId, subscriptionId: sub!.id, agentId: agent.id, taskId, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(Date.now() - 1000), toolTokenHash: hashToken(token) })
      .returning();
    const client = await mcp(app, token);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as Res;
      return { text: res.content[0]!.text, error: res.isError === true };
    };
    return { job: job!, call };
  };
  const { job } = await turn(bruno);
  let numbers = 0;
  /* A test run as it stands once it has ended: on the task's branch and pinned at the test commit, unless it says. */
  const aRun = async (over: Partial<typeof testRuns.$inferInsert> = {}) =>
    (
      await db
        .insert(testRuns)
        .values({ companyId, number: ++numbers, taskId: task.id, agentId: bruno.id, jobId: job.id, departmentId: dev!.id, branch: BRANCH, commitSha: TEST_COMMIT, command: 'make test', timeoutMs: 60_000, status: 'passed', finishedAt: new Date(), ...over })
        .returning()
    )[0]!;
  /* A new commit on every branch of the repository. */
  const branchesAt = (commitSha: string) => {
    ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha });
  };
  /* What an agent reads with the task tool. */
  const read = async (taskId: { number: number } = task) => {
    const { call } = await turn(bruno);
    const { text, error } = await call('task', { task: taskId.number });
    expect(error).toBe(false);
    return JSON.parse(text) as { testEvidence: Evidence[]; requests: { kind: string; commit: string | null; text: string; proof: unknown }[]; log: { kind: string; text: string; data: Record<string, unknown> }[] };
  };
  return { app, ctx, db, url, ceoToken, companyId, ceo: ceo!, dev: dev!, sales: sales!, head, bruno, rita, parent, task, member, turn, aRun, branchesAt, read };
}

describe('the test runs a task shows', () => {
  it('shows a passed run as proof, with the exact commit it pinned, while its branch stands there', async () => {
    const c = await company();
    await c.aRun();
    expect((await c.read()).testEvidence).toEqual([{ run: 1, status: 'passed', branch: BRANCH, command: 'make test', commitSha: TEST_COMMIT, head: TEST_COMMIT, freshness: 'current', why: null, proves: true }]);
  });

  it('marks it stale and no proof once its branch has a new commit', async () => {
    const c = await company();
    await c.aRun();
    c.branchesAt(NEW_COMMIT);
    const [run] = (await c.read()).testEvidence;
    expect(run).toMatchObject({ run: 1, status: 'passed', commitSha: TEST_COMMIT, head: NEW_COMMIT, freshness: 'stale', proves: false });
    expect(run!.why).toContain(NEW_COMMIT);
    expect(run!.why).toContain(TEST_COMMIT);
  });

  it('takes a run that ran on a node at the commit Hornhoof pinned, newest first, and only that one proves the new commit', async () => {
    const c = await company();
    const node = await connectNode(c.url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: { cpus: 8, load: 0.5, memFree: 12 * 1024 ** 3, memTotal: 16 * 1024 ** 3, tests: 0, jobs: 0 }, tests: [] });
    await until(() => c.ctx.hub.loadOf(BUILTIN) !== null);
    const { call } = await c.turn(c.bruno);
    const runOn = async () => {
      expect((await call('run_tests', { command: 'make test', branch: 'release-2' })).error).toBe(false);
      let msg = await node.next();
      while (msg.type !== 'tests.run') msg = await node.next();
      node.send({ type: 'tests.done', partId: msg.partId, ok: true, exitCode: 0, error: null, commit: msg.commitSha!, log: 'ok\n' });
    };
    const ended = (n: number) => until(async () => (await c.db.select().from(testRuns).where(eq(testRuns.status, 'passed'))).length === n);
    await runOn();
    await ended(1);
    c.branchesAt(NEW_COMMIT);
    await runOn();
    await ended(2);
    expect((await c.read()).testEvidence).toMatchObject([
      { run: 2, commitSha: NEW_COMMIT, freshness: 'current', proves: true },
      { run: 1, commitSha: TEST_COMMIT, freshness: 'stale', proves: false },
    ]);
  });

  it('shows the same to a person through the API', async () => {
    const c = await company();
    await c.aRun();
    c.branchesAt(NEW_COMMIT);
    const res = await c.app.inject({ method: 'GET', url: `/api/tasks/${c.task.id}`, ...as(c.ceoToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.testEvidence).toMatchObject([{ run: 1, commitSha: TEST_COMMIT, head: NEW_COMMIT, freshness: 'stale', proves: false }]);
  });

  it.each(['running', 'failed', 'stopped'] as const)('counts a run that is %s as no proof, at its branch as it may be', async status => {
    const c = await company();
    await c.aRun({ status, finishedAt: null });
    expect((await c.read()).testEvidence).toMatchObject([{ status, commitSha: TEST_COMMIT, freshness: 'current', proves: false }]);
  });

  it('cannot tell, says why, and shows the task all the same when the repository cannot be read', async () => {
    const c = await company();
    await c.aRun();
    c.ctx.readCommit = async () => ({ problem: 'The repository did not answer.' });
    expect((await c.read()).testEvidence).toMatchObject([{ commitSha: TEST_COMMIT, head: null, freshness: 'unknown', why: 'The repository did not answer.', proves: false }]);
  });

  it('cannot tell, and shows the task all the same, when the repository has gone or its token cannot be read', async () => {
    const c = await company();
    await c.aRun();
    await c.db.update(departments).set({ repoTokenEnc: 'not a sealed token' }).where(eq(departments.id, c.dev.id));
    const [badToken] = (await c.read()).testEvidence;
    expect(badToken).toMatchObject({ commitSha: TEST_COMMIT, freshness: 'unknown', proves: false });
    expect(badToken!.why).not.toContain('sealed');
    await c.db.update(departments).set({ repoUrl: null, repoTokenEnc: null }).where(eq(departments.id, c.dev.id));
    expect((await c.read()).testEvidence).toMatchObject([{ commitSha: TEST_COMMIT, freshness: 'unknown', why: expect.stringContaining('repository'), proves: false }]);
  });

  it('calls a run from before commits were pinned no proof, and asks the repository nothing', async () => {
    const c = await company();
    await c.aRun({ branch: null, commitSha: null });
    c.ctx.readCommit = () => Promise.reject(new Error('asked'));
    expect((await c.read()).testEvidence).toMatchObject([{ commitSha: null, head: null, freshness: 'unknown', proves: false, why: expect.stringContaining('pinned') }]);
  });

  it('leaves out a run of work', async () => {
    const c = await company();
    await c.aRun({ kind: 'work', commitSha: null });
    expect((await c.read()).testEvidence).toEqual([]);
  });

  it('leaves out the test runs of another task on the same branch name', async () => {
    const c = await company();
    const other = await c.member('Refunds');
    await c.aRun({ taskId: other.id });
    expect((await c.read()).testEvidence).toEqual([]);
  });

  it('asks the repository nothing for a task without runs', async () => {
    const c = await company();
    c.ctx.readCommit = () => Promise.reject(new Error('asked'));
    expect((await c.read()).testEvidence).toEqual([]);
  });

  it('asks the repository once for each branch, and waits for it only a little', async () => {
    const c = await company();
    await c.aRun();
    await c.aRun();
    await c.aRun({ branch: 'task-2-other' });
    const asked: { branch: unknown; ms: unknown }[] = [];
    c.ctx.readCommit = async (_repo, want, ms) => {
      asked.push({ branch: 'branch' in want ? want.branch : null, ms });
      return { branch: 'any', commitSha: TEST_COMMIT };
    };
    const { call } = await c.turn(c.bruno);
    await call('task', { task: c.task.number });
    expect(asked.map(a => a.branch).sort()).toEqual([BRANCH, 'task-2-other']);
    expect(asked.every(a => typeof a.ms === 'number' && a.ms <= 5_000)).toBe(true);
  });

  it('shows the newest runs and a long command cut short, so the answer stays small', async () => {
    const c = await company();
    for (let i = 0; i < 12; i++) await c.aRun({ command: 'x'.repeat(4000) });
    const { testEvidence } = await c.read();
    expect(testEvidence.map(r => r.run)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(testEvidence[0]!.command.length).toBeLessThanOrEqual(300);
  });
});

/* The producer hands its exact candidate to the current mandatory Review owner. */
async function reviewOpen(c: Awaited<ReturnType<typeof company>>): Promise<Task> {
  const moved = await submit(c.ctx, c.bruno.id, c.task.id, { summary: 'Done.', evidence: 'Named total checks.', review: { baseCommit: OLD_COMMIT } });
  expect(moved.task.assigneeAgentId).toBe(c.rita.id);
  return moved.task;
}

describe('a turn has its own branch', () => {
  it('shows the current Review only its own task runs, excluding another task and repository', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    await c.aRun({ branch: 'turn-4', command: 'make all' });
    const other = await c.member('Other review input');
    await c.aRun({ taskId: other.id, branch: 'turn-4', departmentId: c.sales.id, command: 'crm all' });
    await c.aRun({ command: 'make one' });
    c.branchesAt(NEW_COMMIT);
    expect((await c.read(review)).testEvidence).toMatchObject([{ run: 3, command: 'make one', freshness: 'stale', proves: false }, { run: 1, branch: 'turn-4', command: 'make all', commitSha: TEST_COMMIT, head: NEW_COMMIT, freshness: 'stale', proves: false }]);
    c.branchesAt(TEST_COMMIT);
    expect((await c.read(review)).testEvidence).toMatchObject([{ run: 3, freshness: 'current', proves: true }, { run: 1, freshness: 'current', proves: true }]);
  });

  it("shows the department's task of the turn the runs on the turn branch too", async () => {
    const c = await company();
    await c.aRun({ branch: 'turn-4' });
    expect((await c.read(c.parent)).testEvidence).toMatchObject([{ run: 1, branch: 'turn-4', proves: true }]);
  });

  it("shows the department's task of the turn the runs on the turn branch of each repository its products keep too", async () => {
    const c = await company();
    const [app] = await c.db.insert(departments).values({ companyId: c.parent.companyId, name: 'App', roleCode: 'DEV', parentId: c.parent.departmentId, repoUrl: 'https://github.com/acme/app.git' }).returning();
    const other = await c.member('App screens');
    await c.aRun({ branch: 'turn-4', command: 'make all' });
    await c.aRun({ taskId: other.id, branch: 'turn-4', departmentId: app!.id, command: 'app all' });
    await c.aRun({ taskId: other.id, branch: 'turn-4', departmentId: c.sales.id, command: 'crm all' });
    expect((await c.read(c.parent)).testEvidence.map((e: { command: string }) => e.command)).toEqual(['app all', 'make all']);
  });

  it('shows a task of the turn in no department its own runs only, and still shows it', async () => {
    const c = await company();
    await c.db.update(tasks).set({ departmentId: null }).where(eq(tasks.id, c.parent.id));
    await c.aRun({ branch: 'turn-4' });
    await c.aRun({ taskId: c.parent.id, command: 'its own' });
    const res = await c.app.inject({ method: 'GET', url: `/api/tasks/${c.parent.id}`, ...as(c.ceoToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.testEvidence).toMatchObject([{ run: 2, command: 'its own' }]);
  });

  it('keeps a member task to its own runs', async () => {
    const c = await company();
    const other = await c.member('Refunds');
    await c.aRun({ taskId: other.id, branch: 'turn-4' });
    expect((await c.read()).testEvidence).toEqual([]);
  });
});

describe('a reviewer', () => {
  const verdictEvents = (c: Awaited<ReturnType<typeof company>>, taskId: string) =>
    c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'verdict'))).orderBy(asc(taskEvents.createdAt));

  it('is told where each run stands for the current pinned candidate', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    const [rita] = await c.db.select().from(agents).where(eq(agents.id, c.rita.id));
    for (const w of [{ why: 'review' as const }, { why: 'review' as const, text: 'cart.ts:1 is wrong.' }]) {
      const prompt = wakePrompt(rita!, review, { agentId: c.rita.id, taskId: review.id, ...w });
      expect(prompt).toContain('testEvidence');
      expect(prompt).toContain('another commit proves nothing');
    }
  });

  it('keeps the exact commits of the runs a verdict stood on in the log', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    await c.aRun({ branch: 'turn-4' });
    const { call } = await c.turn(c.rita, review.id);
    const given = await call('verdict', { task: review.number, pass: true, reviewedCommit: TEST_COMMIT, comment: 'Good.' });
    expect(given.error).toBe(false);
    expect(given.text).not.toContain('proves nothing');
    const [event] = await verdictEvents(c, review.id);
    expect(event!.data.evidence).toEqual([{ run: 1, status: 'passed', branch: 'turn-4', commitSha: TEST_COMMIT, head: TEST_COMMIT, freshness: 'current', proves: true }]);
  });

  it('hears that a passing verdict rests on no proof when the run is on an older commit, and the log keeps that', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    await c.aRun({ branch: 'turn-4' });
    c.branchesAt(NEW_COMMIT);
    const { call } = await c.turn(c.rita, review.id);
    const given = await call('verdict', { task: review.number, pass: true, reviewedCommit: TEST_COMMIT, comment: 'Good.' });
    expect(given.error).toBe(false);
    expect(given.text).toContain('Test run 1 passed');
    expect(given.text).toContain(TEST_COMMIT);
    expect(given.text).toContain(NEW_COMMIT);
    expect(given.text).toContain('proves nothing');
    const [event] = await verdictEvents(c, review.id);
    expect(event!.data.evidence).toEqual([{ run: 1, status: 'passed', branch: 'turn-4', commitSha: TEST_COMMIT, head: NEW_COMMIT, freshness: 'stale', proves: false }]);
  });

  it('hears nothing of old runs when a newer one proves the branch', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    await c.aRun({ branch: 'turn-4', commitSha: OLD_COMMIT });
    await c.aRun({ branch: 'turn-4' });
    const { call } = await c.turn(c.rita, review.id);
    expect((await call('verdict', { task: review.number, pass: true, reviewedCommit: TEST_COMMIT, comment: 'Good.' })).text).not.toContain('proves nothing');
  });

  it('keeps an unpassed candidate with its current Review owner and records no invented run evidence', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    const { call } = await c.turn(c.rita, review.id);
    expect((await call('verdict', { task: review.number, pass: false, reviewedCommit: TEST_COMMIT, comment: 'cart.ts:1 is wrong.' })).text).not.toContain('proves nothing');
    const [event] = await verdictEvents(c, review.id);
    expect(event!.data).not.toHaveProperty('evidence');
    const [current] = await c.db.select().from(tasks).where(eq(tasks.id, review.id));
    expect(current).toMatchObject({ assigneeAgentId: c.rita.id, executorAgentId: c.bruno.id, status: 'working' });
  });

  it('hears the same of a run from before commits were pinned', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    await c.aRun({ branch: 'turn-4', commitSha: null });
    const { call } = await c.turn(c.rita, review.id);
    const given = await call('verdict', { task: review.number, pass: true, reviewedCommit: TEST_COMMIT, comment: 'Good.' });
    expect(given.text).toContain('Test run 1 passed on no pinned commit');
    expect(given.text).toContain('proves nothing');
  });

  it('says the same as the repository is away, as it cannot be taken for proof', async () => {
    const c = await company();
    const review = await reviewOpen(c);
    await c.aRun({ branch: 'turn-4' });
    c.ctx.readCommit = async () => ({ problem: 'The repository did not answer.' });
    const { call } = await c.turn(c.rita, review.id);
    const given = await call('verdict', { task: review.number, pass: true, reviewedCommit: TEST_COMMIT, comment: 'Good.' });
    expect(given.error).toBe(false);
    expect(given.text).toContain('proves nothing');
    expect(given.text).toContain('The repository did not answer.');
  });
});

describe('an approval of a commit', () => {
  const asked = async (c: Awaited<ReturnType<typeof company>>, commit = TEST_COMMIT) => {
    const { call } = await c.turn(c.bruno);
    const res = await call('ask_person', { task: c.task.number, question: 'Release 0.8.0?', commit });
    expect(res.error).toBe(false);
    const [request] = await c.db.select().from(requests).where(eq(requests.commit, commit));
    return { res, request: request! };
  };

  it('names the passed run of that very commit to the one who asks, the person who decides and the task', async () => {
    const c = await company();
    await c.aRun();
    const { res, request } = await asked(c);
    expect(res.text).toContain('Test run 1 (make test) passed on this commit.');
    expect(request.text).toContain('Release 0.8.0?');
    expect(request.text).toContain('Test run 1 (make test) passed on this commit.');
    const seen = (await c.read()).requests.find(r => r.kind === 'approval')!;
    expect(seen.commit).toBe(TEST_COMMIT);
    expect(seen.proof).toEqual({ commit: TEST_COMMIT, run: 1, command: 'make test', scope: null, failedRun: null, other: null });
  });

  /* A product run as its environment described it: the everyday profile leaves out what only the profiles of a release run. */
  const productRun = (profile: string, kept = 0, candidate = false) => ({
    command: '',
    environmentRequest: { version: 1, repositoryScope: { companyId: c0, repositoryOwnerId: c0, repoUrlHash: 'a'.repeat(64) }, requestId: null, nodeId: null, builtin: false, sentAt: null, attempts: 1, problem: null } as never,
    environmentSnapshot: { profile, ...(candidate ? { candidate: { baseCommit: OLD_COMMIT, baseFingerprints: [], fingerprints: [] } } : {}), description: { manifest: {
      defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['server'] }, { id: 'final', requiredSuiteIds: ['server', 'server-postgres', 'browser'] }, { id: 'full', requiredSuiteIds: ['server', 'server-postgres', 'browser', 'browser-matrix'] }],
      suites: ['server', 'server-postgres', 'browser', 'browser-matrix'].map(id => ({ id })), execution: { version: 2, fullRun: { replaces: 'final', profile: 'full' } } } } } as never,
    fileCache: { mode: kept ? 'cached' : 'full', turn: 4, mainLine: false, fingerprints: [], reused: kept, preparationReused: false, wouldSkip: [], compared: 0, mismatches: [], notes: [] } as never,
  });
  const c0 = '00000000-0000-4000-8000-000000000001';

  it('says what the passed product run of the commit left out, and names a run of every suite anew before a newer narrower one', async () => {
    const c = await company();
    await c.aRun(productRun('fast', 113));
    const { res, request } = await asked(c);
    const narrow = 'Test run 1 passed on this commit with profile fast, which left out the suites server-postgres, browser and browser-matrix, and took the green result of an earlier run for 113 test files instead of running them. Only a run of profile full with no suite and no candidate runs every suite and every test file anew.';
    expect(res.text).toContain(narrow);
    expect(request.text).toContain(narrow);
    await c.aRun(productRun('full'));
    await c.aRun(productRun('final', 4));
    const proof = await commitProof(c.db, c.task, TEST_COMMIT);
    expect(proof).toMatchObject({ run: 2, scope: { profile: 'full', leftOut: [], kept: 0, since: null } });
    expect(proofLine(proof)).toContain('Test run 2 passed on this commit with profile full: every suite and every test file ran anew.');
    expect(proofLine(proof)).not.toContain('()');
  });

  it('says a candidate run checked only what changed since its base', async () => {
    const c = await company();
    await c.aRun(productRun('full', 0, true));
    expect(proofLine(await commitProof(c.db, c.task, TEST_COMMIT))).toContain(`Test run 1 passed on this commit with profile full, which checked only the test files that changed since ${OLD_COMMIT}. Only a run of profile full with no suite and no candidate runs every suite and every test file anew.`);
  });

  it('does not take a run on another commit for proof of this one, and says so', async () => {
    const c = await company();
    await c.aRun();
    const { res, request } = await asked(c, NEW_COMMIT);
    for (const said of [res.text, request.text]) {
      expect(said).toContain('No passed test run checked this commit.');
      expect(said).toContain(`Test run 1 passed on ${TEST_COMMIT}, which proves nothing about this one.`);
    }
    const seen = (await c.read()).requests.find(r => r.kind === 'approval')!;
    expect(seen.proof).toEqual({ commit: NEW_COMMIT, run: null, command: null, scope: null, failedRun: null, other: { run: 1, commitSha: TEST_COMMIT } });
  });

  it('names no run from before commits were pinned as a run on another commit', async () => {
    const c = await company();
    await c.aRun({ branch: null, commitSha: null });
    const { res } = await asked(c, NEW_COMMIT);
    expect(res.text).toContain('No passed test run checked this commit.');
    expect(res.text).not.toContain('proves nothing');
  });

  it('says so when no test run checked it at all', async () => {
    const c = await company();
    const { res } = await asked(c);
    expect(res.text).toContain('No passed test run checked this commit.');
    expect(res.text).not.toContain('proves nothing');
  });

  it('takes no failed, stopped or running run on that commit for proof, and names a failed one', async () => {
    const c = await company();
    await c.aRun({ status: 'failed' });
    await c.aRun({ status: 'stopped' });
    await c.aRun({ status: 'running', finishedAt: null });
    const { res } = await asked(c);
    expect(res.text).toContain('No passed test run checked this commit. Test run 1 failed on it.');
  });

  it('says when a run failed on the very commit another passed on', async () => {
    const c = await company();
    await c.aRun();
    await c.aRun({ status: 'failed' });
    const { res } = await asked(c);
    expect(res.text).toContain('Test run 1 (make test) passed on this commit. Test run 2 failed on it.');
  });

  it('finds the run of that commit on any task: the final check is not the task that asks', async () => {
    const c = await company();
    const finalCheck = await c.member('Final check');
    await c.aRun({ taskId: finalCheck.id, branch: 'turn-4', command: 'npm test' });
    const seen = await asked(c);
    expect(seen.res.text).toContain('Test run 1 (npm test) passed on this commit.');
  });

  it('names another commit only from this task or its department in the turn it goes into', async () => {
    const c = await company();
    const [turn3] = await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 3, title: 'Earlier', goal: 'Earlier.', status: 'closed', openedAt: new Date(), closedAt: new Date(), version: 'v1.0.0' }).returning();
    const earlier = await c.member('Earlier');
    await c.db.update(tasks).set({ turnId: turn3!.id }).where(eq(tasks.id, earlier.id));
    await c.aRun({ taskId: earlier.id, commitSha: OLD_COMMIT });
    const { res } = await asked(c, NEW_COMMIT);
    expect(res.text).toContain('No passed test run checked this commit.');
    expect(res.text).not.toContain(OLD_COMMIT);
    /* A result already accepted into the open turn the task goes into. */
    const sibling = await c.member('Sibling');
    const [open] = await c.db.select().from(turns).where(eq(turns.number, 4));
    await c.db.update(tasks).set({ turnId: open!.id }).where(eq(tasks.id, sibling.id));
    await c.aRun({ taskId: sibling.id, commitSha: TEST_COMMIT });
    expect((await commitProof(c.db, c.task, NEW_COMMIT)).other).toEqual({ run: 2, commitSha: TEST_COMMIT });
  });

  it('takes no run of another company for proof', async () => {
    const c = await company();
    await c.aRun();
    const elsewhere = '00000000-0000-4000-8000-000000000000';
    expect(await commitProof(c.db, { ...c.task, companyId: elsewhere }, TEST_COMMIT)).toEqual({ commit: TEST_COMMIT, run: null, command: null, scope: null, failedRun: null, other: null });
  });

  it('tells the one who releases, as the approval comes, which run proves the approved commit', async () => {
    const c = await company();
    const { request } = await asked(c);
    await c.aRun();
    const approved = await answer(c.ctx, { personId: c.ceo.id }, request.id, { approve: true, answer: 'Go.' });
    const words = approved.wakes.find(w => w.why === 'answered')!.text!;
    expect(words).toContain(`Approved ${TEST_COMMIT}.`);
    expect(words).toContain('Test run 1 (make test) passed on this commit.');
    expect(words).toContain('Go.');
    const [noted] = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'answered')));
    expect(noted!.text).toBe(words);
  });

  it('warns the one who releases when nothing proves the approved commit', async () => {
    const c = await company();
    await c.aRun();
    const { request } = await asked(c, NEW_COMMIT);
    const approved = await answer(c.ctx, { personId: c.ceo.id }, request.id, { approve: true });
    const words = approved.wakes.find(w => w.why === 'answered')!.text!;
    expect(words).toContain(`Approved ${NEW_COMMIT}.`);
    expect(words).toContain('No passed test run checked this commit.');
  });

  it("says nothing of runs on an approval a department's policy asks for, which names no commit", async () => {
    const c = await company();
    await c.aRun();
    const { request } = await ask(c.ctx, c.bruno.id, c.task.id, { kind: 'approval', text: 'Send the welcome email?', approval: { channel: 'message', kind: 'welcome email', amount: null } });
    expect((await c.read()).requests.find(r => r.kind === 'approval')!.proof).toBeNull();
    const approved = await answer(c.ctx, { personId: c.ceo.id }, request.id, { approve: true });
    expect(approved.wakes.find(w => w.why === 'answered')!.text).toBe('Approved message, welcome email.');
  });

  it('says nothing of runs when the commit is declined', async () => {
    const c = await company();
    await c.aRun();
    const { request } = await asked(c);
    const declined = await answer(c.ctx, { personId: c.ceo.id }, request.id, { approve: false, answer: 'Not yet.' });
    expect(declined.wakes.find(w => w.why === 'answered')!.text).toBe(`Declined ${TEST_COMMIT}. Not yet.`);
  });

  it('leaves a plain question as it was asked', async () => {
    const c = await company();
    await c.aRun();
    const { call } = await c.turn(c.bruno);
    const res = await call('ask_person', { task: c.task.number, question: 'Which currency?' });
    expect(res.error).toBe(false);
    expect(res.text).not.toContain('test run');
    const [request] = await c.db.select().from(requests).where(eq(requests.kind, 'question'));
    expect(request!.text).toBe('Which currency?');
    expect((await c.read()).requests[0]).toMatchObject({ kind: 'question', proof: null });
  });
});
