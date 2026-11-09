import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { eq } from 'drizzle-orm';
import { agents, jobs, teams } from '../src/db/schema.js';
import { loadTask, submit } from '../src/modules/tasks/engine.js';
import { listen, mcp } from './helpers.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

async function client(f: Awaited<ReturnType<typeof fixture>>, actor = f.author) {
  if (!f.app.server.listening) await listen(f.app);
  const token = `echelon-tools-${actor.id}-0123456789abcdef`;
  await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: actor.id, subscriptionId: actor.subscriptionId!, taskId: f.task.id, kind: 'conversation', prompt: 'Use the assigned stage', status: 'running', timeoutMs: 1000, toolTokenHash: hashToken(token) });
  const api = await mcp(f.app, token);
  return { call: (name: string, args: Record<string, unknown>) => api.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }> }; 
}

describe('the echelon public tools', () => {
  it('lets the assigned worker hand Architecture forward through report', async () => {
    const f = await fixture({ small: false });
    const tools = await client(f);
    const result = await tools.call('report', { task: f.task.number, done: true, summary: 'Change logic/totals.ts and prove the boundary.' });
    expect(result.isError).not.toBe(true);
    expect((await f.detail()).echelons.stage).toBe('development');
  });
  it('carries the reviewer risk addition through verdict', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Totals', evidence: 'Checked', review: { baseCommit: BASE } });
    const tools = await client(f, f.reviewer);
    const result = await tools.call('verdict', { task: f.task.number, pass: true, comment: 'Review found external input.', reviewedCommit: HEAD, security: 'External input affects totals.' });
    expect(result.isError).not.toBe(true);
    expect((await loadTask(f.db, f.task.id)).assigneeAgentId).toBe(f.security.id);
  });
  it('creates a required code route with optional Cleanup and explicit path scope', async () => {
    const f = await fixture();
    const tools = await client(f, f.head);
    const result = await tools.call('create_task', { title: 'Refactor totals', brief: 'Keep totals', body: 'Use the same behavior', executor: f.author.id, resultKind: 'code', small: true, cleanup: true, paths: ['logic/totals.ts'], reviewerAgentId: f.reviewer.id, testsAgentId: f.tester.id });
    expect(result.isError).not.toBe(true);
    const created = await tools.call('tasks', {});
    const rows = JSON.parse(created.content[0]!.text);
    const task = rows.find((row: { title: string }) => row.title === 'Refactor totals');
    expect(task.echelons).toMatchObject({ resultKind: 'code', stage: 'development', stages: expect.arrayContaining([expect.objectContaining({ stage: 'cleanup', status: 'pending' })]) });
  });
  it('gives a member of a turnkey team its task with no echelons and no paths to keep to', async () => {
    const f = await fixture();
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
    const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
    const tools = await client(f, f.head);
    const result = await tools.call('create_task', { title: 'Speed up totals', brief: 'Totals in a millisecond.', body: 'Do it end to end.', executor: player.id });
    expect(result.isError).not.toBe(true);
    const rows = JSON.parse((await tools.call('tasks', {})).content[0]!.text);
    expect(rows.find((row: { title: string }) => row.title === 'Speed up totals').echelons).toMatchObject({ resultKind: 'turnkey', stages: [] });
  });
});
