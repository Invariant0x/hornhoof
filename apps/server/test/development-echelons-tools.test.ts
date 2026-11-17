import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { eq } from 'drizzle-orm';
import { agents, jobs, pipelineStages, tasks, teams } from '../src/db/schema.js';
import { loadTask, submit } from '../src/modules/tasks/engine.js';
import { createPipeline } from '../src/modules/tracker/pipelines.js';
import { listen, mcp } from './helpers.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

async function client(f: Awaited<ReturnType<typeof fixture>>, actor = f.author, taskId = f.task.id) {
  if (!f.app.server.listening) await listen(f.app);
  const token = `echelon-tools-${actor.id}-0123456789abcdef`;
  await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: actor.id, subscriptionId: actor.subscriptionId!, taskId, kind: 'conversation', prompt: 'Use the assigned stage', status: 'running', timeoutMs: 1000, toolTokenHash: hashToken(token) });
  const api = await mcp(f.app, token);
  return { call: (name: string, args: Record<string, unknown>) => api.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }> }; 
}

describe('the echelon public tools', () => {
  it('assigns only the named future stage through update_task and reports an ineligible checker', async () => {
    const f = await fixture();
    const next = await f.hire('Next reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const tools = await client(f, f.head);
    const assigned = await tools.call('update_task', { task: f.task.number, echelonStage: 'review', ownerAgentId: next.id });
    expect(assigned.isError).not.toBe(true);
    expect((await loadTask(f.db, f.task.id)).assigneeAgentId).toBe(f.author.id);
    expect((await f.detail()).echelons.stages.find(step => step.stage === 'review')?.ownerAgentId).toBe(next.id);
    const rejected = await tools.call('update_task', { task: f.task.number, echelonStage: 'review', ownerAgentId: f.author.id });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]!.text).toContain('cannot check its own result');
    expect((await f.detail()).echelons.stages.find(step => step.stage === 'review')?.ownerAgentId).toBe(next.id);
  });
  it("keeps the tracker's pipeline stage apart from the future echelon stage in one update_task call", async () => {
    const f = await fixture();
    const next = await f.hire('Next reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const pipe = await createPipeline(f.ctx, f.task.companyId, { agentId: f.head.id }, async () => {}, f.task.departmentId, { name: 'Releases', why: '', stages: [
      { key: 'build', parent: null, name: 'Build', ownerRole: 'DEV-BE' },
      { key: 'check', parent: 'build', name: 'Check', ownerRole: 'DEV-HEAD' },
    ] });
    const stageNamed = async (name: string) => (await f.db.select().from(pipelineStages).where(eq(pipelineStages.name, name)))[0]!;
    const [build, check] = [await stageNamed('Build'), await stageNamed('Check')];
    await f.db.update(tasks).set({ pipelineId: pipe.id, pipelineStageId: build.id }).where(eq(tasks.id, f.task.id));
    const tools = await client(f, f.head);
    const res = await tools.call('update_task', { task: f.task.number, echelonStage: 'review', ownerAgentId: next.id, stage: check.id });
    expect(res.isError, res.content[0]?.text).not.toBe(true);
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ assigneeAgentId: f.author.id, pipelineStageId: check.id });
    expect((await f.detail()).echelons.stages.find(step => step.stage === 'review')?.ownerAgentId).toBe(next.id);
  });
  it('accepts architectAgentId through create_task and names the actual Architecture owner', async () => {
    const f = await fixture();
    const architect = await f.hire('Architect', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    const tools = await client(f, f.head);
    const result = await tools.call('create_task', {
      title: 'Plan totals separately', brief: 'Keep totals', body: 'Plan before implementation',
      executor: f.author.id, architectAgentId: architect.id, resultKind: 'code', small: false, paths: ['logic/totals.ts'],
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('for Architect.');
    const rows = JSON.parse((await tools.call('tasks', {})).content[0]!.text);
    const task = rows.find((row: { title: string }) => row.title === 'Plan totals separately');
    expect(task.echelons).toMatchObject({
      stage: 'architecture', ownerAgentId: architect.id,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'architecture', status: 'active', ownerAgentId: architect.id }),
        expect.objectContaining({ stage: 'development', status: 'pending', ownerAgentId: f.author.id }),
      ]),
    });
  });
  it('lets the assigned worker hand Architecture forward through report', async () => {
    const f = await fixture({ small: false });
    const architect = await f.hire('Architect', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    const { task } = await f.create({ small: false, architectAgentId: architect.id, assigneeAgentId: f.author.id });
    const tools = await client(f, architect, task.id);
    const result = await tools.call('report', { task: task.number, done: true, summary: 'Change logic/totals.ts and prove the boundary.' });
    expect(result.isError).not.toBe(true);
    expect((await f.detail(task.id)).echelons.stage).toBe('development');
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
