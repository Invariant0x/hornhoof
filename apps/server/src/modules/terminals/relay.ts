import type { WebSocket } from 'ws';
import { sameNode, type NodeIdentity, type TerminalMessage } from '../nodes/hub.js';

/* Who watches which agent, through the node that shows its session. */
export type View = { socket: WebSocket; node: NodeIdentity; agentId: string; personId: string };

/* What a person typed counts for this long: the prompt they sent opens its turn right after. */
const TYPED_MS = 60_000;

/* How a view ends, as the browser hears it. */
export const CLOSE = {
  exit: [1000, 'exit'],
  noTerminal: [4404, 'no_terminal'],
  nodeOffline: [4410, 'node_offline'],
  noAccess: [4403, 'no_access'],
  stopping: [1001, 'stopping'],
} as const;

const end = (socket: WebSocket, [code, reason]: readonly [number, string]) => socket.close(code, reason);

/* Browsers watching agents' terminals, each tied to the node that shows the session. */
export class TerminalRelay {
  private readonly views = new Map<string, View>();
  private readonly typed = new Map<string, { personId: string; at: number }>();

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

  typing(agentId: string, personId: string): void {
    this.typed.set(agentId, { personId, at: Date.now() });
  }

  /* The person who typed into the agent's terminal just now, if anyone did. */
  typist(agentId: string): string | null {
    const last = this.typed.get(agentId);
    return last && Date.now() - last.at < TYPED_MS ? last.personId : null;
  }

  stop(): void {
    for (const view of this.views.values()) end(view.socket, CLOSE.stopping);
    this.views.clear();
  }
}
