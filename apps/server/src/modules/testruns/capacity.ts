import { freeCores, type NodeLoad } from '@hornhoof/protocol';
import { hostResources, latestReport, reportedHost } from '../nodes/host-load.js';
import type { PartNeed } from './part-budget.js';

export type ComputerPlace = { key: string; load: NodeLoad | null; computer?: string | null };

/* Older nodes stand for separate computers. Prefixes keep a host name apart from a place's key. */
export const computerKey = (place: ComputerPlace): string => place.computer ?? reportedHost(place.load) ?? `place:${place.key}`;

/* A run must fit both the physical host and the node's own memory limit. */
export const availableMemory = (load: NodeLoad, reserved = 0): number => Math.min(load.memFree, hostResources(load).memFree - reserved);

/* Sibling containers describe one host; its newest report counts for all of them. */
export function latestHost(place: ComputerPlace, reports: ((NodeLoad & { at: number }) | null)[]): NodeLoad | null {
  const own = place.load;
  if (!own?.host) return own;
  const same = reports.filter((r): r is NodeLoad & { at: number } => r !== null && r.host === own.host);
  const host = hostResources(latestReport(same) ?? own);
  return { ...own, hostCpus: host.cpus, hostLoad: host.load, hostMemFree: host.memFree, hostMemory: host.memTotal };
}

export type Usage = PartNeed & { parts: number };
export type RunRoom = { busy: boolean; load: NodeLoad | null; usage: Usage };
type Occupied = ComputerPlace & PartNeed;

export const NO_PARTS: Usage = { parts: 0, cores: 0, memoryBytes: 0 };
const combined = (a: Usage, b: Usage): Usage => ({ parts: a.parts + b.parts, cores: a.cores + b.cores, memoryBytes: a.memoryBytes + b.memoryBytes });

/* An unavailable node keeps its reservations until the part ends or is declared lost. */
export function computerState(place: ComputerPlace, running: Occupied[], reports: Parameters<typeof latestHost>[1]): RunRoom {
  const host = computerKey(place);
  const onHost = running.filter(part => part.key === place.key || computerKey(part) === host);
  return {
    load: latestHost(place, reports),
    busy: onHost.some(part => part.key === place.key),
    usage: onHost.reduce((usage, part) => combined(usage, { ...part, parts: 1 }), NO_PARTS),
  };
}

export type RunBlock = 'node' | 'memory' | 'cores' | 'limit';

export function runBlock({ busy, load, usage }: RunRoom, need: PartNeed, limit?: number): RunBlock | null {
  if (busy) return 'node';
  if (limit !== undefined && usage.parts >= limit) return 'limit';
  if (!load || availableMemory(load, usage.memoryBytes) < need.memoryBytes) return 'memory';
  const host = hostResources(load);
  return usage.cores + need.cores > freeCores(host.cpus, host.load) ? 'cores' : null;
}

/* Reservations made after the snapshot, while the queue is giving parts out. */
export class Reservations {
  private readonly hosts = new Map<string, Usage>();
  private readonly places = new Set<string>();

  room(place: ComputerPlace & RunRoom): RunRoom {
    const taken = this.hosts.get(computerKey(place)) ?? NO_PARTS;
    return { load: place.load, busy: place.busy || this.places.has(place.key), usage: combined(place.usage, taken) };
  }

  take(place: ComputerPlace, need: PartNeed): void {
    const key = computerKey(place);
    this.hosts.set(key, combined(this.hosts.get(key) ?? NO_PARTS, { ...need, parts: 1 }));
    this.places.add(place.key);
  }
}
