import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { hashTestEnvironment } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { jobs, testFileResults, testParts, testRuns } from '../src/db/schema.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { acceptDescription } from '../src/modules/testruns/describe.js';
import { startRun } from '../src/modules/testruns/runs.js';
import { BASE } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';

async function fixture(suite?: string, options: { full?: boolean; profile?: string } = {}) {
  const f = await testsFixture();
  const [job] = await f.db.select().from(jobs).where(eq(jobs.agentId, f.tester.id));
  await startRun(f.ctx, { id: job!.id, companyId: f.task.companyId, agentId: f.tester.id, agentKind: f.tester.kind, departmentId: f.tester.departmentId }, {
    task: f.task.id, candidate: { candidateId: f.snapshot.candidateId!, revision: f.snapshot.revision }, ...(suite ? { suite } : {}), ...(options.profile ? { profile: options.profile } : {}),
  });
  const [run] = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id)).orderBy(desc(testRuns.number)).limit(1);
  const request = { ...run!.environmentRequest!, requestId: randomUUID(), builtin: true, sentAt: new Date().toISOString() };
  await f.db.update(testRuns).set({ environmentRequest: request }).where(eq(testRuns.id, run!.id));
  const input = await planningEnvironment({ pythonFinalOnly: options.full }), description = input.snapshot.description;
  description.repositoryScope = request.repositoryScope;
  description.commitSha = f.finalCommit;
  description.manifest.execution = { version: 2, oncePreparation: { profiles: ['fast', 'final'], suiteIds: ['vitest'], commands: [] } };
  if (options.full) description.manifest.execution.fullRun = { everyTurns: 5, replaces: 'fast', profile: 'final' };
  description.manifestSource = JSON.stringify(description.manifest);
  description.manifestHash = await hashTestEnvironment(description.manifestSource);
  const fingerprints = description.inventory.map((unit, index) => ({ suiteId: unit.suiteId, file: unit.file, fingerprint: String(index + 1).repeat(64) }));
  const baseFingerprints = { commitSha: BASE, fingerprints: fingerprints.map((print, index) => ({ ...print, fingerprint: index === 1 ? 'f'.repeat(64) : print.fingerprint })) };
  const reply = { type: 'tests.described' as const, requestId: request.requestId, commitSha: f.finalCommit, result: { status: 'ready' as const, description, fingerprints, baseFingerprints } };
  const stored = async () => (await f.db.select().from(testRuns).where(eq(testRuns.id, run!.id)))[0]!;
  const parts = () => f.db.select().from(testParts).where(eq(testParts.runId, run!.id));
  return { ...f, reply, stored, parts };
}

describe('candidate scope from the authenticated metadata response', () => {
  it('keeps the bound pair and plans only its affected canonical test units', async () => {
    const f = await fixture();
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    const run = await f.stored();
    expect(run.environmentRequest?.problem).toBeNull();
    expect(run.environmentSnapshot).toMatchObject({ candidate: { baseCommit: BASE, baseFingerprints: f.reply.result.baseFingerprints.fingerprints, fingerprints: f.reply.result.fingerprints } });
    const selections = (await f.parts()).map(part => part.environmentSelection!.selection);
    expect(selections.some(selection => selection.kind === 'prepare')).toBe(false);
    const files = selections.flatMap(selection => selection.kind === 'batch' ? selection.selections.flatMap(suite => suite.files) : []);
    expect(files).toEqual(['web/test/b.test.ts']);
  });

  it.each(['missing-base', 'wrong-base', 'missing-head', 'missing-print', 'duplicate-print', 'duplicate-base'] as const)('does not create a candidate plan from %s evidence', async problem => {
    const f = await fixture(), result = f.reply.result;
    if (problem === 'missing-base') Reflect.deleteProperty(result, 'baseFingerprints');
    if (problem === 'wrong-base') result.baseFingerprints.commitSha = 'f'.repeat(40);
    if (problem === 'missing-head') Reflect.deleteProperty(result, 'fingerprints');
    if (problem === 'missing-print') result.fingerprints.pop();
    if (problem === 'duplicate-print') result.fingerprints.push(result.fingerprints[0]!);
    if (problem === 'duplicate-base') result.baseFingerprints.fingerprints.push(result.baseFingerprints.fingerprints[0]!);
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    const run = await f.stored();
    expect(run.environmentSnapshot).toBeNull();
    expect(run.environmentRequest?.problem?.code).toBe('description_mismatch');
    expect(await f.parts()).toEqual([]);
  });

  it('does not let the caller omit an affected suite from candidate verification', async () => {
    const f = await fixture('pytest');
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    expect((await f.stored()).environmentSnapshot).toBeNull();
    expect((await f.stored()).environmentRequest?.problem?.code).toBe('description_mismatch');
  });

  it('uses the complete declared profile while selecting only affected units across its suites', async () => {
    const f = await fixture(undefined, { full: true });
    f.reply.result.baseFingerprints.fingerprints[2]!.fingerprint = 'e'.repeat(64);
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    const run = await f.stored();
    expect(run.environmentRequest?.problem).toBeNull();
    expect(run.environmentSnapshot?.profile).toBe('final');
    expect(run.fileCache?.mode).toBe('cached');
    const files = (await f.parts()).flatMap(part => part.environmentSelection!.selection.kind === 'batch' ? part.environmentSelection!.selection.selections.flatMap(suite => suite.files) : []);
    expect(files.sort()).toEqual(['python/tests/test_values.py', 'web/test/b.test.ts']);
  });

  it('refuses a caller profile that omits candidate checks in the complete declared profile', async () => {
    const f = await fixture(undefined, { full: true, profile: 'fast' });
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    expect((await f.stored()).environmentSnapshot).toBeNull();
    expect((await f.stored()).environmentRequest?.problem?.code).toBe('description_mismatch');
    expect(await f.parts()).toEqual([]);
  });

  it('reuses an affected unit at its final fingerprint without requiring a whole-profile preparation', async () => {
    const f = await fixture(undefined, { full: true, profile: 'final' }), run = await f.stored();
    const print = f.reply.result.fingerprints[1]!;
    await f.db.insert(testFileResults).values({ ...run.environmentRequest!.repositoryScope, ...print, runId: run.id, commitSha: 'd'.repeat(40), mainLine: true });
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    const stored = await f.stored();
    expect(stored.environmentRequest?.problem).toBeNull();
    expect(stored.fileCache).toMatchObject({ mode: 'cached', reused: 1, preparationReused: false });
    expect((await f.parts()).map(part => part.environmentSelection!.selection)).toEqual([{ kind: 'final', suiteId: 'vitest', files: [] }]);
  });
});
