import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { hashTestEnvironment } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { jobs, testParts, testRuns } from '../src/db/schema.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { acceptDescription } from '../src/modules/testruns/describe.js';
import { startRun } from '../src/modules/testruns/runs.js';
import { BASE } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';

async function fixture(suite?: string) {
  const f = await testsFixture();
  const [job] = await f.db.select().from(jobs).where(eq(jobs.agentId, f.tester.id));
  await startRun(f.ctx, { id: job!.id, companyId: f.task.companyId, agentId: f.tester.id, agentKind: f.tester.kind, departmentId: f.tester.departmentId }, {
    task: f.task.id, candidate: { candidateId: f.snapshot.candidateId!, revision: f.snapshot.revision }, ...(suite ? { suite } : {}),
  });
  const [run] = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id)).orderBy(desc(testRuns.number)).limit(1);
  const request = { ...run!.environmentRequest!, requestId: randomUUID(), builtin: true, sentAt: new Date().toISOString() };
  await f.db.update(testRuns).set({ environmentRequest: request }).where(eq(testRuns.id, run!.id));
  const input = await planningEnvironment(), description = input.snapshot.description;
  description.repositoryScope = request.repositoryScope;
  description.commitSha = f.finalCommit;
  description.manifest.execution = { version: 2, oncePreparation: { profiles: ['fast', 'final'], suiteIds: ['vitest'], commands: [] } };
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
});
