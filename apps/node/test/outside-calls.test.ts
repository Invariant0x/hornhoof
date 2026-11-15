import { TOOLS_BODY_MAX, type NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { OutsideCalls } from '../src/terminal/outside-calls.js';

const AGENT = '7d0c3f9e-2b1a-4c5d-8e6f-0a1b2c3d4e5f';
const LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

/* The node's link as the calls see it: what went out on it, and whether it took the message. */
function link(takes = true) {
  const sent: NodeMessage[] = [];
  return { sent, send: (m: NodeMessage) => (sent.push(m), takes) };
}

describe("an agent's tool calls with no turn, on the node's link", () => {
  it('asks Hornhoof with a message of its own and gives back the answer that names it', async () => {
    const calls = new OutsideCalls(), out = link();
    calls.opened(out.send, true);
    const answer = calls.ask(AGENT, LIST, '2025-11-25');
    expect(out.sent).toEqual([{ type: 'tools.call', agentKey: AGENT, ref: expect.any(String), body: LIST, version: '2025-11-25' }]);
    const { ref } = out.sent[0] as Extract<NodeMessage, { type: 'tools.call' }>;
    /* An answer to another call, or for another agent, is not this one's. */
    calls.answered({ agentKey: AGENT, ref: 'another', status: 200, body: 'no' });
    calls.answered({ agentKey: '00000000-0000-4000-8000-000000000002', ref, status: 200, body: 'no' });
    calls.answered({ agentKey: AGENT, ref, status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' });
    expect(await answer).toEqual({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' });
    /* Each call has its own name; one answered is answered once. */
    const second = calls.ask(AGENT, LIST, undefined);
    expect(out.sent[1]).toEqual({ type: 'tools.call', agentKey: AGENT, ref: expect.any(String), body: LIST });
    expect((out.sent[1] as { ref: string }).ref).not.toBe(ref);
    calls.answered({ agentKey: AGENT, ref, status: 500, body: 'again' });
    calls.answered({ agentKey: AGENT, ref: (out.sent[1] as { ref: string }).ref, status: 202, body: '' });
    expect(await second).toEqual({ status: 202, body: '' });
  });

  it('cannot ask while the node is offline, nor a Hornhoof from before that does not answer tools this way', async () => {
    const calls = new OutsideCalls(), out = link();
    expect(await calls.ask(AGENT, LIST, undefined)).toBeNull();
    calls.opened(out.send, false);
    expect(await calls.ask(AGENT, LIST, undefined)).toBeNull();
    expect(out.sent).toEqual([]);
    /* A link that does not take the message. */
    const full = link(false);
    calls.opened(full.send, true);
    expect(await calls.ask(AGENT, LIST, undefined)).toBeNull();
  });

  it('gives up on what it asked once the link closes, and asks again on the next one', async () => {
    const calls = new OutsideCalls(), out = link();
    calls.opened(out.send, true);
    const asked = calls.ask(AGENT, LIST, undefined);
    calls.closed();
    expect(await asked).toBeNull();
    expect(await calls.ask(AGENT, LIST, undefined)).toBeNull();
    const next = link();
    calls.opened(next.send, true);
    const again = calls.ask(AGENT, LIST, undefined);
    calls.answered({ agentKey: AGENT, ref: (next.sent[0] as { ref: string }).ref, status: 200, body: 'ok' });
    expect(await again).toEqual({ status: 200, body: 'ok' });
  });

  it("sends nothing Hornhoof would not take, which would leave the program waiting for ever", async () => {
    const calls = new OutsideCalls(), out = link();
    calls.opened(out.send, true);
    expect(await calls.ask(AGENT, 'x'.repeat(TOOLS_BODY_MAX + 1), undefined)).toBeNull();
    /* Words in Russian take two bytes a letter on the link, whose frames Hornhoof takes up to 4 MB: these, under the limit
       in letters, would close the link with every turn on it. */
    const russian = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit', arguments: { text: 'я'.repeat((TOOLS_BODY_MAX * 2) / 3) } } });
    expect(russian.length).toBeLessThan(TOOLS_BODY_MAX);
    expect(await calls.ask(AGENT, russian, undefined)).toBeNull();
    expect(await calls.ask('not an agent / key', LIST, undefined)).toBeNull();
    expect(out.sent).toEqual([]);
    /* A protocol version Hornhoof would not take goes without it: /mcp then answers as to the version it knows. */
    void calls.ask(AGENT, LIST, 'v'.repeat(41));
    expect(out.sent).toEqual([{ type: 'tools.call', agentKey: AGENT, ref: expect.any(String), body: LIST }]);
  });
});

const STEP = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

describe("a check command with no turn, on the node's link", () => {
  it('asks Hornhoof for a step of its own, and says when the command ended', async () => {
    const calls = new OutsideCalls(), out = link();
    calls.opened(out.send, true);
    const asked = calls.check(AGENT);
    expect(out.sent).toEqual([{ type: 'tools.check', agentKey: AGENT, ref: expect.any(String) }]);
    const { ref } = out.sent[0] as { ref: string };
    /* An answer for another agent is not this one's. */
    calls.checking({ agentKey: '00000000-0000-4000-8000-000000000002', ref, jobId: 'other' });
    calls.checking({ agentKey: AGENT, ref, jobId: STEP });
    const step = await asked;
    if (!step || 'refused' in step) throw new Error('No step.');
    expect([step.jobId, step.signal.aborted]).toEqual([STEP, false]);
    step.end(false);
    expect(out.sent.slice(1)).toEqual([{ type: 'tools.checked', agentKey: AGENT, jobId: STEP, ok: false }]);
  });

  it("gives the words Hornhoof would not run it with, and nothing offline or from a Hornhoof before", async () => {
    const calls = new OutsideCalls(), out = link();
    expect(await calls.check(AGENT)).toBeNull();
    calls.opened(out.send, false);
    expect(await calls.check(AGENT)).toBeNull();
    expect(out.sent).toEqual([]);
    calls.opened(out.send, true);
    const asked = calls.check(AGENT);
    calls.checking({ agentKey: AGENT, ref: (out.sent[0] as { ref: string }).ref, jobId: null, refused: 'This employee is switched off.' });
    expect(await asked).toEqual({ refused: 'This employee is switched off.' });
  });

  it('stops the command at once when Hornhoof stops its step, or the link closes', async () => {
    const calls = new OutsideCalls(), out = link();
    calls.opened(out.send, true);
    const open = async (jobId: string) => {
      const asked = calls.check(AGENT);
      calls.checking({ agentKey: AGENT, ref: (out.sent.at(-1) as { ref: string }).ref, jobId });
      const step = await asked;
      if (!step || 'refused' in step) throw new Error('No step.');
      return step;
    };
    const first = await open(STEP), second = await open('9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b');
    calls.stop('not-a-step-of-ours');
    calls.stop(STEP);
    expect([first.signal.aborted, second.signal.aborted]).toEqual([true, false]);
    /* The link closes: the step goes on there no longer, and one asked for has no answer. */
    const pending = calls.check(AGENT);
    calls.closed();
    expect(second.signal.aborted).toBe(true);
    expect(await pending).toBeNull();
  });
});
