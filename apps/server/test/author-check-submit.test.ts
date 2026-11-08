import type { ServerMessage } from '@hornhoof/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { jobs, pendingWakes, taskEvents, tasks, testRuns } from '../src/db/schema.js';
import { submitWithAuthorCheck } from '../src/modules/tasks/author-check-submit.js';
import { connectNode, listen, TEST_SECRET as SECRET, until, type FakeNode } from './helpers.js';
import { OTHER, qualityFixture, SHA } from './review-quality-fixture.js';

const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ HORNHOOF_SECRET: SECRET, UPDATE_CHECK_MS: '0', ...env });
const NODE_KEY = 'author-check-node-key-0123456789abcdef';
type Fixture = Awaited<ReturnType<typeof qualityFixture>>;
type TestsRun = Extract<ServerMessage, { type: 'tests.run' }>;

describe('author check on submit', () => {
  it('is disabled by default and enabled only explicitly', () => {
    expect(config().authorCheck).toBe(false);
    expect(config({ AUTHOR_CHECK: '1' }).authorCheck).toBe(true);
  });

  it('uses the direct stage submission when the adapter is disabled', async () => {
    const f = await qualityFixture();
    await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, { summary: 'Done', evidence: 'Direct stage checks', review: { baseCommit: OTHER } });
    await expectDirectSubmission(f);
  });

  it('keeps submissions without adapter input out of the runner and without a false quality pass', async () => {
    const f = await qualityFixture();
    f.app.ctx.config.authorCheck = true;
    await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, { summary: 'Done', evidence: 'No adapter', review: { baseCommit: SHA } });
    await expectDirectSubmission(f);
  });

  it('pins one remote check on the submission SHA and reuses it for repeats and races', async () => {
    const f = await qualityFixture();
    f.app.ctx.config.authorCheck = true;
    const input = { summary: 'Done', evidence: 'Remote check', review: { baseCommit: SHA, authorCheckPlan: 'plan-text' } };
    const first = await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input);
    const [run] = await authorRuns(f);
    expect(run).toMatchObject({ commitSha: SHA, parts: 1 });
    expect(run!.command).toContain(`--sha ${SHA} --base ${SHA} --plan 'plan-text'`);
    expect(first.task.externalWait).toMatchObject({ run: run!.id });
    const again = await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input);
    expect(again.task.externalWait).toMatchObject({ run: run!.id });
    await Promise.allSettled([submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input), submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input)]);
    expect(await authorRuns(f)).toHaveLength(1);
  });

  it('refuses a branch that moved between review capture and run pinning', async () => {
    const f = await qualityFixture();
    f.app.ctx.config.authorCheck = true;
    let reads = 0;
    f.app.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha: ++reads === 1 ? SHA : OTHER });
    const input = { summary: 'Done', evidence: 'Stale check', review: { baseCommit: SHA, authorCheckPlan: 'plan-text' } };
    await expect(submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input)).rejects.toThrow(/moved|changed/);
    expect(await authorRuns(f)).toHaveLength(0);
  });

  it('records partial evidence and continues after the remote stages finish without a failure', async () => {
    const f = await qualityFixture({ NODE_KEY });
    f.app.ctx.config.authorCheck = true;
    const node = await nodeOf(f);
    const { run } = await finish(f, node, input(), authorLine(), true, 0);
    const [submitted] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(submitted).toMatchObject({
      data: {
        authorCheckOutcome: { runId: run.id, status: 'partial' },
        review: { commit: SHA, quality: { status: 'partial', record: { runId: run.id, numbers: { worstCrap: 6.5, dryerFlags: 2 } } } },
      },
    });
    expect((await currentTask(f)).externalWait).toBeNull();
  });

  it('reads a structured result larger than the part tail from the stored log', async () => {
    const f = await qualityFixture({ NODE_KEY });
    f.app.ctx.config.authorCheck = true;
    const node = await nodeOf(f);
    const paths = Array.from({ length: 10 }, (_, index) => `${index}/${'a'.repeat(480)}.ts`);
    await finish(f, node, input(), authorLine(undefined, SHA, paths), true, 0);
    const [submitted] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(submitted).toMatchObject({ data: { review: { quality: { status: 'partial', record: { scope: { paths } } } } } });
  });

  it('keeps a red lint result with its producer without another run or attempt on repeat', async () => {
    const f = await qualityFixture({ NODE_KEY });
    f.app.ctx.config.authorCheck = true;
    const node = await nodeOf(f);
    const { run } = await finish(f, node, input(), `lint failed\n${authorLine('lint')}`, false, 1);
    expect(await currentTask(f)).toMatchObject({ status: 'working', assigneeAgentId: f.author.id, externalWait: null });
    expect((await outcomes(f, run.id)).at(-1)).toMatchObject({ text: expect.stringContaining('lint failed'), data: { authorCheckOutcome: { attempt: 1, status: 'failed' } } });
    await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input());
    expect(await authorRuns(f)).toHaveLength(1);
    expect(await outcomes(f, run.id)).toHaveLength(1);
    expect((await currentTask(f)).externalWait).toBeNull();
  });

  it('returns malformed runner output honestly without manufacturing a quality record', async () => {
    const f = await qualityFixture({ NODE_KEY });
    f.app.ctx.config.authorCheck = true;
    const node = await nodeOf(f);
    const { run } = await finish(f, node, input(), 'npm error Missing script: check:author', false, 1);
    expect(await currentTask(f)).toMatchObject({ status: 'working', externalWait: null });
    expect((await outcomes(f, run.id)).at(-1)).toMatchObject({ text: expect.stringContaining('Missing script'), data: { authorCheckOutcome: { status: 'failed', reason: 'output-unavailable' } } });
    const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id));
    expect(events.some(event => event.data.authorCheck !== undefined)).toBe(false);
  });

  it('keeps the first two failures with their producer and escalates the third to the head', async () => {
    const f = await qualityFixture({ NODE_KEY });
    f.app.ctx.config.authorCheck = true;
    const head = f.head;
    await f.db.update(tasks).set({ createdByAgentId: head!.id }).where(eq(tasks.id, f.task.id));
    const node = await nodeOf(f);
    let commit = SHA;
    f.app.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha: commit });
    f.app.ctx.readCompare = async () => ({ complete: true, baseSha: SHA, headSha: commit, paths: [], diff: '' });
    for (const [index, sha] of [SHA, OTHER, 'c'.repeat(40)].entries()) {
      commit = sha;
      const { run } = await finish(f, node, input(), authorLine('lint', sha), false, 1);
      expect(await currentTask(f)).toMatchObject({ status: index === 2 ? 'blocked' : 'working', externalWait: null });
      expect((await outcomes(f, run.id)).at(-1)).toMatchObject({ data: { authorCheckOutcome: { attempt: index + 1 } } });
    }
    await until(async () => {
      const turns = await f.db.select().from(jobs).where(and(eq(jobs.agentId, head!.id), eq(jobs.taskId, f.task.id)));
      const pending = await f.db.select().from(pendingWakes).where(and(eq(pendingWakes.agentId, head!.id), eq(pendingWakes.taskId, f.task.id)));
      return turns.length + pending.length > 0;
    }, 10_000);
  });
});

function input() {
  return { summary: 'Done', evidence: 'Remote check', review: { baseCommit: SHA, authorCheckPlan: 'plan-text' } };
}

function jobOf(f: Fixture) {
  return { id: f.job.id, companyId: f.author.companyId, agentId: f.author.id, agentKind: f.author.kind, roleKey: f.author.roleKey, departmentId: f.author.departmentId, skills: f.author.skills };
}

async function authorRuns(f: Fixture) {
  const runs = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id)).orderBy(desc(testRuns.number));
  return runs.filter(run => run.command.includes('check:author'));
}

async function currentTask(f: Fixture) {
  return (await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]!;
}

async function outcomes(f: Fixture, runId: string) {
  const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).orderBy(taskEvents.id);
  return events.filter(event => (event.data.authorCheckOutcome as { runId?: string } | undefined)?.runId === runId);
}

async function nodeOf(f: Fixture) {
  const url = await listen(f.app);
  const node = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: { cpus: 8, load: 0.5, memFree: 12 * 1024 ** 3, memTotal: 16 * 1024 ** 3, tests: 0, jobs: 0 }, tests: [], work: true });
  await until(() => f.app.ctx.hub.loadOf({ kind: 'builtin' }) !== null);
  return node;
}

async function nextOf(node: FakeNode): Promise<TestsRun> {
  for (;;) {
    const message = await node.next();
    if (message.type === 'tests.run') return message;
  }
}

async function finish(f: Fixture, node: FakeNode, submission: ReturnType<typeof input>, log: string, ok: boolean, exitCode: number) {
  await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, submission);
  const [run] = await authorRuns(f);
  const message = await nextOf(node);
  node.send({ type: 'tests.done', partId: message.partId, ok, exitCode, error: ok ? null : 'failed', commit: run!.commitSha, log });
  await until(async () => (await outcomes(f, run!.id)).length > 0);
  return { run: run! };
}

function authorLine(failedStage?: string, commit = SHA, paths = ['logic/totals.ts']) {
  const stages = ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'].map(name => ({
    name,
    status: name === failedStage ? 'failed' : name === 'format' ? 'unavailable' : 'passed',
    exitCode: name === failedStage ? 1 : name === 'format' ? null : 0,
    partId: null,
  }));
  return `AUTHOR_CHECK ${JSON.stringify({
    version: 1, submissionCommit: commit, checkCommit: commit, scope: { kind: 'changed', paths }, stages,
    numbers: { tests: { passed: 12, failed: 0, skipped: 1, total: 13 }, changedLines: { covered: 18, total: 20 }, worstCrap: 6.5, dryerFlags: 2 },
  })}`;
}

async function expectDirectSubmission(f: Fixture) {
  const submitted = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
  const runs = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id));
  expect(submitted).toHaveLength(1);
  expect(runs).toHaveLength(1);
  expect((await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).every(event => event.data.authorCheckPending === undefined)).toBe(true);
}
