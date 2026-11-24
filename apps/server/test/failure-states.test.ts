import { expect, it } from 'vitest';
import { jobs } from '../src/db/schema.js';
import { agentFailureState, agentFailureStates, type FailureState } from '../src/modules/tasks/failures.js';
import { failureCompany } from './failure-company.js';

it('keeps each agent failure, retry chain and obsolete time consistent in batch and single reads', async () => {
  const c = await failureCompany();
  const at = new Date('2026-10-20T10:00:00Z');
  const turn = { companyId: c.companyId, subscriptionId: c.sub.id, kind: 'conversation' as const, prompt: 'Work.', timeoutMs: 1000 };
  const firstFailure = { kind: 'overloaded' as const, retryable: true, text: 'Busy.' };
  const [first] = await c.db.insert(jobs).values({ ...turn, agentId: c.agent.id, status: 'failed', failure: firstFailure, createdAt: new Date(+at - 60000), finishedAt: new Date(+at - 60000) }).returning();
  const [second] = await c.db.insert(jobs).values({ ...turn, agentId: c.agent.id, status: 'failed', continueOf: first!.id, failure: { kind: 'network', retryable: true, text: 'Connection closed.' }, tail: 'Disconnected.', createdAt: at, finishedAt: at }).returning();
  await c.db.insert(jobs).values({ ...turn, agentId: c.agent.id, status: 'queued', continueOf: second!.id, notBefore: new Date(+at + 120000) });
  await c.db.insert(jobs).values({ ...turn, agentId: c.agent.id, status: 'obsolete', error: 'stale', createdAt: new Date(+at + 1) });
  await c.db.insert(jobs).values({ ...turn, agentId: c.head.id, status: 'failed', error: 'agent_failed', failure: { kind: 'refused', retryable: false, text: 'Refused.' }, createdAt: new Date(+at + 2), tail: 'No.' });
  await c.db.insert(jobs).values({ ...turn, agentId: c.watcher.id, status: 'done', failure: firstFailure, createdAt: new Date(+at + 3) });

  const expected = new Map<string, FailureState>([
    [c.agent.id, { retry: { attempt: 2, max: 4, at: +at + 120000, kind: 'network' }, failure: null, obsolete: { at: +at + 1 } }],
    [c.head.id, { retry: null, failure: { kind: 'refused', text: 'Refused.', at: +at + 2, tail: 'No.' }, obsolete: null }],
    [c.watcher.id, { retry: null, failure: null, obsolete: null }],
  ]);
  const ids = [c.agent.id, c.head.id, c.watcher.id];
  expect(await agentFailureStates(c.ctx, c.companyId, ids)).toEqual(expected);
  for (const id of ids) expect(await agentFailureState(c.ctx, id)).toEqual(expected.get(id));
  expect(await agentFailureStates(c.ctx, c.companyId, [])).toEqual(new Map());
});

it('counts a failed turn as a failure only when it needs a person: never while it goes on by itself, nor when a newer turn replaced it', async () => {
  const c = await failureCompany();
  const at = new Date('2026-11-23T10:42:00Z');
  const turn = { companyId: c.companyId, subscriptionId: c.sub.id, kind: 'conversation' as const, prompt: 'Work.', timeoutMs: 1000 };
  const failed = async (agentId: string, failure: { kind: 'overloaded' | 'usage_limit' | 'auth' | 'unknown'; retryable: boolean; text: string }, over: object = {}) =>
    (await c.db.insert(jobs).values({ ...turn, agentId, status: 'failed', failure, createdAt: at, finishedAt: at, ...over }).returning())[0]!;
  const overloaded = { kind: 'overloaded' as const, retryable: true, text: '529 Overloaded.' };
  /* The fourth retry failed too and none follows: the head and Operations are told, a real failure. */
  await failed(c.agent.id, overloaded);
  /* A usage limit holds the turn until it resets, then it goes on by itself. */
  const held = await failed(c.head.id, { kind: 'usage_limit', retryable: false, text: 'Limit reached.' });
  await c.db.insert(jobs).values({ ...turn, agentId: c.head.id, status: 'queued', continueOf: held.id });
  /* The task moved on while the turn ran, and a newer turn took its place. */
  await failed(c.watcher.id, { kind: 'unknown', retryable: false, text: 'Stale turn.' }, { error: 'stale' });
  const states = await agentFailureStates(c.ctx, c.companyId, [c.agent.id, c.head.id, c.watcher.id]);
  expect(states.get(c.agent.id)?.failure).toMatchObject({ kind: 'overloaded' });
  expect(states.get(c.head.id)?.failure).toBeNull();
  expect(states.get(c.watcher.id)?.failure).toBeNull();
  /* A turn that waits for its plan's owner to sign in needs that person, though its continuation is queued. */
  const signIn = await failed(c.watcher.id, { kind: 'auth', retryable: false, text: 'Not logged in.' }, { createdAt: new Date(+at + 1), finishedAt: new Date(+at + 1) });
  await c.db.insert(jobs).values({ ...turn, agentId: c.watcher.id, status: 'queued', continueOf: signIn.id });
  expect((await agentFailureState(c.ctx, c.watcher.id)).failure).toMatchObject({ kind: 'auth' });
});
