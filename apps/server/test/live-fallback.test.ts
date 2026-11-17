import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, turns } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { failureCompany } from './failure-company.js';

describe('messages a busy program could not take live', () => {
  it.each([{ count: 2, newRound: true }, { count: 3, newRound: true }])('delivers $count missed messages once in the same session, new company round: $newRound', async ({ count, newRound }) => {
    const c = await failureCompany();
    c.sent.mockImplementation((node, message) => {
      if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, message.ref, false));
      return true;
    });
    const turn = (prompt: string) => ({ companyId: c.companyId, agentId: c.agent.id, prompt, createdBy: null });
    const first = await enqueueTurn(c.ctx, turn('Original work.'));
    if (newRound) {
      await c.db.update(jobs).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(jobs.id, first));
      await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 1, goal: 'Continue the work.', status: 'open', openedAt: new Date() });
    }
    const texts = ['Two paragraphs.\n\nKeep working.', 'Task #226 needs an answer.', 'Here is the answer.\nUse it now.'].slice(0, count);
    const waiting: string[] = [];
    for (const text of texts) waiting.push(await enqueueTurn(c.ctx, { ...turn(text), message: { personId: null, text, from: 'agent', by: c.head.id, name: c.head.name } }));
    expect(new Set(waiting).size).toBe(count);
    expect((await c.turnsOf()).filter(j => j.status === 'queued').map(j => j.id)).toEqual(waiting);
    for (const jobId of [first, ...waiting]) {
      await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId, ok: true, sessionId: 'kept-session', result: 'Done.', tail: '', error: null });
    }
    const sends = c.sent.mock.calls.map(([, message]) => message).filter(message => message.type === 'job.run');
    /* The messages that waited go out together in the turn after the first, each of them once. */
    expect(sends.map(message => message.jobId)).toEqual([first, waiting[0]]);
    expect(sends[1]!.sessionId).toBe('kept-session');
    for (const text of texts) expect(sends[1]!.prompt.split(text)).toHaveLength(2);
    expect((await c.turnsOf()).every(j => j.status === 'done')).toBe(true);
  });
});
