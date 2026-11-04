import { expect, it } from 'vitest';
import { agents, tasks } from '../src/db/schema.js';
import type { Wake } from '../src/modules/tasks/engine.js';
import { recordCause } from '../src/modules/tasks/notification-cause.js';
import { setUpCompany, testApp } from './helpers.js';

async function exampleTask() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [agent] = await db.select().from(agents);
  const [task] = await db.insert(tasks).values({ companyId: agent!.companyId, number: 1, title: 'Release', assigneeAgentId: agent!.id }).returning();
  return task!;
}

type Note = Omit<Parameters<typeof recordCause>[1], 'actor'>;

it('keeps the recorded decision and never turns ordinary action text into a report', async () => {
  const task = await exampleTask();
  const actor = { agentId: task.assigneeAgentId! };
  const cases: { note: Note; action: string; report?: string }[] = [
    { note: { kind: 'answered', data: { status: 'approved', commit: 'aaaa' } }, action: 'approved aaaa' },
    { note: { kind: 'answered', data: { status: 'declined', commit: 'bbbb' } }, action: 'declined bbbb' },
    { note: { kind: 'answered', data: { status: 'answered' } }, action: 'answered' },
    { note: { kind: 'answered' }, action: 'answered' },
    { note: { kind: 'verdict', data: { pass: false } }, action: 'returned work' },
    { note: { kind: 'verdict', data: { pass: true } }, action: 'reviewed work' },
    { note: { kind: 'verdict' }, action: 'reviewed work' },
    { note: { kind: 'report', data: { done: false } }, action: 'reported blocked work' },
    { note: { kind: 'report', data: { done: true } }, action: 'reported work done' },
    { note: { kind: 'report' }, action: 'reported work done' },
    { note: { kind: 'submitted' }, action: 'handed in work' },
    { note: { kind: 'submitted', text: '  Release verified.  ' }, action: 'handed in work', report: 'Release verified.' },
    { note: { kind: 'created', text: 'Task instructions.' }, action: 'assigned work' },
    { note: { kind: 'comment', text: 'A person commented.' }, action: 'commented' },
  ];
  for (const { note, action, report } of cases) {
    const wakes: Wake[] = [{ agentId: actor.agentId, taskId: task.id, why: 'comment' }];
    recordCause(wakes, { ...note, actor }, 101, task);
    expect(wakes[0]!.cause, JSON.stringify(note)).toEqual({ eventId: 101, task: { id: task.id, number: 1 }, actor, action, report });
  }
});

it('names a wait setter only when both the saved wait and its setter are known', async () => {
  const task = await exampleTask();
  const actor = { agentId: task.assigneeAgentId! };
  const wait = { reason: 'Build', since: '2026-11-04T14:00:00Z', until: '2026-11-04T15:00:00Z' };
  for (const row of [task, { ...task, externalWait: wait, assigneeAgentId: null }]) {
    const wakes: Wake[] = [{ agentId: actor.agentId, taskId: task.id, why: 'wait_ended' }];
    recordCause(wakes, { kind: 'continued', actor }, 102, row);
    expect(wakes[0]!.cause).toBeUndefined();
  }
  const wakes: Wake[] = [{ agentId: actor.agentId, taskId: task.id, why: 'wait_ended' }];
  recordCause(wakes, { kind: 'continued', actor }, 102, { ...task, externalWait: wait });
  expect(wakes[0]!.cause).toEqual({ eventId: 102, task: { id: task.id, number: 1 }, wait: { setter: actor.agentId, until: wait.until } });
});

it('preserves an earlier cause and keeps automatic notices separate from action authors', async () => {
  const task = await exampleTask();
  const actor = { agentId: task.assigneeAgentId! };
  const existing = { eventId: 99, source: 'work' as const };
  const wakes: Wake[] = [{ agentId: actor.agentId, taskId: task.id, why: 'comment', cause: existing }];
  recordCause(wakes, { kind: 'comment', actor, text: 'A newer comment.' }, 103, task);
  expect(wakes[0]!.cause).toEqual({ eventId: 99, source: 'work' });
  const automatic: Wake[] = [{ agentId: actor.agentId, taskId: task.id, why: 'go_on' }];
  recordCause(automatic, { kind: 'comment', actor }, 104, task);
  expect(automatic[0]!.cause).toBeUndefined();
  recordCause(automatic, { kind: 'comment', actor, automatic: 'failure' }, 105, task);
  expect(automatic[0]!.cause).toEqual({ eventId: 105, task: { id: task.id, number: 1 }, source: 'failure' });
  const quiet: Wake[] = [{ agentId: actor.agentId, taskId: task.id, why: 'comment' }];
  recordCause(quiet, { kind: 'started', actor }, 106, task);
  expect(quiet[0]!.cause).toBeUndefined();
});
