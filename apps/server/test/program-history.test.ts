import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, jobs } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { readTurnHistory } from '../src/modules/tasks/tree-history.js';
import { withPrograms } from '../src/modules/tasks/tree-programs.js';
import { checkSilentTurns, recordJobProgram } from '../src/modules/tasks/silent.js';
import { setUpCompany, testApp } from './helpers.js';

async function running() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [agent] = await db.select().from(agents);
  const start = new Date();
  const [job] = await db.insert(jobs).values({ companyId: agent!.companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id,
    kind: 'conversation', prompt: 'Work on checkout.', timeoutMs: 3_600_000, status: 'running', startedAt: start }).returning();
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  const history = () => db.select(only(agentEvents, 'data')).from(agentEvents)
    .where(and(eq(agentEvents.jobId, job!.id), eq(agentEvents.kind, 'program'))).orderBy(asc(agentEvents.seq));
  return { app, db, job: job!, at, history };
}

describe('turn program history', () => {
  it('keeps changes to since even when the state and tool stay the same, without terminal screens', async () => {
    const c = await running();
    const report = async (state: 'thinking' | 'tool' | 'idle' | 'gone', minute: number) => recordJobProgram(c.app.ctx, {
      type: 'job.program', jobId: c.job.id, state, since: c.at(minute).getTime(), screenAt: c.at(minute).getTime(),
      ...(state === 'tool' ? { tool: 'Bash' } : {}), screen: 'Private terminal text.',
    }, c.at(minute), eq(jobs.id, c.job.id));
    await report('thinking', 0);
    await report('thinking', 1);
    await report('tool', 2);
    await report('tool', 3);
    await report('idle', 4);
    await report('gone', 5);
    expect((await c.history()).map(e => e.data)).toEqual([
      { program: { state: 'thinking', since: c.at(0).getTime(), tool: null }, alarm: null },
      { program: { state: 'thinking', since: c.at(1).getTime(), tool: null }, alarm: null },
      { program: { state: 'tool', since: c.at(2).getTime(), tool: 'Bash' }, alarm: null },
      { program: { state: 'tool', since: c.at(3).getTime(), tool: 'Bash' }, alarm: null },
      { program: { state: 'idle', since: c.at(4).getTime(), tool: null }, alarm: null },
      { program: { state: 'gone', since: c.at(5).getTime(), tool: null }, alarm: null },
    ]);
  });

  it('keeps an alarm and its clearing once, even if the program state does not change', async () => {
    const c = await running();
    const report = async (minute: number) => recordJobProgram(c.app.ctx, {
      type: 'job.program', jobId: c.job.id, state: 'thinking', since: c.at(0).getTime(), screenAt: c.at(minute).getTime(),
    }, c.at(minute), eq(jobs.id, c.job.id));
    await report(0);
    await checkSilentTurns(c.app.ctx, c.at(31));
    await checkSilentTurns(c.app.ctx, c.at(32));
    await report(33);
    await checkSilentTurns(c.app.ctx, c.at(33));
    expect((await c.history()).map(e => (e.data as { alarm: unknown }).alarm)).toEqual([
      null, { reason: 'node_silent', since: c.at(0).getTime() }, null,
    ]);
  });
});

it('records Bash then Read once each and keeps both intervals when the persisted history reaches the tree', async () => {
  const c = await running();
  const report = async (tool: string, since: number, observed: number) => recordJobProgram(c.app.ctx, {
    type: 'job.program', jobId: c.job.id, state: 'tool', tool, since: c.at(since).getTime(),
    screenAt: c.at(observed).getTime(), screen: 'Private terminal text.',
  }, c.at(observed), eq(jobs.id, c.job.id));
  await report('Bash', 0, 0);
  await report('Read', 1, 1);
  await report('Read', 1, 2);
  expect((await c.history()).map(e => e.data)).toEqual([
    { program: { state: 'tool', tool: 'Bash', since: c.at(0).getTime() }, alarm: null },
    { program: { state: 'tool', tool: 'Read', since: c.at(1).getTime() }, alarm: null },
  ]);
  const history = (await readTurnHistory(c.db, c.job.companyId, [c.job.agentId!], c.at(0))).find(t => t.id === c.job.id)!;
  const segments = withPrograms([{ kind: 'unknown', from: c.at(0).toISOString(), to: null }], [history], { id: c.job.agentId!, name: 'Demo' }, c.at(3));
  expect(segments).toEqual([
    { kind: 'work', from: c.at(0).toISOString(), to: c.at(1).toISOString(), program: { state: 'tool', tool: 'Bash', since: c.at(0).getTime() } },
    { kind: 'work', from: c.at(1).toISOString(), to: null, program: { state: 'tool', tool: 'Read', since: c.at(1).getTime() } },
  ]);
});

it('records a new tool even when its state and since are unchanged', async () => {
  const c = await running();
  for (const tool of ['Bash', 'Read', 'Read']) {
    await recordJobProgram(c.app.ctx, { type: 'job.program', jobId: c.job.id, state: 'tool', tool,
      since: c.at(0).getTime(), screenAt: c.at(0).getTime() }, c.at(0), eq(jobs.id, c.job.id));
  }
  expect((await c.history()).map(e => (e.data as { program: { tool: string } }).program.tool)).toEqual(['Bash', 'Read']);
});

it('still reduces six reports to four points when two reports repeat the same state, tool and since', async () => {
  const c = await running();
  for (const [state, since, observed] of [
    ['thinking', 0, 0], ['thinking', 0, 1], ['tool', 2, 2], ['tool', 2, 3], ['idle', 4, 4], ['gone', 5, 5],
  ] as const) {
    await recordJobProgram(c.app.ctx, { type: 'job.program', jobId: c.job.id, state,
      ...(state === 'tool' ? { tool: 'Bash' } : {}), since: c.at(since).getTime(), screenAt: c.at(observed).getTime(),
      screen: 'Private terminal text.',
    }, c.at(observed), eq(jobs.id, c.job.id));
  }
  expect((await c.history()).map(e => e.data)).toEqual([
    { program: { state: 'thinking', since: c.at(0).getTime(), tool: null }, alarm: null },
    { program: { state: 'tool', since: c.at(2).getTime(), tool: 'Bash' }, alarm: null },
    { program: { state: 'idle', since: c.at(4).getTime(), tool: null }, alarm: null },
    { program: { state: 'gone', since: c.at(5).getTime(), tool: null }, alarm: null },
  ]);
});
