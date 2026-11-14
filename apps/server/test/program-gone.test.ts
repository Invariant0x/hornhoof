import { PROGRAM_SCREEN_MAX } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs } from '../src/db/schema.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { as, setUpCompany, testApp } from './helpers.js';

async function runningTurn() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [job] = await db.insert(jobs).values({ companyId: agent!.companyId, agentId: agent!.id, subscriptionId: agent!.subscriptionId!, kind: 'conversation', prompt: 'Inspect the build.', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
  const failedEvent = async () => {
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.done', jobId: job!.id, ok: false, sessionId: null, result: '', tail: '', error: 'agent_failed' });
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.status).toBe('failed');
    const res = await app.inject({ url: `/api/agents/${agent!.id}/events`, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    return res.json().events.find((e: { kind: string; jobId: string }) => e.kind === 'failed' && e.jobId === job!.id);
  };
  const gone = (details: { exitCode?: number | null; signal?: string | null; screen?: string } = {}) =>
    handleNodeMessage(app.ctx, BUILTIN, { type: 'job.program', jobId: job!.id, state: 'gone', since: Date.now(), screenAt: Date.now(), ...details });
  return { app, db, agent: agent!, job: job!, ceo, gone, failedEvent };
}

describe('the journal of a failed turn whose program is gone', () => {
  it.each([0, 17])('keeps exit code %i, signal and last screen from job.program', async exitCode => {
    const c = await runningTurn();
    await c.gone({ exitCode, signal: 'SIGTERM', screen: 'The build failed.\n> ' });
    expect((await c.db.select().from(jobs).where(eq(jobs.id, c.job.id)))[0]!.status).toBe('running');
    const event = await c.failedEvent();
    expect(event.data).toMatchObject({ error: 'agent_failed', program: { state: 'gone', exitCode, signal: 'SIGTERM', screen: 'The build failed.\n> ' } });
    expect(event.data.text).toContain(`Exit code: ${exitCode}`);
    expect(event.data.text).toContain('Signal: SIGTERM');
    expect(event.data.text).toContain('The build failed.');
    /* Repeated completion does not lose or duplicate the journal entry. */
    expect(await c.failedEvent()).toEqual(event);
  });

  it.each([{}, { exitCode: null, signal: null, screen: '' }])('says no data when the gone report has empty details: %j', async details => {
    const c = await runningTurn();
    await c.gone(details);
    const event = await c.failedEvent();
    expect(event.data).toMatchObject({ error: 'agent_failed', program: { state: 'gone', exitCode: null, signal: null, screen: null } });
    expect(event.data.text).toContain('Exit code: no data');
    expect(event.data.text).toContain('Signal: no data');
    expect(event.data.text).toContain('Last screen:\nno data');
  });

  it('bounds the journal screen by the protocol limit, keeping its end', async () => {
    const c = await runningTurn();
    const kept = 's'.repeat(PROGRAM_SCREEN_MAX - 4) + 'TAIL';
    await c.gone({ screen: 'Old screen before the limit.' + kept });
    const event = await c.failedEvent();
    expect(event.data.program.screen).toBe(kept);
    expect(event.data.text).not.toContain('Old screen before the limit.');
  });

  it('keeps ordinary failures unchanged when no gone report arrived', async () => {
    const c = await runningTurn();
    expect((await c.failedEvent()).data).toEqual({ error: 'agent_failed' });
  });

  it('ignores gone details from a node that does not own the turn', async () => {
    const c = await runningTurn();
    await handleNodeMessage(c.app.ctx, { kind: 'node', nodeId: '00000000-0000-4000-8000-000000000000' }, { type: 'job.program', jobId: c.job.id, state: 'gone', since: Date.now(), screenAt: Date.now(), exitCode: 17, signal: 'SIGTERM', screen: 'Another node.' });
    expect((await c.failedEvent()).data).toEqual({ error: 'agent_failed' });
  });
});
