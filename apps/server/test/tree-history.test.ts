import { expect, it } from 'vitest';
import { agentEvents, agents, jobs } from '../src/db/schema.js';
import { readTurnHistory } from '../src/modules/tasks/tree-history.js';
import { setUpCompany, testApp } from './helpers.js';

it('reads only proven legacy alarms, recorded programs and failed program exits', async () => {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [agent] = await db.select().from(agents);
  const at = (clock: string) => new Date(`2026-11-03T${clock}:00.000Z`);
  const [job] = await db.insert(jobs).values({ companyId: agent!.companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id,
    kind: 'conversation', prompt: 'Work', timeoutMs: 3_600_000, status: 'running', createdAt: at('06:00'), startedAt: at('06:00') }).returning();
  const row = { companyId: agent!.companyId, agentId: agent!.id, createdAt: at('10:33') };
  await db.insert(agentEvents).values([
    { ...row, kind: 'message', data: { silentJob: job!.id, silentReason: 'node_silent', text: 'Last change: 06:11 (2026-11-03T06:11:06.000Z). Reason: node_silent.' } },
    { ...row, kind: 'message', data: { silentJob: job!.id, silentReason: 'node_silent', text: 'No last change recorded.' } },
    { ...row, kind: 'message', data: { silentJob: job!.id, silentReason: 'made_up', text: 'Last change: 06:11 (2026-11-03T06:11:06.000Z).' } },
    { ...row, kind: 'message', data: { silentJob: job!.id, silentReason: 'node_silent', text: 'Last change: unknown (invalid).' } },
    { ...row, jobId: job!.id, kind: 'failed', data: { reason: 'timeout' } },
    { ...row, jobId: job!.id, kind: 'program', data: { program: { state: 'made_up' }, alarm: null } },
    { ...row, jobId: job!.id, kind: 'failed', data: { program: { state: 'gone' } }, createdAt: at('10:34') },
    { ...row, jobId: job!.id, kind: 'program', data: { program: { state: 'thinking', since: at('10:35').getTime(), tool: null }, alarm: null }, createdAt: at('10:35') },
  ]);
  const turns = await readTurnHistory(db, agent!.companyId, [agent!.id], at('00:00'));
  expect(turns).toHaveLength(1);
  expect(turns[0]!.history).toEqual([
    { at: at('10:33'), program: null, alarm: { reason: 'node_silent', since: Date.parse('2026-11-03T06:11:06.000Z') } },
    { at: at('10:34'), program: { state: 'gone', since: at('10:34').getTime(), tool: null }, alarm: null },
    { at: at('10:35'), program: { state: 'thinking', since: at('10:35').getTime(), tool: null }, alarm: null },
  ]);
  expect(await readTurnHistory(db, agent!.companyId, [], at('00:00'))).toEqual([]);
  expect(await readTurnHistory(db, agent!.companyId, ['00000000-0000-4000-8000-000000000001'], at('00:00'))).toEqual([]);
});
