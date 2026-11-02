import type { NodeLoad } from '@hornhoof/protocol';

/* Physical host reports are optional, so nodes from before host reporting keep their earlier behavior. */
type HostLoad = NodeLoad & { host?: string; hostLoad?: number; hostMemFree?: number };
export type ComputerPlace = { key: string; load: HostLoad | null };

/* Older nodes stand for separate computers. Prefixes keep a host name apart from a place's key. */
export const computerKey = (place: ComputerPlace): string => (place.load?.host ? `host:${place.load.host}` : `place:${place.key}`);

/* The host's resources when it reports them, otherwise the node's earlier figures. */
export const resources = (load: HostLoad): Pick<NodeLoad, 'cpus' | 'load' | 'memFree' | 'memTotal'> => ({
  cpus: load.hostCpus ?? load.cpus,
  load: load.hostLoad ?? load.load,
  memFree: load.hostMemFree ?? load.memFree,
  memTotal: load.hostMemory ?? load.memTotal,
});

/* Sibling containers describe one host; its newest report counts for all of them. */
export function latestHost(place: ComputerPlace, reports: ((HostLoad & { at: number }) | null)[]): HostLoad | null {
  const own = place.load;
  if (!own?.host) return own;
  const same = reports.filter((r): r is HostLoad & { at: number } => r !== null && r.host === own.host);
  const newest = same.reduce((a, b) => (b.at > a.at ? b : a), { ...own, at: -Infinity });
  const host = resources(newest);
  return { ...own, hostCpus: host.cpus, hostLoad: host.load, hostMemFree: host.memFree, hostMemory: host.memTotal };
}

/* An unavailable node still occupies its own place until the part ends or is declared lost. */
export const runningOn = (place: ComputerPlace, running: ComputerPlace[]): number =>
  running.filter(p => p.key === place.key || computerKey(p) === computerKey(place)).length;

export function computerState(place: ComputerPlace, running: ComputerPlace[], reports: Parameters<typeof latestHost>[1], limit: number) {
  const count = runningOn(place, running);
  return { load: latestHost(place, reports), running: count, busy: running.some(p => p.key === place.key) || count >= limit };
}

/* Reservations in one queue pass share a host limit, while each place keeps its own user for one part. */
export class Reservations {
  private readonly hosts = new Map<string, number>();
  private readonly places = new Set<string>();

  constructor(private readonly limit: number) {}

  busy(place: ComputerPlace & { busy: boolean; running: number }): boolean {
    return place.busy || this.places.has(place.key) || place.running + (this.hosts.get(computerKey(place)) ?? 0) >= this.limit;
  }

  take(place: ComputerPlace): void {
    const key = computerKey(place);
    this.hosts.set(key, (this.hosts.get(key) ?? 0) + 1);
    this.places.add(place.key);
  }
}
