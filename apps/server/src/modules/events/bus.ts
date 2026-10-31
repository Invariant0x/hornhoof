import type { Spot } from '../../auth/access.js';
import type { EventView } from './store.js';

/* Who a pulse runs between: places on the map, or two agents inside one department, which its card shows. */
export type Endpoint = { kind: 'person'; id: string } | { kind: 'orchestrator' } | { kind: 'department'; id: string } | { kind: 'agent'; id: string; departmentId: string };

/* A way a message went, and when the last one did. It runs on the map while it is younger than CHANNEL_MS. */
export type Channel = { from: Endpoint; to: Endpoint; at: string };
export const CHANNEL_MS = 10 * 60_000;

const ends = (e: Endpoint) => (e.kind === 'orchestrator' ? e.kind : `${e.kind}:${e.id}`);

/* What the browser hears live: a conversation event, how many agents work, that the org changed, or a pulse to draw.
   An agent event carries where its agent works, so the stream sends it only to people who reach that place. */
export type StreamMessage =
  | { type: 'agent_event'; agentId: string; event: EventView; spot: Spot }
  | { type: 'working'; working: number }
  | { type: 'org' }
  | { type: 'pulse'; from: Endpoint; to: Endpoint }
  /* A task changed; people who reach its place fetch it again. */
  | { type: 'task'; id: string; spot: Spot }
  /* What waits for people changed in this place. */
  | { type: 'requests'; spot: Spot }
  /* The company's notebook changed; it goes to people who see the whole company. */
  | { type: 'notebook'; spot: Spot }
  /* How full an agent's context is now, for the bar on the map, which everyone sees. */
  | { type: 'context'; agentId: string; used: number };

/* In-process fan-out per company. One server process serves one deployment, so nothing crosses processes. */
export class EventBus {
  private listeners = new Map<string, Set<(m: StreamMessage) => void>>();
  /* Per company, each way a pulse went with the time of the last one, so a map opened later shows them too. */
  private ways = new Map<string, Map<string, { from: Endpoint; to: Endpoint; at: number }>>();

  publish(companyId: string, m: StreamMessage, now = Date.now()): void {
    if (m.type === 'pulse') {
      const ways = this.ways.get(companyId) ?? new Map<string, { from: Endpoint; to: Endpoint; at: number }>();
      this.ways.set(companyId, ways);
      const key = `${ends(m.from)}>${ends(m.to)}`;
      ways.delete(key);
      ways.set(key, { from: m.from, to: m.to, at: now });
      for (const [k, w] of ways) if (now - w.at > CHANNEL_MS) ways.delete(k);
    }
    for (const fn of this.listeners.get(companyId) ?? []) fn(m);
  }

  /* The ways a message went in the last CHANNEL_MS, oldest first. */
  channels(companyId: string, now = Date.now()): Channel[] {
    return [...(this.ways.get(companyId)?.values() ?? [])].filter(w => now - w.at <= CHANNEL_MS).map(w => ({ from: w.from, to: w.to, at: new Date(w.at).toISOString() }));
  }

  subscribe(companyId: string, fn: (m: StreamMessage) => void): () => void {
    const set = this.listeners.get(companyId) ?? new Set();
    set.add(fn);
    this.listeners.set(companyId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(companyId);
    };
  }
}
