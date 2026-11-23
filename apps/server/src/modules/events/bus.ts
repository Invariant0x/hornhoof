import type { Spot } from '../../auth/access.js';
import type { EventView } from './store.js';
import type { ConnectingView } from '../subscriptions/connecting.js';

/* Who a pulse runs between: places on the map, or two agents inside one department, which its card shows. */
export type Endpoint = { kind: 'person'; id: string } | { kind: 'orchestrator' } | { kind: 'department'; id: string } | { kind: 'agent'; id: string; departmentId: string };

/* A way a message went, and when the last one did. It runs on the map while it is younger than CHANNEL_MS, and held
   past that while the work it brought goes on. */
export type Channel = { from: Endpoint; to: Endpoint; at: string; held?: true };
export const CHANNEL_MS = 10 * 60_000;
/* How long a way is remembered after its last message, so it can be held while long work goes on. */
const KEPT_MS = 24 * 60 * 60_000;

const ends = (e: Endpoint) => (e.kind === 'orchestrator' ? e.kind : `${e.kind}:${e.id}`);

/* What the browser hears live: a conversation event, how many agents work, that the org changed, or a pulse to draw.
   An agent event carries where its agent works, so the stream sends it only to people who reach that place. */
export type StreamMessage =
  | { type: 'agent_event'; agentId: string; event: EventView; spot: Spot }
  | { type: 'working'; working: number }
  | { type: 'org' }
  /* The company's active theme or world changed; every signed-in browser switches at once. */
  | { type: 'company_theme'; theme: string }
  | { type: 'pulse'; from: Endpoint; to: Endpoint }
  /* A task changed; people who reach its place fetch it again. */
  | { type: 'task'; id: string; spot: Spot }
  /* The company's goals or a department's pipelines changed; everyone of it reads them, as they read its tasks. */
  | { type: 'tracker' }
  /* What waits for people changed in this place. */
  | { type: 'requests'; spot: Spot }
  /* A machine's card came or closed; each person asks for what is theirs, so it holds no place and nothing else. */
  | { type: 'requests'; machines: true }
  /* The company's notebook changed; it goes to people who see the whole company. */
  | { type: 'notebook'; spot: Spot }
  /* What employees found to improve changed; it goes to people who see the whole company. */
  | { type: 'improvements'; spot: Spot }
  /* The feedback inbox of Hornhoof's own installation changed; it goes to people who see the whole company. */
  | { type: 'feedback'; spot: Spot }
  /* A department's list of work kept for later turns changed; its people fetch it again. */
  | { type: 'backlog'; spot: Spot }
  /* An employee's inbox changed; people who reach its place and open it fetch it again. */
  | { type: 'inbox'; agentId: string; spot: Spot }
  /* How full an agent's context is now, for the bar on the map, which everyone sees. */
  | { type: 'context'; agentId: string; used: number }
  /* The orchestrator's request for the computer the server runs on, or its access, changed; only the CEO hears it. */
  | { type: 'computer' }
  /* How a plan's sign-in on one of its machines ended; it goes to the plan's owner alone. */
  | { type: 'subscription.signin'; subscriptionId: string; nodeId: string; ok: boolean; error: string | null; code: number | null; line: string | null; owner: string }
  /* A plan's connection after its sign-in code, for its owner; none once it ended. */
  | { type: 'subscription.connecting'; subscriptionId: string; connecting: ConnectingView | null; owner: string };

/* In-process fan-out per company. One server process serves one deployment, so nothing crosses processes. */
export class EventBus {
  private listeners = new Map<string, Set<(m: StreamMessage) => void>>();
  private lookers = new Map<string, Set<() => void>>();
  /* Per company, each way a pulse went with the time of the last one, so a map opened later shows them too. */
  private ways = new Map<string, Map<string, { from: Endpoint; to: Endpoint; at: number }>>();

  publish(companyId: string, m: StreamMessage, now = Date.now()): void {
    if (m.type === 'pulse') {
      const ways = this.ways.get(companyId) ?? new Map<string, { from: Endpoint; to: Endpoint; at: number }>();
      this.ways.set(companyId, ways);
      const key = `${ends(m.from)}>${ends(m.to)}`;
      ways.delete(key);
      ways.set(key, { from: m.from, to: m.to, at: now });
      for (const [k, w] of ways) if (now - w.at > KEPT_MS) ways.delete(k);
    }
    for (const fn of this.listeners.get(companyId) ?? []) fn(m);
  }

  /* The ways a message went in the last CHANNEL_MS, and older ones `held` keeps on, oldest first. A young way is marked held
     too, so a map that fetched it keeps it on past CHANNEL_MS while the work goes on. */
  channels(companyId: string, now = Date.now(), held: (w: Channel) => boolean = () => false): Channel[] {
    return [...(this.ways.get(companyId)?.values() ?? [])].flatMap(w => {
      const way: Channel = { from: w.from, to: w.to, at: new Date(w.at).toISOString() };
      if (held(way)) return [{ ...way, held: true as const }];
      return now - w.at <= CHANNEL_MS ? [way] : [];
    });
  }

  subscribe(companyId: string, fn: (m: StreamMessage) => void): () => void {
    return keep(this.listeners, companyId, fn);
  }

  /* Someone's access changed or ended: open streams and terminals look at their person again now, not at their next ping. */
  accessChanged(companyId: string): void {
    for (const fn of this.lookers.get(companyId) ?? []) fn();
  }

  onAccessChange(companyId: string, fn: () => void): () => void {
    return keep(this.lookers, companyId, fn);
  }
}

function keep<F>(all: Map<string, Set<F>>, companyId: string, fn: F): () => void {
  const set = all.get(companyId) ?? new Set<F>();
  set.add(fn);
  all.set(companyId, set);
  return () => {
    set.delete(fn);
    if (!set.size) all.delete(companyId);
  };
}
