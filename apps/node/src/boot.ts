import type { Boot } from '@hornhoof/protocol';

/* How a node came up: when its program started, when the machine under it did, worked out from the machine's uptime in
   seconds, and its container, which Docker names after the container's id unless told otherwise. */
export function bootFacts(now: number, upSeconds: number, host: string): Boot {
  return { startedAt: new Date(now).toISOString(), machineUpAt: new Date(now - Math.round(upSeconds * 1000)).toISOString(), container: host || 'unnamed' };
}
