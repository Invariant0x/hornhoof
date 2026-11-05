import type { WebSocket } from 'ws';
import { sameNode, type NodeIdentity, type TerminalMessage } from '../nodes/hub.js';

/* Who watches which agent, through the node that shows its session. */
export type View = { socket: WebSocket; node: NodeIdentity; agentId: string; personId: string };

/* What a person typed counts for this long: the prompt they sent opens its turn right after. */
const TYPED_MS = 60_000;
/* An Enter pressed in a running turn counts for as long as a turn may run: what it sent may wait in the program's queue
   until that turn ends. An agent keeps only its last few. */
const PRESSED_MS = 2 * 3_600_000;
const MAX_PRESSED = 8;

type Pressed = { jobId: string; personId: string; node: NodeIdentity; at: number };

/* Why Hornhoof opened no turn for what a program took: another turn ran, or the words are tied to nobody. */
export type TurnRefusal = 'busy' | 'unknown_words';

/* How a view ends, as the browser hears it. */
export const CLOSE = {
  exit: [1000, 'exit'],
  noTerminal: [4404, 'no_terminal'],
  nodeOffline: [4410, 'node_offline'],
  noAccess: [4403, 'no_access'],
  stopping: [1001, 'stopping'],
} as const;

const end = (socket: WebSocket, [code, reason]: readonly [number, string]) => socket.close(code, reason);

const fresh = (pressed: Pressed) => Date.now() - pressed.at < PRESSED_MS;

/* Browsers watching agents' terminals, each tied to the node that shows the session. */
export class TerminalRelay {
  private readonly views = new Map<string, View>();
  private readonly typed = new Map<string, { personId: string; node: NodeIdentity; at: number }>();
  private readonly pressed = new Map<string, Pressed[]>();
  private readonly refused = new Map<string, TurnRefusal>();
  private readonly writers = new Map<string, { personId: string; node: NodeIdentity }>();

  add(termId: string, view: View): void {
    this.views.set(termId, view);
  }

  /* The view if it was still open. */
  remove(termId: string): View | undefined {
    const view = this.views.get(termId);
    this.views.delete(termId);
    return view;
  }

  /* Only the node that shows a view writes to it. */
  fromNode(id: NodeIdentity, msg: TerminalMessage): void {
    const view = this.views.get(msg.termId);
    if (!view || !sameNode(view.node, id)) return;
    if (msg.type === 'term.data') {
      view.socket.send(JSON.stringify({ type: 'data', data: msg.data }));
      return;
    }
    if (msg.type === 'term.program') {
      view.socket.send(JSON.stringify({ type: 'program', running: msg.running }));
      return;
    }
    this.views.delete(msg.termId);
    end(view.socket, CLOSE.exit);
  }

  nodeGone(id: NodeIdentity): void {
    for (const [termId, view] of this.views) {
      if (!sameNode(view.node, id)) continue;
      this.views.delete(termId);
      end(view.socket, CLOSE.nodeOffline);
    }
  }

  /* A person pressed Enter in the agent's terminal, which the node shows. */
  typing(agentId: string, personId: string, node: NodeIdentity): void {
    this.typed.set(agentId, { personId, node, at: Date.now() });
  }

  /* A person typed words in the agent's terminal, which may stay there unsent. */
  wrote(agentId: string, personId: string, node: NodeIdentity): void {
    this.writers.set(agentId, { personId, node });
  }

  /* The person who last typed words in the agent's terminal on this node, for as long as this server has run. */
  lastWriter(node: NodeIdentity, agentId: string): string | null {
    const last = this.writers.get(agentId);
    return last && sameNode(last.node, node) ? last.personId : null;
  }

  /* The person who pressed Enter in the agent's terminal on this node just now, if anyone did. One Enter opens one turn:
     the next prompt needs a new one. */
  takeTyped(node: NodeIdentity, agentId: string): string | null {
    const last = this.typed.get(agentId);
    if (!last || !sameNode(last.node, node) || Date.now() - last.at >= TYPED_MS) return null;
    this.typed.delete(agentId);
    return last.personId;
  }

  /* An Enter that waited to open a turn and opens none now, and the person who pressed it if it still counted. */
  drop(agentId: string): string | null {
    const last = this.typed.get(agentId);
    this.typed.delete(agentId);
    return last && Date.now() - last.at < TYPED_MS ? last.personId : null;
  }

  /* A person pressed Enter in the agent's running turn. The program may take it into that turn, or queue it for after. */
  pressedIn(agentId: string, jobId: string, personId: string, node: NodeIdentity): void {
    const kept = (this.pressed.get(agentId) ?? []).filter(fresh);
    kept.push({ jobId, personId, node, at: Date.now() });
    this.pressed.set(agentId, kept.slice(-MAX_PRESSED));
  }

  /* The person whose Enter in this turn sent words its node saw queued, the latest first. One Enter opens one turn. */
  takePressed(node: NodeIdentity, agentId: string, jobId: string): string | null {
    const kept = this.pressed.get(agentId) ?? [];
    const at = kept.findLastIndex(p => p.jobId === jobId && sameNode(p.node, node) && fresh(p));
    if (at < 0) return null;
    const [taken] = kept.splice(at, 1);
    if (!kept.length) this.pressed.delete(agentId);
    return taken!.personId;
  }

  refuse(agentId: string, reason: TurnRefusal): void {
    this.refused.set(agentId, reason);
  }

  /* A new turn of the agent ended what its window says about the last one it could not open. */
  turnBegan(agentId: string): void {
    this.refused.delete(agentId);
  }

  refusal(agentId: string): TurnRefusal | null {
    return this.refused.get(agentId) ?? null;
  }

  stop(): void {
    for (const view of this.views.values()) end(view.socket, CLOSE.stopping);
    this.views.clear();
  }
}
