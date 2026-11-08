import { sameNode, type NodeIdentity } from '../nodes/hub.js';

/* How long a machine has to say it got a part. A node says so the moment the part reaches it, before any slot,
   preparation or run, and both ends ping every 15 to 20 s: ten seconds is many times a slow round trip and a busy node,
   and moves a part sent into a dead connection before that connection is even missed. */
export const RECEIVE_MS = 10_000;

/* Timers the waits run on; a test runs them by hand. */
export type Timers = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms).unref(),
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

export type Sending = { partId: string; node: NodeIdentity };
type Waiting = Sending & { at: number; timer: unknown; over: boolean };

/* Parts sent to a machine that has not said yet it got them. A part is bound to the machine it went to by its id, and a
   part that goes to another machine after its first said nothing gets a new id: a word about an id not waited for here
   is about an older sending, or one already settled. onDue runs when one of them falls due; one whose timer ran is due
   whatever the wall clock says meanwhile. */
export class PartDeliveries {
  private readonly sent = new Map<string, Waiting>();

  constructor(
    private readonly onDue: () => void,
    private readonly timers: Timers = realTimers,
  ) {}

  /* The part went to this node at this moment; a sending of it before counts no more. */
  expect(partId: string, node: NodeIdentity, at: number): void {
    this.forget(partId);
    const sending: Waiting = { partId, node, at, over: false, timer: null };
    sending.timer = this.timers.set(() => { sending.over = true; this.onDue(); }, RECEIVE_MS);
    this.sent.set(partId, sending);
  }

  /* True for the one word the part waited for: the first from the node it went to last. */
  received(partId: string, node: NodeIdentity): boolean {
    const sending = this.sent.get(partId);
    if (!sending || !sameNode(sending.node, node)) return false;
    this.forget(partId);
    return true;
  }

  forget(partId: string): void {
    const sending = this.sent.get(partId);
    if (!sending) return;
    this.timers.clear(sending.timer);
    this.sent.delete(partId);
  }

  /* The sendings whose time to be confirmed is over by now, each handed out once. */
  due(now: number): Sending[] {
    const over = [...this.sent.values()].filter(s => s.over || s.at + RECEIVE_MS <= now);
    for (const s of over) this.forget(s.partId);
    return over.map(({ partId, node }) => ({ partId, node }));
  }

  close(): void {
    for (const partId of [...this.sent.keys()]) this.forget(partId);
  }
}
