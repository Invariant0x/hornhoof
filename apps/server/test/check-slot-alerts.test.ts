import { randomUUID } from 'node:crypto';
import { CHECK_LEASE_MS } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { agentInbox, tasks, testParts, testPartTimings, testRuns } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { checkQueueLoad, checkQueueSnapshot } from '../src/modules/nodes/check-slots.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { checkSilentTurns } from '../src/modules/tasks/silent.js';
import { newEnvironmentRequest, repositoryScope } from '../src/modules/testruns/describe.js';
import { BUILTIN } from './builtin.js';
import { failureCompany } from './failure-company.js';

it.each(['part', 'description'] as const)('tells the head of Operations and the run owner who holds the slot for a slow %s wait', async kind => {
  const c = await failureCompany();
  const ops = await c.hire('Clara', 'head', 'OPS-HEAD', c.ops.id);
  const jobId = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Run tests', createdBy: null });
  const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checks', departmentId: c.dev.id, assigneeAgentId: c.agent.id }).returning();
  const scope = repositoryScope(c.companyId, c.dev.id, 'https://example.test/repo');
  const requestId = randomUUID();
  const environmentRequest = { ...newEnvironmentRequest(scope, { mode: 'product', suite: 'server' }), requestId, builtin: true };
  const base = { companyId: c.companyId, taskId: task!.id, agentId: c.agent.id, departmentId: c.dev.id, jobId, command: 'npm test', timeoutMs: 60_000 };
  const [past, holder, waiting] = await c.db.insert(testRuns).values([
    { ...base, number: 1, status: 'passed', environmentRequest },
    { ...base, number: 2, status: 'running' },
    { ...base, number: 3, status: 'running', environmentRequest },
  ]).returning();
  const selection = { selection: { kind: 'suite' as const, suiteId: 'server', files: ['test/one.ts'] }, after: [] };
  const partBase = { companyId: c.companyId, part: 1, builtin: true, machineName: 'home-api' };
  const [measured, running] = await c.db.insert(testParts).values([
    { ...partBase, runId: past!.id, status: 'passed', environmentSelection: selection },
    { ...partBase, runId: holder!.id, status: 'running' },
  ]).returning();
  const current = kind === 'part' ? (await c.db.insert(testParts).values({ ...partBase, runId: waiting!.id, status: 'running', environmentSelection: selection }).returning())[0] : null;
  const measuredFile = { package: '.', file: 'test/one.ts', totalMs: 2000, setupMs: null, testsMs: null, teardownMs: null, slowest: [] };
  const files = kind === 'part' ? [measuredFile, { ...measuredFile, file: 'test/other.ts', totalMs: 8000 }] : [measuredFile];
  await c.db.insert(testPartTimings).values({ companyId: c.companyId, partId: measured!.id, runId: past!.id, files });
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => { vi.useRealTimers(); });
  vi.spyOn(c.ctx.hub, 'loadOf').mockImplementation(() => ({ cpus: 1, load: 0, tests: 0, jobs: 0, memFree: 1e9, memTotal: 2e9, at: Date.now() }));
  await checkQueueLoad(c.ctx, BUILTIN);
  vi.setSystemTime(Date.now() + CHECK_LEASE_MS);
  await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.acquire', id: randomUUID(), label: `Run part ${running!.id}` });
  const claim = randomUUID();
  await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.acquire', id: claim, label: current ? `Run part ${current.id}` : `Describe product test environment ${requestId}` });
  const queued = Date.now();
  const letters = () => c.db.select().from(agentInbox).where(eq(agentInbox.source, 'check_slot_wait'));
  await checkSilentTurns(c.ctx, new Date(queued + 2000));
  expect(await letters()).toEqual([]);
  await checkSilentTurns(c.ctx, new Date(queued + 2001));
  await checkSilentTurns(c.ctx, new Date(queued + 2002));
  const notices = await letters();
  expect(notices.map(letter => letter.agentId).sort()).toEqual([ops.id, c.agent.id].sort());
  for (const notice of notices) expect(notice.text).toContain('Test run 2, part 1');
  expect(checkQueueSnapshot(c.ctx, BUILTIN)?.queue.map(entry => entry.request.id)).toEqual([claim]);
});
