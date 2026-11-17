import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents } from '../src/db/schema.js';
import { submit, updateTask } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

async function receipt(f: Awaited<ReturnType<typeof fixture>>, task = f.task, options: { paths?: string[]; commit?: string; crap?: number | null; reason?: string | null; exitCode?: number } = {}) {
  const request = { type: 'author_check.run', requestId: randomUUID(), jobId: randomUUID(), agentId: f.author.id, taskId: task.id,
    repoUrl: 'https://github.com/acme/shop.git', branch: 'task-1', baseCommit: BASE, commit: options.commit ?? HEAD, paths: options.paths ?? ['logic/totals.ts'] };
  const node = 'node-for-author';
  const revision = (await f.detail(task.id)).echelons.revision;
  await f.db.insert(taskEvents).values({ uuid: request.requestId, companyId: task.companyId, taskId: task.id, kind: 'comment', agentId: f.author.id,
    data: { authorCheckRequest: request, node, routeRevision: revision } });
  const [event] = await f.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'comment',
    data: { authorCheck: { ...request, type: 'author_check.done', exitCode: options.exitCode ?? 0,
      crap: options.crap === null ? { kind: 'no_functions' } : { kind: 'measured', max: options.crap ?? 2 }, reason: options.reason ?? null,
      startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:01.000Z' }, node, routeRevision: revision } }).returning();
  return event!.uuid;
}

describe('Review shortcuts require a server-owned author receipt', () => {
  it('skips Review for a small change, records the receipt and preserves the candidate revision', async () => {
    const f = await fixture();
    const id = await receipt(f);
    const moved = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Totals.', evidence: 'Local checks.', review: { baseCommit: BASE } });
    expect(moved.task.assigneeAgentId).toBe(f.tester.id);
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({ stage: 'tests', revision: 2, stages: expect.arrayContaining([
      expect.objectContaining({ stage: 'review', status: 'skipped', reason: 'author_check_passed' }),
    ]) });
    const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id));
    expect(events.find(event => event.kind === 'submitted')?.data.authorCheckSkip).toEqual({ reason: 'author_check_passed', receiptId: id });
  });

  it.each(['docs/architecture.md', 'guide/install.md', 'README.md'])('skips Review only for a Markdown delta outside source and tests: %s', async path => {
    const f = await fixture({ small: false });
    const { task } = await f.create({ small: false, paths: [path] });
    f.atCommit(HEAD, [path]);
    await receipt(f, task, { crap: null, paths: [path] });
    const moved = await submit(f.ctx, f.author.id, task.id, { summary: 'Document.', evidence: 'Checked.', review: { baseCommit: BASE } });
    expect(moved.task.assigneeAgentId).toBe(f.tester.id);
  });

  it.each(['apps/server/src/logic.md', 'docs/test/guide.md', 'docs/thing.test.md', 'docs/readme.txt', 'logic/totals.ts'])('keeps Review for an ineligible delta %s', async path => {
    const f = await fixture({ small: false });
    const { task } = await f.create({ small: false, paths: [path] });
    f.atCommit(HEAD, [path]);
    await receipt(f, task, { paths: [path] });
    expect((await submit(f.ctx, f.author.id, task.id, { summary: 'Change.', evidence: 'clean cherry-pick', review: { baseCommit: BASE } })).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it.each([{ crap: 10 }, { crap: 12 }, { crap: null }, { commit: 'c'.repeat(40) }, { reason: 'dirty_tree' }, { exitCode: 1 }])('keeps Review for an unusable receipt %j', async options => {
    const f = await fixture();
    await receipt(f, f.task, options);
    expect((await submit(f.ctx, f.author.id, f.task.id, { summary: 'Change.', evidence: 'passed', review: { baseCommit: BASE } })).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it('does not use an already recorded check after its route revision changes', async () => {
    const f = await fixture();
    await receipt(f);
    await updateTask(f.ctx, f.head.id, f.task.id, { riskClass: 'data' });
    expect((await submit(f.ctx, f.author.id, f.task.id, { summary: 'Change.', evidence: 'checked', review: { baseCommit: BASE } })).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it('does not reuse a green SHA against a different base', async () => {
    const f = await fixture();
    await receipt(f);
    expect((await submit(f.ctx, f.author.id, f.task.id, { summary: 'Change.', evidence: 'checked', review: { baseCommit: 'c'.repeat(40) } })).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it('keeps Review when the author only claims a green JSON result', async () => {
    const f = await fixture();
    expect((await submit(f.ctx, f.author.id, f.task.id, { summary: 'Change.', evidence: JSON.stringify({ exitCode: 0, crap: 2, checkCommit: HEAD }), review: { baseCommit: BASE } })).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it.each(['security', 'access', 'money', 'data'] as const)('skips Review but keeps Security for a %s risk', async riskClass => {
    const f = await fixture();
    const { task } = await f.create({ riskClass });
    await receipt(f, task);
    expect((await submit(f.ctx, f.author.id, task.id, { summary: 'Change.', evidence: 'checked', review: { baseCommit: BASE } })).task.assigneeAgentId).toBe(f.security.id);
    expect((await f.detail(task.id)).echelons.security.required).toBe(true);
  });
});
