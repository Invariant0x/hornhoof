import type { NodeLoad } from '@hornhoof/protocol';

export const reportedHost = (load: NodeLoad | null): string | undefined => load?.host ? `host:${load.host}` : undefined;

/* One physical computer's load, as reported by any of its nodes. */
export const hostResources = (load: NodeLoad): Pick<NodeLoad, 'cpus' | 'load' | 'memFree' | 'memTotal'> => ({
  cpus: load.hostCpus ?? load.cpus,
  load: load.hostLoad ?? load.load,
  memFree: load.hostMemFree ?? load.memFree,
  memTotal: load.hostMemory ?? load.memTotal,
});

export function latestReport<T extends { at: number }>(samples: readonly T[]): T | undefined {
  return samples.reduce<T | undefined>((latest, sample) => !latest || sample.at > latest.at ? sample : latest, undefined);
}
