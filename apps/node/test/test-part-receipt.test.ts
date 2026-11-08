import type { NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { NodeTestMessages } from '../src/test-environment.js';

type TestsRun = Extract<ServerMessage, { type: 'tests.run' }>;

const partId = '11111111-1111-4111-8111-111111111111';
const part: TestsRun = { type: 'tests.run', partId, repo: null, branch: null, task: 1, command: 'make test', part: 1, parts: 1, timeoutMs: 60_000 };
const received = { type: 'tests.received', partId };

/* The node's handling of test messages, with a part that runs until the test ends it. */
function node({ stopped = false } = {}) {
  const emitted: NodeMessage[] = [], ran: string[] = [];
  const unconfirmed = new Map<string, NodeMessage>();
  const control = new NodeTestMessages({
    dir: '/unused',
    capabilities: {},
    stopped: () => stopped,
    testing: new Map(),
    unconfirmed,
    run: async message => { ran.push(message.partId); await new Promise(() => {}); },
    emit: message => { emitted.push(message); },
  });
  return { control, emitted, ran, unconfirmed };
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe('a part of a run that reaches the node', () => {
  it('is said to be received at once, before it waits for a slot, prepares anything or runs', async () => {
    const n = node();
    void n.control.handle(part);
    expect(n.emitted).toEqual([received]);
    expect(n.ran).toEqual([]);
    await settle();
    expect(n.ran).toEqual([partId]);
  });

  it('is said to be received again when it comes again, and runs once', async () => {
    const n = node();
    void n.control.handle(part);
    await settle();
    void n.control.handle(part);
    await settle();
    expect(n.emitted).toEqual([received, received]);
    expect(n.ran).toEqual([partId]);
  });

  it('is said to be received when it already ran and Hornhoof has not confirmed its end, and does not run again', async () => {
    const n = node();
    n.unconfirmed.set(partId, { type: 'tests.done', partId, ok: true, exitCode: 0, error: null, commit: null, log: '' });
    void n.control.handle(part);
    await settle();
    expect(n.emitted).toEqual([received]);
    expect(n.ran).toEqual([]);
  });

  it('is not said to be received by a node that is stopping, so Hornhoof gives it to another machine', async () => {
    const n = node({ stopped: true });
    void n.control.handle(part);
    await settle();
    expect(n.emitted).toEqual([]);
    expect(n.ran).toEqual([]);
  });
});
