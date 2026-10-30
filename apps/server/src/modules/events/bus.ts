import type { Spot } from '../../auth/access.js';
import type { EventView } from './store.js';

/* Who a pulse on the map runs between. */
export type Endpoint = { kind: 'person'; id: string } | { kind: 'orchestrator' } | { kind: 'department'; id: string };

/* What the browser hears live: a conversation event, how many agents work, that the org changed, or a pulse to draw.
   An agent event carries where its agent works, so the stream sends it only to people who reach that place. */
export type StreamMessage =
  | { type: 'agent_event'; agentId: string; event: EventView; spot: Spot }
  | { type: 'working'; working: number }
  | { type: 'org' }
  | { type: 'pulse'; from: Endpoint; to: Endpoint };

/* In-process fan-out per company. One server process serves one deployment, so nothing crosses processes. */
export class EventBus {
  private listeners = new Map<string, Set<(m: StreamMessage) => void>>();

  publish(companyId: string, m: StreamMessage): void {
    for (const fn of this.listeners.get(companyId) ?? []) fn(m);
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
