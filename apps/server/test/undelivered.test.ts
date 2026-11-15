import { describe, expect, it } from 'vitest';
import { messageNotDelivered, taskNamed, undeliveredLine } from '../src/modules/conversation/undelivered.js';

const BRUNO = '3e101124-2c20-4550-ae9a-2ecf1fe5b834';

describe('the line of a message that did not reach its employee', () => {
  it('names why, to whom and on which task', () => {
    expect(undeliveredLine({ reason: 'plan_at_limit', recipient: BRUNO, task: 12 })).toBe(`Not delivered: reason plan_at_limit, recipient ${BRUNO}, task #12.`);
  });

  it('says so of a message on no task', () => {
    expect(undeliveredLine({ reason: 'switched_off', recipient: BRUNO, task: null })).toBe(`Not delivered: reason switched_off, recipient ${BRUNO}, task none.`);
  });

  it('hides a credential and a private path in what the sender gave, wherever it sits', () => {
    const token = 'ghp_' + 'syntheticUndelivered'.repeat(2);
    const line = undeliveredLine({ reason: `task_unknown token=${token}`, recipient: '/home/fixture805/agent', task: token });
    for (const secret of [token, '/home/fixture805', 'fixture805']) expect(line).not.toContain(secret);
    expect(line).toBe('Not delivered: reason task_unknown token=[hidden], recipient [hidden], task [hidden].');
  });
});

describe('the task a sender named', () => {
  it('reads #12, 12 and " #12 " as task 12', () => {
    expect([taskNamed(12), taskNamed('12'), taskNamed(' #12 ')]).toEqual([12, 12, 12]);
  });

  it('keeps a task named by its id as it was named, and none when none was named', () => {
    expect([taskNamed(BRUNO), taskNamed(undefined), taskNamed(null)]).toEqual([BRUNO, null, null]);
  });

  it('keeps no credential that was given as a task', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    expect(taskNamed(token)).toBe('[hidden]');
  });
});

describe('the refusal of a message that did not reach its employee', () => {
  it('keeps the reason the screens know it by, and carries its code', () => {
    const error = messageNotDelivered('plan_at_limit');
    expect(error).toMatchObject({ status: 409, reason: 'agent_not_ready', details: { undelivered: 'plan_at_limit' } });
    expect(error.message).toBe('The message did not reach the employee. Check its window and try again.');
  });
});
