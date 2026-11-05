import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents, testParts, testRuns } from '../src/db/schema.js';
import { AuthorCheckInput, recordAuthorCheck } from '../src/modules/tasks/review-quality.js';
import { SHA, OTHER, qualityFixture } from './review-quality-fixture.js';

describe('the consumer of author-check records from task 325', () => {
  it('reports missing quality numbers as unavailable, separate from review lifecycle counts', async () => {
    const f = await qualityFixture();
    expect(await f.read()).toMatchObject({ quality: { status: 'unavailable', reason: 'author-check-record-unavailable', record: null }, gateCounts: { source: 'review-lifecycle' } });
  });

  it('delivers exact run/SHA/scope/stages and numbers from a server record, keeping dryer flags informational', async () => {
    const f = await qualityFixture();
    await f.seed();
    const { quality } = await f.read();
    expect(quality).toMatchObject({ status: 'passed', sourceEventId: expect.any(Number), record: f.record });
  });

  it('ignores arbitrary agent JSON posing as an author-check result', async () => {
    const f = await qualityFixture();
    await f.seed(f.record, f.author.id);
    expect((await f.read()).quality).toMatchObject({ status: 'unavailable', record: null });
  });

  it('does not accept numbers bound to another SHA', async () => {
    const f = await qualityFixture();
    await f.seed({ ...f.record, checkCommit: OTHER });
    expect((await f.read()).quality).toMatchObject({ status: 'unavailable', record: null });
  });

  it.each(['failed', 'stopped'] as const)('keeps a %s run from becoming a successful quality stage', async status => {
    const f = await qualityFixture();
    await f.db.update(testRuns).set({ status }).where(eq(testRuns.id, f.run.id));
    await f.seed();
    expect((await f.read()).quality.status).toBe(status === 'failed' ? 'failed' : 'cancelled');
  });

  it('keeps missing coverage null and partial rather than manufacturing zero or PASS', async () => {
    const f = await qualityFixture();
    const record = { ...f.record, numbers: { ...f.record.numbers, changedLines: null } };
    await f.seed(record);
    expect((await f.read()).quality).toMatchObject({ status: 'partial', record: { numbers: { changedLines: null } } });
  });

  it('writes one immutable server record through the producer port and deduplicates retries', async () => {
    const f = await qualityFixture();
    const input = AuthorCheckInput.parse({ version: f.record.version, runId: f.run.id, submissionCommit: SHA, checkCommit: SHA, scope: f.record.scope, stages: f.record.stages, numbers: f.record.numbers });
    await recordAuthorCheck(f.db, f.task.id, input);
    await recordAuthorCheck(f.db, f.task.id, input);
    const records = (await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).filter(e => e.data.authorCheck);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ agentId: null, personId: null, data: { authorCheck: { producer: 'author-check-v1', authorId: f.author.id, jobId: f.job.id } } });
    expect((await f.read()).quality.status).toBe('passed');
  });

  it.each(['companyId', 'taskId', 'authorId', 'jobId'] as const)('rejects a quality record with foreign %s provenance', async field => {
    const f = await qualityFixture();
    await f.seed({ ...f.record, [field]: '00000000-0000-4000-8000-000000000000' });
    expect((await f.read()).quality).toMatchObject({ status: 'unavailable', record: null });
  });

  it('does not count a missing stage as a passed author check', async () => {
    const f = await qualityFixture();
    await f.seed({ ...f.record, stages: f.record.stages.filter(stage => stage.name !== 'types') });
    expect((await f.read()).quality.status).toBe('partial');
  });

  it('enforces the CRAP threshold even if the producer mislabeled the phase passed', async () => {
    const f = await qualityFixture();
    await f.seed({ ...f.record, numbers: { ...f.record.numbers, worstCrap: 10 } });
    expect((await f.read()).quality.status).toBe('failed');
  });

  it('does not fall back to an older PASS after a newer receipt changed', async () => {
    const f = await qualityFixture();
    await f.seed();
    const [next] = await f.db.insert(testRuns).values({ ...f.run, id: undefined, number: 2, status: 'running', finishedAt: null }).returning();
    const [part] = await f.db.insert(testParts).values({ companyId: f.author.companyId, runId: next!.id, part: 1, status: 'passed', commit: SHA, exitCode: 0 }).returning();
    const input = AuthorCheckInput.parse({ version: 1, runId: next!.id, submissionCommit: SHA, checkCommit: SHA, scope: f.record.scope, stages: f.record.stages.map(stage => ({ ...stage, partId: part!.id })), numbers: f.record.numbers });
    await recordAuthorCheck(f.db, f.task.id, input);
    await f.db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, next!.id));
    expect((await f.read()).quality).toMatchObject({ status: 'unavailable', reason: 'author-check-provenance-changed', record: null });
  });
});
