import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks, testParts, testRuns } from '../src/db/schema.js';
import { agentRole, grantsFor } from '../src/db/agent-sql.js';
import { cancel, createTask } from '../src/modules/tasks/engine.js';
import { markCommit, type TestsMark } from '../src/modules/testruns/github-status.js';
import { checkTestTimes } from '../src/modules/testruns/runs.js';
import { as, connectNode, createTestDb, listen, mcp, setUpCompany, testApp, TEST_COMMIT, until, type FakeNode } from './helpers.js';
import { listenIn } from '../../../test-support/ports.mjs';
import { BUILTIN } from './builtin.js';

const FULL = 'npm test';
const MOVED = 'b'.repeat(40);
const NODE_KEY = 'builtin-node-key-0123456789abcdef';
const KEY = 'ghp_shop0123456789';
const load = { cpus: 8, load: 0.5, memFree: 12 * 1024 ** 3, memTotal: 16 * 1024 ** 3, tests: 0, jobs: 0 };
type Res = { content: { text: string }[]; isError?: boolean };

/* Development declared its repository's full test command, unless the test says otherwise, and Bruno works on a task
   there. The built-in node takes the parts. */
async function company({ full = FULL as string | null, env = {} as NodeJS.ProcessEnv } = {}) {
  /* No ping comes in a test, so no stand-in node is dropped for a pong that came late on a busy machine. */
  const { app, db } = await testApp({ NODE_KEY, NODE_PING_MS: '2147483647', ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [person] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db
    .insert(departments)
    .values({ companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/shop.git', repoTokenEnc: encryptSecret(KEY, ctx.config.secret), repoTokenLast4: '6789', repoFullTestCommand: full })
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const task = (await createTask(ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true })).task;
  const marks: { url: string; token: string; commit: string; mark: TestsMark }[] = [];
  let answer: Awaited<ReturnType<typeof ctx.markCommit>> = { ok: true };
  ctx.markCommit = async (repo, commit, mark) => {
    marks.push({ url: repo.url, token: repo.token, commit, mark });
    return answer;
  };
  const answers = (next: typeof answer) => {
    answer = next;
  };
  let tokens = 0;
  const tools = async () => {
    const token = `tool-token-${++tokens}-0123456789abcdef0123456789`;
    await db
      .insert(jobs)
      .values({ companyId, subscriptionId: sub!.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(Date.now() - 1000), toolTokenHash: hashToken(token) });
    const client = await mcp(app, token);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as Res;
      return { text: res.content[0]!.text, error: res.isError === true };
    };
  };
  let node: FakeNode | null = null;
  const online = async () => {
    if (node) return node;
    node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load, tests: [], work: true });
    await until(() => ctx.hub.loadOf(BUILTIN) !== null);
    return node;
  };
  const nextPart = async () => {
    const taking = await online();
    let msg = await taking.next();
    while (msg.type !== 'tests.run') msg = await taking.next();
    return msg;
  };
  const passes = (part: { partId: string; commitSha?: string | null }) =>
    node!.send({ type: 'tests.done', partId: part.partId, ok: true, exitCode: 0, error: null, commit: part.commitSha ?? null, log: 'ok\n' });
  const fails = (part: { partId: string; commitSha?: string | null }) =>
    node!.send({ type: 'tests.done', partId: part.partId, ok: false, exitCode: 1, error: 'failed', commit: part.commitSha ?? null, log: 'FAIL cart.test.ts\n' });
  const runRow = async () => (await db.select().from(testRuns).orderBy(asc(testRuns.number))).at(-1)!;
  const ended = () => until(async () => (await runRow()).status !== 'running');
  /* What the agent was told, turn by turn, on the task. */
  const told = async () => (await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), eq(jobs.taskId, task.id), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt))).map(j => j.prompt);
  const logLines = async () => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'comment'))).orderBy(asc(taskEvents.id))).map(e => ({ text: e.text, data: e.data }));
  return { app, ctx, db, url, ceo, person: person!, companyId, sub: sub!, dev: dev!, head, bruno, task, marks, answers, tools, online, nextPart, passes, fails, runRow, ended, told, logLines };
}

/* A run of the command through run_tests, up to its part going out. */
async function started(c: Awaited<ReturnType<typeof company>>, command = FULL, over: object = {}) {
  await c.online();
  const call = await c.tools();
  const went = await call('run_tests', { command, branch: 'release-checkout', ...over });
  expect(went.error).toBe(false);
  return call;
}

describe('the mark a full test run leaves on the commit it checked', () => {
  it('sets hornhoof/tests to success with the repository key, on the pinned commit, once the run passed', async () => {
    const c = await company();
    await started(c);
    c.passes(await c.nextPart());
    await c.ended();
    expect(c.marks).toEqual([{ url: 'https://github.com/acme/shop.git', token: KEY, commit: TEST_COMMIT, mark: { state: 'success', description: 'Test run 1 passed in Hornhoof.', targetUrl: null } }]);
    expect((await c.runRow()).status).toBe('passed');
    const [prompt] = await c.told();
    expect(prompt).toContain(`hornhoof/tests = success on ${TEST_COMMIT}`);
  });

  it('sets it to failure when the run failed', async () => {
    const c = await company();
    await started(c);
    c.fails(await c.nextPart());
    await c.ended();
    expect(c.marks.map(m => [m.commit, m.mark.state, m.mark.description])).toEqual([[TEST_COMMIT, 'failure', 'Test run 1 failed in Hornhoof.']]);
    expect((await c.told())[0]).toContain(`hornhoof/tests = failure on ${TEST_COMMIT}`);
  });

  it('links the task when Hornhoof is at an https address', async () => {
    const c = await company({ env: { PUBLIC_URL: 'https://hornhoof.acme.dev' } });
    await started(c);
    c.passes(await c.nextPart());
    await c.ended();
    expect(c.marks[0]!.mark.targetUrl).toBe(`https://hornhoof.acme.dev/tasks/${c.task.id}`);
  });

  it('keeps what it set in the log of the task', async () => {
    const c = await company();
    await started(c);
    c.passes(await c.nextPart());
    await c.ended();
    const line = (await c.logLines()).find(l => l.data.testsMark);
    expect(line!.data.testsMark).toEqual({ run: 1, commit: TEST_COMMIT, state: 'success', set: true });
    expect(line!.text).toContain(`hornhoof/tests = success on ${TEST_COMMIT}`);
  });

  it.each([
    ['one file', 'npm test -- cart.test.ts'],
    ['a selection', 'npx vitest run --changed'],
    ['another command', 'npm run lint'],
    ['the same words in another form', 'npm  test'],
    ['another case', 'NPM TEST'],
  ])('leaves no mark for a run of %s', async (_what, command) => {
    const c = await company();
    await started(c, command);
    c.passes(await c.nextPart());
    await c.ended();
    expect(c.marks).toEqual([]);
    expect((await c.runRow()).status).toBe('passed');
    expect((await c.told())[0]).not.toContain('hornhoof/tests');
    expect((await c.logLines()).filter(l => l.data.testsMark)).toEqual([]);
  });

  it('leaves no mark while the repository declares no full command', async () => {
    const c = await company({ full: null });
    await started(c);
    c.passes(await c.nextPart());
    await c.ended();
    expect(c.marks).toEqual([]);
  });

  it('leaves no mark for a run of work, whatever it runs', async () => {
    const c = await company();
    await c.online();
    const call = await c.tools();
    expect((await call('run_work', { command: FULL, branch: 'main' })).error).toBe(false);
    c.passes(await c.nextPart());
    await c.ended();
    expect(c.marks).toEqual([]);
  });

  it('leaves no mark for a run that was stopped', async () => {
    const c = await company();
    const call = await started(c);
    await c.nextPart();
    expect((await call('stop_tests', { run: 1 })).error).toBe(false);
    expect((await c.runRow()).status).toBe('stopped');
    expect(c.marks).toEqual([]);
  });

  it('leaves no mark for a run from before commits were pinned, as nothing says what it checked', async () => {
    const c = await company();
    const [job] = await c.db.select().from(jobs).limit(1);
    const worked = job ?? (await c.tools(), (await c.db.select().from(jobs).limit(1))[0]!);
    const [run] = await c.db
      .insert(testRuns)
      .values({ companyId: c.companyId, number: 1, taskId: c.task.id, agentId: c.bruno.id, jobId: worked.id, departmentId: c.dev.id, branch: null, commitSha: null, command: FULL, timeoutMs: 60_000 })
      .returning();
    await c.db.insert(testParts).values({ companyId: c.companyId, runId: run!.id, part: 1, queuedAt: new Date(0) });
    await checkTestTimes(c.ctx);
    expect((await c.runRow()).status).toBe('failed');
    expect(c.marks).toEqual([]);
  });

  it('marks the pinned commit even when the branch moved during the run', async () => {
    const c = await company();
    await started(c);
    const part = await c.nextPart();
    expect(part.commitSha).toBe(TEST_COMMIT);
    const reads: unknown[] = [];
    c.ctx.readCommit = async (_repo, want) => {
      reads.push(want);
      return { branch: 'release-checkout', commitSha: MOVED };
    };
    c.passes(part);
    await c.ended();
    expect(c.marks.map(m => m.commit)).toEqual([TEST_COMMIT]);
    expect(reads).toEqual([]);
  });

  it('marks once, after the last part, when the full command is split into parts', async () => {
    const split = 'npx vitest run --shard={part}/{parts}';
    const c = await company({ full: split });
    await started(c, split, { parts: 2 });
    /* One machine takes one part at a time, so the second goes out once the first has ended. */
    c.passes(await c.nextPart());
    const second = await c.nextPart();
    expect(c.marks).toEqual([]);
    c.passes(second);
    await c.ended();
    expect(c.marks.map(m => m.mark.state)).toEqual(['success']);
    expect(await c.told()).toHaveLength(1);
  });

  it('marks failure when one part of many failed', async () => {
    const split = 'npx vitest run --shard={part}/{parts}';
    const c = await company({ full: split });
    await started(c, split, { parts: 2 });
    c.passes(await c.nextPart());
    c.fails(await c.nextPart());
    await c.ended();
    expect(c.marks.map(m => m.mark.state)).toEqual(['failure']);
  });

  it("uses a product's own command and key when the run clones the product's repository", async () => {
    const c = await company();
    const [product] = await c.db
      .insert(departments)
      .values({ companyId: c.companyId, parentId: c.dev.id, name: 'Mascot', roleCode: 'DEV', repoUrl: 'https://github.com/acme/mascot.git', repoTokenEnc: encryptSecret('ghp_mascot', c.ctx.config.secret), repoFullTestCommand: 'make all' })
      .returning();
    await c.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, c.task.id));
    /* The department's full command is not the product's. */
    await started(c, FULL);
    c.passes(await c.nextPart());
    await c.ended();
    expect(c.marks).toEqual([]);
    await started(c, 'make all');
    c.passes(await c.nextPart());
    await until(async () => c.marks.length === 1);
    expect(c.marks.map(m => [m.url, m.token])).toEqual([['https://github.com/acme/mascot.git', 'ghp_mascot']]);
  });

  it('still marks a run that ended on a task closed meanwhile, and wakes nobody', async () => {
    const c = await company();
    await started(c);
    const part = await c.nextPart();
    await cancel(c.ctx, { personId: c.person.id }, c.task.id, 'Not needed.');
    c.passes(part);
    await c.ended();
    expect(c.marks.map(m => m.mark.state)).toEqual(['success']);
    expect(await c.told()).toEqual([]);
  });

  describe.each([
    ['has no right to set statuses', { problem: 'GitHub answered 403: give the key the right to write commit statuses.' }],
    ['does not see the repository', { problem: 'GitHub answered 404: give the key the right to write commit statuses.' }],
    ['GitHub does not answer', { problem: 'GitHub did not answer within 10 s.' }],
  ])('when the key %s', (_what, answer) => {
    it('says so in the result and the log, and the run that passed stays passed', async () => {
      const c = await company();
      c.answers(answer);
      await started(c);
      c.passes(await c.nextPart());
      await c.ended();
      expect((await c.runRow()).status).toBe('passed');
      const prompts = await c.told();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Test run 1 passed');
      expect(prompts[0]).toContain(answer.problem);
      expect(prompts[0]).toContain(`hornhoof/tests was not set on ${TEST_COMMIT}`);
      const line = (await c.logLines()).find(l => l.data.testsMark);
      expect(line!.text).toContain(answer.problem);
      expect(line!.data.testsMark).toEqual({ run: 1, commit: TEST_COMMIT, state: 'success', set: false });
      /* The work goes on: the task stands as it stood, and the agent has its turn. */
      expect((await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!.status).not.toBe('blocked');
    });
  });

  it('says the same when the repository key cannot be read', async () => {
    const c = await company();
    await started(c);
    const part = await c.nextPart();
    await c.db.update(departments).set({ repoTokenEnc: 'not a sealed token' }).where(eq(departments.id, c.dev.id));
    c.passes(part);
    await c.ended();
    expect(c.marks).toEqual([]);
    expect((await c.runRow()).status).toBe('passed');
    const prompt = (await c.told())[0]!;
    expect(prompt).toContain(`hornhoof/tests was not set on ${TEST_COMMIT}`);
    expect(prompt).not.toContain('sealed');
  });

  it('tells the one who starts a run whether it will leave a mark, and which command would', async () => {
    const c = await company();
    await c.online();
    const call = await c.tools();
    const full = await call('run_tests', { command: FULL, branch: 'release-checkout' });
    expect(full.text).toContain(`This is the repository's full test command: its end sets hornhoof/tests on the pinned commit.`);
    const one = await call('run_tests', { command: 'npm test -- cart.test.ts', branch: 'release-checkout' });
    expect(one.text).toContain(`The repository's full test command is ${FULL}. Only a run of exactly that sets hornhoof/tests, so this one will not.`);
    const work = await call('run_work', { command: FULL, branch: 'main' });
    expect(work.text).not.toContain('hornhoof/tests');
  });

  it('says nothing of a mark to one who starts a run where no full command is declared', async () => {
    const c = await company({ full: null });
    await c.online();
    const call = await c.tools();
    expect((await call('run_tests', { command: FULL, branch: 'release-checkout' })).text).not.toContain('hornhoof/tests');
  });

  it('never tells the key', async () => {
    const c = await company();
    c.answers({ problem: 'GitHub answered 403: give the key the right to write commit statuses.' });
    await started(c);
    c.passes(await c.nextPart());
    await c.ended();
    expect((await c.told()).join()).not.toContain(KEY);
    expect(JSON.stringify(await c.logLines())).not.toContain(KEY);
  });
});

/* A stand-in for GitHub's API, on its own port. */
async function github(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += String(chunk)));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      handler(req, res, raw);
    });
  });
  await listenIn(server);
  onTestFinished(() => new Promise<void>(done => {
    server.closeAllConnections();
    server.close(() => done());
  }));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const answering = (status: number, headers: Record<string, string> = {}) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, headers);
  res.end('{}');
};
const REPO = { url: 'https://github.com/acme/shop.git', token: KEY };
const MARK: TestsMark = { state: 'success', description: 'Test run 7 passed in Hornhoof.', targetUrl: 'https://hornhoof.acme.dev/tasks/1' };

describe('setting the mark on GitHub', () => {
  it('asks GitHub to set the status of that commit, with the key, in the context hornhoof/tests', async () => {
    const hub = await github(answering(201));
    expect(await markCommit(REPO, TEST_COMMIT, MARK, hub.api)).toEqual({ ok: true });
    expect(hub.seen).toHaveLength(1);
    const [sent] = hub.seen;
    expect(sent).toMatchObject({ method: 'POST', url: `/repos/acme/shop/statuses/${TEST_COMMIT}` });
    expect(sent!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent!.headers.accept).toBe('application/vnd.github+json');
    expect(sent!.body).toEqual({ state: 'success', context: 'hornhoof/tests', description: MARK.description, target_url: MARK.targetUrl });
  });

  it('sends no link when it has none', async () => {
    const hub = await github(answering(201));
    await markCommit(REPO, TEST_COMMIT, { ...MARK, targetUrl: null }, hub.api);
    expect(hub.seen[0]!.body).toEqual({ state: 'success', context: 'hornhoof/tests', description: MARK.description });
  });

  it.each(['https://github.com/acme/shop', 'https://github.com/acme/shop/', 'https://github.com/acme/shop.git/'])('reads the repository from %s', async url => {
    const hub = await github(answering(201));
    expect(await markCommit({ url, token: KEY }, TEST_COMMIT, MARK, hub.api)).toEqual({ ok: true });
    expect(hub.seen[0]!.url).toBe(`/repos/acme/shop/statuses/${TEST_COMMIT}`);
  });

  it.each([403, 404])('names the right to give the key when GitHub answers %i', async status => {
    const hub = await github(answering(status));
    const answer = await markCommit(REPO, TEST_COMMIT, MARK, hub.api);
    expect(answer).toEqual({ problem: expect.stringContaining(`GitHub answered ${status}`) });
    expect(answer).toEqual({ problem: expect.stringContaining('Commit statuses') });
    expect(answer).toEqual({ problem: expect.stringContaining('repo:status') });
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it('asks for a new key when GitHub no longer takes this one', async () => {
    const hub = await github(answering(401));
    expect(await markCommit(REPO, TEST_COMMIT, MARK, hub.api)).toEqual({ problem: expect.stringContaining('new token') });
  });

  it('says what GitHub answered to anything else', async () => {
    const hub = await github(answering(500));
    expect(await markCommit(REPO, TEST_COMMIT, MARK, hub.api)).toEqual({ problem: expect.stringContaining('GitHub answered 500') });
  });

  it('follows no redirect: its key stays with GitHub, and a POST that became a GET would look set', async () => {
    const other = await github(answering(200));
    const hub = await github(answering(307, { location: `${other.api}/moved` }));
    const answer = await markCommit(REPO, TEST_COMMIT, MARK, hub.api);
    expect(answer).toEqual({ problem: expect.stringContaining('GitHub answered 307') });
    expect(answer).toEqual({ problem: expect.stringContaining('moved') });
    expect(other.seen).toEqual([]);
  });

  it('says so when GitHub cannot be reached', async () => {
    const hub = await github(answering(201));
    const closed = `${hub.api.replace(/:\d+$/, '')}:1`;
    expect(await markCommit(REPO, TEST_COMMIT, MARK, closed)).toEqual({ problem: expect.stringContaining('could not be reached') });
  });

  it('says so when GitHub does not answer in time', async () => {
    const hub = await github(() => {});
    const answer = await markCommit(REPO, TEST_COMMIT, MARK, hub.api, 50);
    expect(answer).toEqual({ problem: expect.stringContaining('did not answer within 50 ms') });
  });

  it('asks nothing of a repository that is not on GitHub', async () => {
    const hub = await github(answering(201));
    const answer = await markCommit({ url: 'https://gitlab.com/acme/shop.git', token: KEY }, TEST_COMMIT, MARK, hub.api);
    expect(answer).toEqual({ problem: expect.stringContaining('github.com') });
    expect(hub.seen).toEqual([]);
  });

  it('asks nothing without a key', async () => {
    const hub = await github(answering(201));
    expect(await markCommit({ ...REPO, token: '' }, TEST_COMMIT, MARK, hub.api)).toEqual({ problem: expect.stringContaining('no token') });
    expect(hub.seen).toEqual([]);
  });
});

describe("the repository's full test command", () => {
  const set = (c: Awaited<ReturnType<typeof company>>, payload: object, token = c.ceo) =>
    c.app.inject({ method: 'PUT', url: `/api/departments/${c.dev.id}/repository`, payload: { url: 'https://github.com/acme/shop.git', branch: 'main', ...payload }, ...as(token) });
  const shown = async (c: Awaited<ReturnType<typeof company>>) =>
    (await c.app.inject({ method: 'GET', url: '/api/org', ...as(c.ceo) })).json().departments.find((d: { id: string }) => d.id === c.dev.id).repository.fullTestCommand;

  it('is saved, read back and left as it is when not named', async () => {
    const c = await company({ full: null });
    expect(await shown(c)).toBeNull();
    const saved = await set(c, { fullTestCommand: '  make all  ' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().repository.fullTestCommand).toBe('make all');
    expect(await shown(c)).toBe('make all');
    expect((await set(c, { branch: 'dev' })).json().repository.fullTestCommand).toBe('make all');
  });

  it.each([[null], ['   ']])('goes away with %j', async value => {
    const c = await company();
    expect((await set(c, { fullTestCommand: value })).json().repository.fullTestCommand).toBeNull();
    expect((await c.db.select().from(departments).where(eq(departments.id, c.dev.id)))[0]!.repoFullTestCommand).toBeNull();
  });

  it('goes away with the repository', async () => {
    const c = await company();
    await c.app.inject({ method: 'DELETE', url: `/api/departments/${c.dev.id}/repository`, ...as(c.ceo) });
    expect((await c.db.select().from(departments).where(eq(departments.id, c.dev.id)))[0]!.repoFullTestCommand).toBeNull();
  });

  /* It would mark a commit whose run covered only some of its parts. */
  it('refuses a command that names its part but not how many there are', async () => {
    const c = await company();
    const refused = await set(c, { fullTestCommand: 'vitest --shard={part}/4' });
    expect([refused.statusCode, refused.json().error.reason]).toEqual([400, 'repo_command_invalid']);
    expect((await set(c, { fullTestCommand: 'vitest --shard={part}/{parts}' })).statusCode).toBe(200);
  });

  it('refuses one longer than a run may be', async () => {
    const c = await company();
    expect((await set(c, { fullTestCommand: 'x'.repeat(4001) })).statusCode).toBe(400);
  });

  it("is set by the same tool as the rest of the repository, by the orchestrator in any turn as the company's owner", async () => {
    const c = await company({ full: null });
    const [orchestrator] = await c.db.select().from(agents).where(inArray(agents.kind, ['orchestrator']));
    const token = 'tool-token-orchestrator-0123456789abcdef01';
    await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    const client = await mcp(c.app, token);
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'set_repository')!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain('fullTestCommand');
    expect(tool.description).toContain('hornhoof/tests');
    const asked = (await client.callTool({ name: 'set_repository', arguments: { department: c.dev.id, url: 'https://github.com/acme/shop.git', fullTestCommand: 'true' } })) as Res;
    expect(asked.isError, asked.content[0]!.text).toBeFalsy();
    expect((await c.db.select().from(departments).where(eq(departments.id, c.dev.id)))[0]!.repoFullTestCommand).toBe('true');
  });

  /* Whoever may change it decides what lets a commit past GitHub's tests, so an agent's SQL may read it and no more. */
  it('stays out of what an agent may write with SQL', async () => {
    const { $client: client } = await createTestDb();
    const role = agentRole('postgres');
    await client.exec(grantsFor(role));
    const as_agent = (statement: string) => client.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE "${role}"`);
      return tx.exec(statement);
    });
    await expect(as_agent(`UPDATE departments SET repo_full_test_command = 'true' WHERE false`)).rejects.toThrow(/permission denied/);
    await expect(as_agent(`INSERT INTO departments (repo_full_test_command) SELECT 'true' WHERE false`)).rejects.toThrow(/permission denied/);
    expect((await as_agent('SELECT repo_full_test_command FROM departments'))[0]!.rows).toEqual([]);
  });
});
