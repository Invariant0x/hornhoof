import { EnvironmentProblem, hashTestEnvironment, type TestsDescribed } from '@hornhoof/protocol';
import { PglitePreparedQuery } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished, vi } from 'vitest';
import { agents, departments, jobs, tasks, testParts, testRuns } from '../src/db/schema.js';
import { acceptDescription, newEnvironmentRequest, repositoryScope, setProductPlanningPorts } from '../src/modules/testruns/describe.js';
import { reuseFor } from '../src/modules/testruns/reuse.js';
import { BUILTIN } from './builtin.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';
import { prepareApp, setUpCompany, statements, testApp, TEST_COMMIT } from './helpers.js';

await prepareApp();

async function fixture() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator')), companyId = agent!.companyId;
  const [department] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://example.test/fixture.git' }).returning();
  const [task] = await db.insert(tasks).values({ companyId, departmentId: department!.id, number: 1, title: 'Description fixture', status: 'working', assigneeAgentId: agent!.id, executorAgentId: agent!.id }).returning();
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id, taskId: task!.id, prompt: 'Fixture', timeoutMs: 10_000, status: 'running' }).returning();
  const request = { ...newEnvironmentRequest(repositoryScope(companyId, department!.id, department!.repoUrl!), { mode: 'product' }), requestId: randomUUID(), builtin: true };
  const [run] = await db.insert(testRuns).values({ companyId, departmentId: department!.id, taskId: task!.id, agentId: agent!.id, jobId: job!.id, number: 1, command: '', commitSha: TEST_COMMIT, timeoutMs: 10_000, environmentRequest: request }).returning();
  const { snapshot } = await planningEnvironment();
  const description = { ...snapshot.description, repositoryScope: request.repositoryScope,
    runtimeCapabilities: [{ id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64) }, { id: 'python', version: '3.12.0', fingerprint: 'c'.repeat(64) }, { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'd'.repeat(64) }] };
  const reply: TestsDescribed = { type: 'tests.described', requestId: request.requestId, commitSha: TEST_COMMIT, result: { status: 'ready', description } };
  const stored = async () => (await db.select().from(testRuns).where(eq(testRuns.id, run!.id)))[0]!;
  return { app, db, run: run!, reply, stored, snapshot: { ...snapshot, description } };
}

/* The driver's recorded error when the 5 s limit ended run 116's reuse lookup. Drizzle keeps it as a cause. */
const transactionTimeout = () => new Error('Failed query', { cause: Object.assign(new Error('terminating connection due to transaction timeout'), { code: '25P04', severity: 'FATAL' }) });

function failQuery(match: RegExp, failure: Error) {
  const execute = PglitePreparedQuery.prototype.execute;
  const spy = vi.spyOn(PglitePreparedQuery.prototype, 'execute').mockImplementation(function (this: PglitePreparedQuery<never>, values) {
    const { queryString } = this as unknown as { queryString: string };
    if (match.test(queryString)) return Promise.reject(failure);
    return execute.call(this, values);
  });
  onTestFinished(() => spy.mockRestore());
}

it.each([
  { error: transactionTimeout(), code: 'transaction_timeout', detail: 'The database ended the environment description lookup or save at its 5 s transaction limit.' },
  { error: new Error('Internal write failure with private SQL'), code: 'save_failed', detail: 'The server could not prepare or save the environment description.' },
])('reports a failed save as $code and leaves no published description or parts', async ({ error, code, detail }) => {
  const f = await fixture();
  failQuery(/^insert into "test_parts"/, error);
  await acceptDescription(f.app.ctx, BUILTIN, f.reply);
  const run = await f.stored();
  expect(run.environmentRequest!.problem).toEqual({ code, detail });
  expect(EnvironmentProblem.parse(run.environmentRequest!.problem)).toEqual({ code, detail });
  expect(run.environmentSnapshot).toBeNull();
  expect(await f.db.select().from(testParts)).toEqual([]);
});

it('reports the transaction limit in the reuse lookup before opening the save transaction', async () => {
  const f = await fixture();
  if (f.reply.result.status !== 'ready') throw new Error('Fixture description is absent.');
  const description = f.reply.result.description;
  description.manifest.execution = { version: 2, fullRun: { replaces: 'fast', profile: 'final' } };
  description.manifestSource = JSON.stringify(description.manifest);
  description.manifestHash = await hashTestEnvironment(description.manifestSource);
  f.reply.result.fingerprints = [{ suiteId: 'vitest', file: 'web/test/a.test.ts', fingerprint: 'b'.repeat(64) }];
  failQuery(/from "test_file_results"/, transactionTimeout());
  await acceptDescription(f.app.ctx, BUILTIN, f.reply);
  expect((await f.stored()).environmentRequest!.problem?.code).toBe('transaction_timeout');
  expect(await f.db.select().from(testParts)).toEqual([]);
});

it('reports an internal planning failure as save_failed', async () => {
  const f = await fixture();
  setProductPlanningPorts(f.app.ctx, { history: async () => { throw new Error('Internal history failure'); } });
  f.snapshot.description.manifest.execution = { version: 2 };
  f.snapshot.description.manifestSource = JSON.stringify(f.snapshot.description.manifest);
  f.snapshot.description.manifestHash = await hashTestEnvironment(f.snapshot.description.manifestSource);
  await acceptDescription(f.app.ctx, BUILTIN, f.reply);
  expect((await f.stored()).environmentRequest!.problem?.code).toBe('save_failed');
});

it.each(['hash', 'commit', 'scope'] as const)('still calls invalid %s evidence description_mismatch', async changed => {
  const f = await fixture();
  if (f.reply.result.status !== 'ready') throw new Error('Fixture description is absent.');
  const description = f.reply.result.description;
  if (changed === 'hash') description.manifestHash = 'f'.repeat(64);
  if (changed === 'commit') description.commitSha = 'f'.repeat(40);
  if (changed === 'scope') description.repositoryScope = { ...description.repositoryScope, repoUrlHash: 'f'.repeat(64) };
  await acceptDescription(f.app.ctx, BUILTIN, f.reply);
  expect((await f.stored()).environmentRequest!.problem?.code).toBe('description_mismatch');
  expect(await f.db.select().from(testParts)).toEqual([]);
});

it('binds run 116-sized fingerprint input as one deduplicated text array and keeps release safeguards', async () => {
  const f = await fixture(), seen = statements();
  // Run 116 sent 1188 distinct fingerprints. The values here are deterministic stand-ins for their digests.
  const prints = Array.from({ length: 1188 }, (_, i) => ({ suiteId: 'vitest', file: `web/test/${i}.test.ts`, fingerprint: i.toString(16).padStart(64, '0') }));
  const result = await reuseFor(f.app.ctx, { mode: 'cached', release: 'turn-32', since: new Date('2026-11-17T00:00:00Z') }, f.snapshot, f.snapshot.description.inventory, [...prints, prints[0]!]);
  expect(result.decision.reused.size).toBe(0);
  const lookup = seen.find(query => query.sql.includes('from "test_file_results"'))!;
  expect(lookup.sql).toMatch(/"fingerprint" = any\(\$\d+::text\[\]\)/i);
  expect(lookup.params.filter(Array.isArray)).toEqual([prints.map(print => print.fingerprint)]);
  expect(lookup.sql).toContain('not exists');
  expect(lookup.sql).toContain('"failed_files" @>');
  expect(lookup.params).toContain('turn-32');
});
