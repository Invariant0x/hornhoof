import { randomUUID } from 'node:crypto';
import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { hashTestEnvironment } from '@hornhoof/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { jobs, testParts, testRuns } from '../src/db/schema.js';
import { BUILTIN } from './builtin.js';
import { acceptDescription, noteTestCapabilities } from '../src/modules/testruns/describe.js';
import { partDone, pumpTests, startRun } from '../src/modules/testruns/runs.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';

export async function testsFixture(fix = false) {
  const f = await fixture();
  const input = { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit: BASE } };
  await submit(f.ctx, f.author.id, f.task.id, input);
  let finalCommit = HEAD;
  if (fix) {
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Fixing a boundary.', reviewedCommit: HEAD });
    finalCommit = 'c'.repeat(40);
    f.atCommit(finalCommit);
    await submit(f.ctx, f.reviewer.id, f.task.id, input);
  } else await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the candidate.', reviewedCommit: HEAD });
  const snapshot = (await f.detail()).echelons;
  return { ...f, ...await candidateChecks(f, snapshot, finalCommit) };
}

/* Reuse the authenticated run/receipt path for an existing candidate and its live Tests owner. */
export async function candidateChecks(f: Pick<Awaited<ReturnType<typeof fixture>>, 'ctx' | 'db' | 'task' | 'tester'>, snapshot: EchelonsSnapshot, finalCommit: string, baseCommit = BASE) {
  const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.tester.id, subscriptionId: f.tester.subscriptionId!, taskId: f.task.id, kind: 'conversation', prompt: 'Verify final candidate', timeoutMs: 1000 }).returning();
  const start = async (command?: string) => {
    await startRun(f.ctx, { id: job!.id, companyId: f.task.companyId, agentId: f.tester.id, agentKind: f.tester.kind, departmentId: f.tester.departmentId }, {
      task: f.task.id, ...(command ? { command } : {}), candidate: { candidateId: snapshot.candidateId!, revision: snapshot.revision },
    });
    const [value] = await f.db.select().from(testRuns).where(and(eq(testRuns.taskId, f.task.id), eq(testRuns.agentId, f.tester.id))).orderBy(desc(testRuns.number)).limit(1);
    return value!;
  };
  const manualRun = () => start('Changed tests');
  const run = async (commit = finalCommit, parts = 1, options: { finalChecks?: boolean; cache?: boolean; suitesOnly?: boolean } = {}) => {
    const value = await start(), request = { ...value.environmentRequest!, requestId: randomUUID(), builtin: true, sentAt: new Date().toISOString() };
    await f.db.update(testRuns).set({ environmentRequest: request }).where(eq(testRuns.id, value.id));
    const { snapshot: environment } = await planningEnvironment(), description = environment.description, manifest = description.manifest;
    manifest.runtimes = [{ id: 'node', version: '22' }];
    manifest.profiles = [{ id: 'fast', requiredSuiteIds: ['vitest'] }];
    manifest.suites = [{ ...manifest.suites[0]!, profiles: ['fast'], finalChecks: options.finalChecks ? manifest.suites[0]!.finalChecks : [] }];
    manifest.execution = { version: 2 };
    if (options.cache) {
      manifest.profiles.push({ id: 'full', requiredSuiteIds: ['vitest'] });
      manifest.suites[0]!.profiles.push('full');
      manifest.execution.fullRun = { replaces: 'fast', profile: 'full' };
    }
    if (options.suitesOnly) delete manifest.execution;
    const profile = options.cache ? 'full' : 'fast';
    description.repositoryScope = request.repositoryScope;
    description.commitSha = finalCommit;
    description.inventory = [description.inventory[0]!];
    description.manifestSource = JSON.stringify(manifest);
    description.manifestHash = await hashTestEnvironment(description.manifestSource);
    const runtimes = [{ id: 'node', version: '22.0.0', fingerprint: 'e'.repeat(64) }, { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'f'.repeat(64) }];
    description.runtimeCapabilities = runtimes;
    const unit = description.inventory[0]!, fingerprints = [{ suiteId: unit.suiteId, file: unit.file, fingerprint: '1'.repeat(64) }];
    noteTestCapabilities(f.ctx, BUILTIN, { testEnvironmentVersion: 1, testRuntimes: runtimes });
    await acceptDescription(f.ctx, BUILTIN, { type: 'tests.described', requestId: request.requestId, commitSha: finalCommit,
      result: { status: 'ready', description, fingerprints, baseFingerprints: { commitSha: baseCommit, fingerprints: fingerprints.map(print => ({ ...print, fingerprint: '2'.repeat(64) })) } } });
    const planned = await f.db.select().from(testParts).where(eq(testParts.runId, value.id));
    if ((!options.cache && planned.length !== (options.finalChecks ? 2 : 1)) || planned.some(part => !part.environmentSelection)) throw new Error('The fixture needs authenticated candidate selections.');
    for (const part of planned.sort((a, b) => a.part - b.part)) {
      const selection = part.environmentSelection!.selection;
      const identity = { commitSha: finalCommit, manifestHash: description.manifestHash, runtimes, dependencies: { key: null, hit: false }, environments: [],
        phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 } };
      const receipt = selection.kind === 'batch' ? { ...identity, version: 2 as const, profile, selection, outcomes: [{ index: 0, status: 'passed' as const, exitCode: 0 }] }
        : selection.kind === 'final' ? { ...identity, version: 1 as const, kind: 'final' as const, suiteId: selection.suiteId, files: [] }
          : selection.kind === 'suite' ? { ...identity, version: 1 as const, kind: 'suite' as const, suiteId: selection.suiteId, files: selection.files } : null;
      if (!receipt) throw new Error('The fixture needs a batch, suite or final selection.');
      await f.db.update(testParts).set({ status: 'running', builtin: true, startedAt: new Date() }).where(eq(testParts.id, part.id));
      await partDone(f.ctx, BUILTIN, { type: 'tests.done', partId: part.id, ok: true, error: null, exitCode: 0, commit: finalCommit, log: 'Candidate check passed.', environmentReceipt: receipt });
    }
    await pumpTests(f.ctx);
    if (parts === 0) await f.db.delete(testParts).where(eq(testParts.runId, value.id));
    const [finished] = await f.db.update(testRuns).set({ commitSha: commit, parts: parts === 0 ? 0 : planned.length }).where(eq(testRuns.id, value.id)).returning();
    return finished!;
  };
  const verified = (ids: string[]) => ({ done: true, summary: 'Verified the final changed scope.', ...{ verification: { candidateId: snapshot.candidateId!, revision: snapshot.revision, runIds: ids } } });
  return { run, manualRun, verified, snapshot, finalCommit };
}

