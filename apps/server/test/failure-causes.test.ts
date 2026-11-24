import { parseNodeMessage } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, requests, subscriptions, tasks, testParts, testRuns } from '../src/db/schema.js';
import { oldRefusal, runEnd } from '../src/modules/testruns/runs.js';
import { as, until } from './helpers.js';
import { company, done, nextOf } from './test-runs-company.js';

/* What the node says when its command guard stops a part before it starts: Hornhoof's own words, never the command's. */
const REFUSAL = 'Hornhoof stopped this command before it started. This runs over more than one package. A whole test suite runs through run_tests once per release, on its release branch. Name the test files of your change to run them here. A refusal is not a result.';

type Company = Awaited<ReturnType<typeof company>>;
const factsOf = async (c: Company) => {
  const read = await c.app.inject({ url: `/api/tasks/${c.task.id}`, ...as(c.ceo) });
  expect(read.statusCode, read.body).toBe(200);
  return read.json().task.time.waitsOn as { kind: string; reason: string | null; failure?: string }[];
};
const failures = async (c: Company) => (await factsOf(c)).filter(fact => fact.failure);

/* Bruno runs work on #1 on Ivan's machine, and the node ends its one part as it says. The server drops a message it
   cannot read, and would never answer it, so the test first holds that it can: a protocol without the word fails here,
   at once, instead of waiting for an answer that never comes. */
async function runWork(c: Company, ivan: Awaited<ReturnType<Company['machine']>>, command: string, end: object) {
  const { call } = await c.turn(c.bruno);
  expect((await call('run_work', { command })).error).toBe(false);
  const run = await nextOf(ivan.node, 'tests.run');
  const message = done(run, { commit: null, ...end });
  expect(parseNodeMessage(JSON.stringify(message)), 'the server reads the node\'s end of the part').not.toBeNull();
  ivan.node.send(message);
  await nextOf(ivan.node, 'tests.ack');
  return call;
}
const runsOf = async (c: Company) => c.db.select({ number: testRuns.number, status: testRuns.status }).from(testRuns).orderBy(asc(testRuns.number));

describe('a refusal is a hint, never a failure', () => {
  it('ends a work run its node refused as refused, wakes its agent with the refusal at once, and leaves the task out of Failures', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const call = await runWork(c, ivan, 'npm test --workspaces', { ok: false, exitCode: null, error: 'refused', log: REFUSAL });
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await runsOf(c)).toEqual([{ number: 1, status: 'refused' }]);
    expect(await c.db.select({ status: testParts.status, error: testParts.error }).from(testParts)).toEqual([{ status: 'refused', error: 'refused' }]);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/Work run 1 was refused before it started, so nothing ran: this is no result and no failure\./);
    expect(prompt).toContain('Name the test files of your change to run them here.');
    expect(prompt).not.toMatch(/Part 1 of 1 failed/);
    expect(JSON.parse((await call('work_run', { run: 1 })).text)).toMatchObject({ run: 1, status: 'refused', parts: [{ part: 1, status: 'refused', why: 'Hornhoof refused it before it started, so nothing ran', end: REFUSAL }] });
    expect(await failures(c)).toEqual([]);
    /* The agent's own wait on the work stays a wait, with no failure in it. */
    expect((await call('track_work', { task: 1, work: 'Release check', nextCheck: new Date(Date.now() + 3_600_000).toISOString() })).error).toBe(false);
    expect(await factsOf(c)).toEqual([expect.objectContaining({ kind: 'work' })]);
    expect(await failures(c)).toEqual([]);
  });

  it('says of a refused part that it was refused, with its words, beside a part of the same run that failed', async () => {
    const c = await company();
    const [ivan, ann] = [await c.machine(c.ceo, 'dev-mac'), await c.machine(c.ann, 'ann-pc')];
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'npm test --workspaces --shard={part}/{parts}', parts: 2 })).error).toBe(false);
    const [one, two] = [await nextOf(ivan.node, 'tests.run'), await nextOf(ann.node, 'tests.run')];
    const [refusedOn, failedOn] = one.part === 1 ? [ivan, ann] : [ann, ivan];
    const [first, second] = one.part === 1 ? [one, two] : [two, one];
    refusedOn.node.send(done(first, { ok: false, exitCode: null, error: 'refused', commit: null, log: REFUSAL }));
    await nextOf(refusedOn.node, 'tests.ack');
    failedOn.node.send(done(second, { ok: false, exitCode: 1, error: 'failed', commit: null, log: 'one test failed\n' }));
    await nextOf(failedOn.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/Part 1 of 2 was refused[^\n]*: Hornhoof refused it before it started, so nothing ran\./);
    expect(prompt).toMatch(/Part 2 of 2 failed[^\n]*: exit code 1\./);
    expect(JSON.parse((await call('work_run', { run: 1 })).text)).toMatchObject({ parts: [
      { part: 1, status: 'refused', why: 'Hornhoof refused it before it started, so nothing ran', end: REFUSAL },
      { part: 2, status: 'failed', why: 'exit code 1', end: 'one test failed\n' },
    ] });
  });

  it('fails the task for a started run that failed, keeps it failed through a refused run, and clears it with a green one', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    await runWork(c, ivan, 'make report', { ok: false, exitCode: 1, error: 'failed', log: 'make: *** [report] Error 1\n' });
    await until(async () => (await runsOf(c)).length === 1 && (await runsOf(c))[0]!.status !== 'running');
    expect(await failures(c)).toEqual([expect.objectContaining({ kind: 'work', reason: '1', failure: 'run' })]);
    await runWork(c, ivan, 'npm test', { ok: false, exitCode: null, error: 'refused', log: REFUSAL });
    await until(async () => (await runsOf(c)).length === 2 && (await runsOf(c)).at(-1)!.status !== 'running');
    expect((await runsOf(c)).at(-1)!.status).toBe('refused');
    expect(await failures(c)).toEqual([expect.objectContaining({ kind: 'work', reason: '1', failure: 'run' })]);
    await runWork(c, ivan, 'make report', { ok: true, exitCode: 0, error: null, log: 'done\n' });
    await until(async () => (await runsOf(c)).length === 3 && (await runsOf(c)).at(-1)!.status !== 'running');
    expect((await runsOf(c)).at(-1)!.status).toBe('passed');
    expect(await failures(c)).toEqual([]);
  });

  it('knows the refusal of a node from before refusals had their own word, which said failed for it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    await runWork(c, ivan, 'npm test --workspaces', { ok: false, exitCode: null, error: 'failed', log: `запусти через run_tests\n${REFUSAL}` });
    await until(async () => (await runsOf(c))[0]?.status !== 'running');
    expect(await runsOf(c)).toEqual([{ number: 1, status: 'refused' }]);
    expect(await failures(c)).toEqual([]);
  });

  it("keeps a work run failed whose own command printed the refusal's words and was ended by a signal", async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    /* The node writes the command as the first line; what the command printed follows, and a signal leaves no exit code. */
    const said = REFUSAL.slice(0, REFUSAL.indexOf('.') + 1);
    const command = `echo '${said}'; kill -9 $$`;
    await runWork(c, ivan, command, { ok: false, exitCode: null, error: 'failed', log: `$ ${command}\n${said}\n` });
    await until(async () => (await runsOf(c))[0]?.status !== 'running');
    expect(await runsOf(c)).toEqual([{ number: 1, status: 'failed' }]);
    expect(await failures(c)).toEqual([expect.objectContaining({ kind: 'work', reason: '1', failure: 'run' })]);
  });

  it('takes as an old refusal only a log that is the guard\'s refusal alone, from its first character', () => {
    expect(oldRefusal(`запусти через run_tests\n${REFUSAL}`)).toBe(true);
    expect(oldRefusal(`${REFUSAL}\n`)).toBe(true);
    expect(oldRefusal(`$ npm test\n${REFUSAL}`)).toBe(false);
    expect(oldRefusal(`$ npm test\nзапусти через run_tests\n${REFUSAL}`)).toBe(false);
    expect(oldRefusal(`${REFUSAL}\nkilled`)).toBe(false);
    expect(oldRefusal(`запусти через run_tests\n${REFUSAL}\nkilled`)).toBe(false);
    expect(oldRefusal(` ${REFUSAL}`)).toBe(false);
  });

  it('refuses a run none of whose parts failed, and fails one where a started part failed', () => {
    expect(runEnd([{ status: 'passed' }, { status: 'passed' }])).toBe('passed');
    expect(runEnd([{ status: 'refused' }])).toBe('refused');
    expect(runEnd([{ status: 'passed' }, { status: 'refused' }])).toBe('refused');
    expect(runEnd([{ status: 'failed' }, { status: 'refused' }])).toBe('failed');
    expect(runEnd([{ status: 'failed' }])).toBe('failed');
  });
});

describe('a stuck agent asking for help', () => {
  it('fails its task until someone answers', async () => {
    const c = await company();
    const [asked] = await c.db.insert(requests).values({ companyId: c.task.companyId, taskId: c.task.id, agentId: c.bruno.id, kind: 'stuck', text: 'I cannot go on.', decisionTopic: 'task', audience: 'internal', triageAgentId: c.head.id }).returning();
    expect(await failures(c)).toEqual([expect.objectContaining({ kind: 'external', failure: 'stuck', who: expect.objectContaining({ kind: 'agent', id: c.head.id }) })]);
    await c.db.update(requests).set({ status: 'resolved_internal', answer: 'Use the other branch.' }).where(eq(requests.id, asked!.id));
    expect(await failures(c)).toEqual([]);
  });

  it('names who is to answer, though nothing else on the task names them', async () => {
    const c = await company();
    await c.db.insert(requests).values({ companyId: c.task.companyId, taskId: c.task.id, agentId: c.bruno.id, kind: 'stuck', text: 'I cannot go on.', decisionTopic: 'task', audience: 'internal', triageAgentId: c.sam.id });
    expect(await failures(c)).toEqual([expect.objectContaining({ failure: 'stuck', who: expect.objectContaining({ kind: 'agent', id: c.sam.id, name: 'Sam' }) })]);
  });
});

describe('turn errors on a task', () => {
  it('fail it for the turns of whoever holds it now, as a reviewer does, and not for its executor while another holds it', async () => {
    const c = await company();
    const [sub] = await c.db.select().from(subscriptions);
    const base = Date.now();
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(base) }).where(eq(jobs.taskId, c.task.id));
    /* Sam reads Bruno's work: Sam holds the task now, and Bruno stays the one who does it. */
    await c.db.update(tasks).set({ assigneeAgentId: c.sam.id, executorAgentId: c.bruno.id }).where(eq(tasks.id, c.task.id));
    const crashed = { kind: 'unknown' as const, retryable: false, text: 'The program stopped.' };
    const turn = (agentId: string, minute: number) =>
      c.db.insert(jobs).values({ companyId: c.task.companyId, subscriptionId: sub!.id, agentId, taskId: c.task.id, kind: 'conversation', prompt: 'Work.', timeoutMs: 1000, status: 'failed', failure: crashed, createdAt: at(minute), finishedAt: at(minute) });
    await turn(c.bruno.id, 1);
    expect(await failures(c)).toEqual([]);
    await turn(c.sam.id, 2);
    expect(await failures(c)).toEqual([expect.objectContaining({ kind: 'external', failure: 'turn' })]);
  });

  it('fail the task only when no turn takes it on by itself, and a turn that goes well clears it', async () => {
    const c = await company();
    const [sub] = await c.db.select().from(subscriptions);
    const base = Date.now();
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    /* The wakes that gave Bruno the task are over. */
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(base) }).where(eq(jobs.taskId, c.task.id));
    const turn = (minute: number, over: object) => c.db.insert(jobs).values({ companyId: c.task.companyId, subscriptionId: sub!.id, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Work.', timeoutMs: 1000, createdAt: at(minute), finishedAt: at(minute), ...over }).returning();
    const overloaded = { kind: 'overloaded' as const, retryable: true, text: '529 Overloaded.' };
    /* A 529 whose retry is queued goes on by itself. */
    const [first] = await turn(1, { status: 'failed', failure: overloaded });
    const [retry] = await c.db.insert(jobs).values({ companyId: c.task.companyId, subscriptionId: sub!.id, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Again.', timeoutMs: 1000, status: 'queued', continueOf: first!.id, notBefore: at(2) }).returning();
    expect(await failures(c)).toEqual([]);
    /* Its last retry failed too, and none follows: the head and Operations need to look. */
    await c.db.update(jobs).set({ status: 'failed', failure: overloaded, createdAt: at(12), finishedAt: at(12) }).where(eq(jobs.id, retry!.id));
    expect(await failures(c)).toEqual([expect.objectContaining({ kind: 'external', failure: 'turn' })]);
    /* A turn replaced because the task moved on while it ran is no failure, and leaves the one before it as it was. */
    await turn(13, { status: 'failed', error: 'stale', failure: { kind: 'unknown', retryable: false, text: 'Stale turn.' } });
    expect(await failures(c)).toEqual([expect.objectContaining({ failure: 'turn' })]);
    /* A turn of Bruno waits on the task: it takes the work on, so nothing fails while it waits or runs. */
    const [next] = await c.db.insert(jobs).values({ companyId: c.task.companyId, subscriptionId: sub!.id, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Go on.', timeoutMs: 1000, status: 'running', createdAt: at(14), startedAt: at(14) }).returning();
    expect(await failures(c)).toEqual([]);
    /* It went well: the failure is gone for good. */
    await c.db.update(jobs).set({ status: 'done', finishedAt: at(15) }).where(eq(jobs.id, next!.id));
    expect(await failures(c)).toEqual([]);
  });
});
