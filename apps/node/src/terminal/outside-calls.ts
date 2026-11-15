import { randomUUID } from 'node:crypto';
import { parseNodeMessage, TOOLS_BODY_MAX, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import type { CheckStep, OutsideAnswer } from './bridge.js';

type Answer = Extract<ServerMessage, { type: 'tools.answer' }>;
type Checking = Extract<ServerMessage, { type: 'tools.checking' }>;
type Send = (m: NodeMessage) => boolean;

/* What agents' programs send their tools with no turn running, on the node's own link to Hornhoof: each call goes as a
   message with a name of its own, and Hornhoof's answer that names it comes back to the program. The link carries no
   token: Hornhoof knows the node by its key and the agent by the node it is on. A call has no answer while the node is
   offline or Hornhoof is one from before that answers tools only in a turn, and none once the link it went on closed. A
   check command runs in a step Hornhoof opens for it and keeps open until the node says it ended: it stops at once when
   Hornhoof stops that step, or when the link closes, which leaves Hornhoof no word of its end. */
export class OutsideCalls {
  private send: Send | null = null;
  private readonly waiting = new Map<string, { agentKey: string; done: (answer: OutsideAnswer | null) => void }>();
  private readonly checks = new Map<string, { agentKey: string; done: (answer: Checking | null) => void }>();
  private readonly steps = new Map<string, AbortController>();

  /* The link opened; tools: Hornhoof said in its upgrade answer that it answers tools with no turn running. */
  opened(send: Send, tools: boolean): void {
    this.send = tools ? send : null;
  }

  closed(): void {
    this.send = null;
    const waiting = [...this.waiting.values()], checks = [...this.checks.values()], steps = [...this.steps.values()];
    this.waiting.clear();
    this.checks.clear();
    this.steps.clear();
    for (const w of waiting) w.done(null);
    for (const c of checks) c.done(null);
    for (const stop of steps) stop.abort();
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

  /* A step for a check command the agent's program runs, or Hornhoof's words for why it may not run now. */
  async check(agentKey: string): Promise<CheckStep | null> {
    const send = this.send;
    const ref = randomUUID();
    const ask = send && sendable({ type: 'tools.check', agentKey, ref });
    if (!ask) return null;
    const answer = await new Promise<Checking | null>(done => {
      this.checks.set(ref, { agentKey, done });
      if (send(ask)) return;
      this.checks.delete(ref);
      done(null);
    });
    if (!answer) return null;
    const jobId = answer.jobId;
    if (!jobId) return { refused: answer.refused ?? 'Hornhoof did not let this check run now.' };
    const stop = new AbortController();
    this.steps.set(jobId, stop);
    return {
      jobId,
      signal: stop.signal,
      end: ok => {
        if (this.steps.get(jobId) !== stop) return;
        this.steps.delete(jobId);
        this.send?.({ type: 'tools.checked', agentKey, jobId, ok });
      },
    };
  }

  checking(m: Omit<Checking, 'type'>): void {
    const c = this.checks.get(m.ref);
    if (!c || c.agentKey !== m.agentKey) return;
    this.checks.delete(m.ref);
    c.done({ type: 'tools.checking', ...m });
  }

  /* Hornhoof stopped the step: its command stops now. */
  stop(jobId: string): void {
    this.steps.get(jobId)?.abort();
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
function sendable(m: Extract<NodeMessage, { type: 'tools.call' | 'tools.check' }>): NodeMessage | null {
  const frame = JSON.stringify(m);
  return Buffer.byteLength(frame, 'utf8') <= TOOLS_BODY_MAX && parseNodeMessage(frame) ? m : null;
}
