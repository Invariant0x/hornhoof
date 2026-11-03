import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, jobs } from '../src/db/schema.js';
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
  const history = () => db.select({ data: agentEvents.data }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, job!.id), eq(agentEvents.kind, 'program'))).orderBy(asc(agentEvents.seq));
  return { app, db, job: job!, at, history };
}

describe('turn program history', () => {
  it('keeps state changes once without repeated reports or terminal screens', async () => {
    const c = await running();
    const report = async (state: 'thinking' | 'tool' | 'idle' | 'gone', minute: number) => recordJobProgram(c.app.ctx, {
      type: 'job.program', jobId: c.job.id, state, since: c.at(minute).getTime(), screenAt: c.at(minute).getTime(),
      tool: state === 'tool' ? 'Bash' : null, screen: 'Private terminal text.',
    }, c.at(minute), eq(jobs.id, c.job.id));
    await report('thinking', 0);
    await report('thinking', 1);
    await report('tool', 2);
    await report('tool', 3);
    await report('idle', 4);
    await report('gone', 5);
    expect((await c.history()).map(e => e.data)).toEqual([
      { program: { state: 'thinking', since: c.at(0).getTime(), tool: null }, alarm: null },
      { program: { state: 'tool', since: c.at(2).getTime(), tool: 'Bash' }, alarm: null },
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
