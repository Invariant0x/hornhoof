import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { hashTestEnvironment } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { jobs, testParts, testRuns } from '../src/db/schema.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { acceptDescription } from '../src/modules/testruns/describe.js';
import { pumpTests, startRun } from '../src/modules/testruns/runs.js';
import { report } from '../src/modules/tasks/engine.js';
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
  it('records an unchanged applicable scope without creating or running a test part', async () => {
    const f = await fixture();
    f.reply.result.baseFingerprints.fingerprints = f.reply.result.fingerprints.map(print => ({ ...print }));
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    expect((await f.stored()).environmentRequest?.problem).toBeNull();
    expect((await f.stored()).environmentSnapshot?.candidate).toBeDefined();
    expect(await f.parts()).toEqual([]);
    await pumpTests(f.ctx);
    const run = await f.stored();
    expect(run).toMatchObject({ parts: 0, status: 'passed' });
    await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]));
    expect((await f.detail()).echelons.phase).toBe('ready');
  });
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
    const f = await fixture(undefined, { full: true, profile: 'final' });
    await f.run(f.finalCommit, 1, { cache: true });
    f.reply.result.baseFingerprints.fingerprints[0]!.fingerprint = 'e'.repeat(64);
    f.reply.result.baseFingerprints.fingerprints[1]!.fingerprint = f.reply.result.fingerprints[1]!.fingerprint;
    await acceptDescription(f.ctx, BUILTIN, f.reply);
    const stored = await f.stored();
    expect(stored.environmentRequest?.problem).toBeNull();
    expect(stored.fileCache).toMatchObject({ mode: 'cached', reused: 1, preparationReused: false });
    expect((await f.parts()).map(part => part.environmentSelection!.selection)).toEqual([{ kind: 'final', suiteId: 'vitest', files: [] }]);
  });
});

async function mutationScopeFixture() {
  const f = await fixture(), description = f.reply.result.description;
  const sources = ['logic/totals.ts', 'logic/process.ts', 'logic/unchanged.ts'];
  const command = { program: 'node', args: ['scripts/mutation/run.mjs'], cwd: '.' };
  description.manifest.mutation = { status: 'supported', language: 'typescript', tool: 'mutator', command, sourcePaths: sources,
    fastTestPaths: ['web/test/b.test.ts'], coverageCommands: [command], coverageFiles: ['coverage.json'] };
  description.manifest.suites.push({ id: 'mutation', root: '.', files: sources, run: command, split: { kind: 'json-file' }, profiles: ['fast', 'final'] });
  for (const profile of description.manifest.profiles) profile.requiredSuiteIds.push('mutation');
  sources.forEach((file, index) => {
    description.inventory.push({ suiteId: 'mutation', file, selectionUnit: file });
    f.reply.result.fingerprints.push({ suiteId: 'mutation', file, fingerprint: String(index + 5).repeat(64) });
    f.reply.result.baseFingerprints.fingerprints.push({ suiteId: 'mutation', file, fingerprint: String(index + 1).repeat(64) });
  });
  description.manifestSource = JSON.stringify(description.manifest);
  description.manifestHash = await hashTestEnvironment(description.manifestSource);
  const mutation = {
    delta: { baseCommit: BASE, commit: f.finalCommit, changes: [{ path: sources[0]!, ranges: [[1, 1]] }, { path: sources[1]!, ranges: [[1, 1]] }] },
    selection: { version: 1 as const, status: 'ready' as const, baseCommit: BASE, commit: f.finalCommit,
      selected: [{ file: sources[0]!, name: 'total', startLine: 1, endLine: 1, lines: [1], tests: ['web/test/b.test.ts'], reason: 'changed_pure_function' as const }],
      excluded: [{ file: sources[1]!, name: 'process', reason: 'purity_unproven' }], problems: [] },
  };
  return { ...f, mutation, reply: { ...f.reply, result: { ...f.reply.result, mutation } } };
}

it('persists authenticated mutation scope and selects changed pure sources without process or unchanged functions', async () => {
  const f = await mutationScopeFixture();
  await acceptDescription(f.ctx, BUILTIN, f.reply);
  const run = await f.stored();
  expect(run.environmentRequest?.problem).toBeNull();
  expect(run.environmentSnapshot?.candidate?.mutation).toEqual(f.mutation);
  const files = (await f.parts()).flatMap(part => part.environmentSelection!.selection.kind === 'batch' ? part.environmentSelection!.selection.selections.filter(suite => suite.suiteId === 'mutation').flatMap(suite => suite.files) : []);
  expect(files).toEqual(['logic/totals.ts']);
});

it.each(['missing', 'blocked', 'wrong-base', 'wrong-head'] as const)('refuses %s mutation applicability before creating candidate parts', async problem => {
  const f = await mutationScopeFixture();
  if (problem === 'missing') Reflect.deleteProperty(f.reply.result, 'mutation');
  if (problem === 'blocked') Object.assign(f.mutation.selection, { status: 'blocked', problems: [{ file: 'logic/totals.ts', code: 'no_safe_fast_tests' }] });
  if (problem === 'wrong-base') f.mutation.delta.baseCommit = 'f'.repeat(40);
  if (problem === 'wrong-head') f.mutation.selection.commit = 'f'.repeat(40);
  await acceptDescription(f.ctx, BUILTIN, f.reply);
  expect((await f.stored()).environmentSnapshot).toBeNull();
  expect((await f.stored()).environmentRequest?.problem?.code).toBe('description_mismatch');
  expect(await f.parts()).toEqual([]);
});
