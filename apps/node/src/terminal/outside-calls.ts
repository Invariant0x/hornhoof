import { randomUUID } from 'node:crypto';
import { parseNodeMessage, TOOLS_BODY_MAX, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import type { OutsideAnswer } from './bridge.js';

type Answer = Extract<ServerMessage, { type: 'tools.answer' }>;
type Send = (m: NodeMessage) => boolean;

/* What agents' programs send their tools with no turn running, on the node's own link to Hornhoof: each call goes as a
   message with a name of its own, and Hornhoof's answer that names it comes back to the program. The link carries no
   token: Hornhoof knows the node by its key and the agent by the node it is on. A call has no answer while the node is
   offline or Hornhoof is one from before that answers tools only in a turn, and none once the link it went on closed. */
export class OutsideCalls {
  private send: Send | null = null;
  private readonly waiting = new Map<string, { agentKey: string; done: (answer: OutsideAnswer | null) => void }>();

  /* The link opened; tools: Hornhoof said in its upgrade answer that it answers tools with no turn running. */
  opened(send: Send, tools: boolean): void {
    this.send = tools ? send : null;
  }

  closed(): void {
    this.send = null;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) w.done(null);
  }

  ask(agentKey: string, body: string, version: string | undefined): Promise<OutsideAnswer | null> {
    const send = this.send;
    if (!send) return Promise.resolve(null);
    const ref = randomUUID();
    const call = sendable({ type: 'tools.call', agentKey, ref, body, ...(version ? { version } : {}) }) ?? sendable({ type: 'tools.call', agentKey, ref, body });
    if (!call) return Promise.resolve(null);
    return new Promise(done => {
      this.waiting.set(ref, { agentKey, done });
      if (send(call)) return;
      this.waiting.delete(ref);
      done(null);
    });
  }

  answered(m: Omit<Answer, 'type'>): void {
    const w = this.waiting.get(m.ref);
    if (!w || w.agentKey !== m.agentKey) return;
    this.waiting.delete(m.ref);
    w.done({ status: m.status, body: m.body });
  }
}

/* A message Hornhoof takes, as it reads it: one it would not read would never be answered. Its frame stays under what
   Hornhoof takes on the link, which closes on a bigger one with every turn on it, in bytes: a letter may take more. */
function sendable(m: Extract<NodeMessage, { type: 'tools.call' }>): NodeMessage | null {
  const frame = JSON.stringify(m);
  return Buffer.byteLength(frame, 'utf8') <= TOOLS_BODY_MAX && parseNodeMessage(frame) ? m : null;
}
