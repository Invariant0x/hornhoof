import { freeCores, type NodeLoad } from '@hornhoof/protocol';
import { hostResources } from '../nodes/host-load.js';
import { runBlock, type RunRoom } from './capacity.js';
import type { PartNeed } from './part-budget.js';

/* A place a test run can go: a machine of the company, or the built-in node. load: what its nodes said last, none while
   none of them is connected. reaches: its owner reaches the department whose repository the run clones. busy: it runs a
   part of a test run already. */
export type Spot = RunRoom & { key: string; lent: boolean; reaches: boolean };

/* Two machines whose free shares differ by less than this count as equally free, and the one running fewer jobs wins. */
export const ABOUT_AS_FREE = 0.1;
/* Whether a machine's processors are too busy to take another part. */
export const loaded = (load: NodeLoad): boolean => {
  const host = hostResources(load);
  return freeCores(host.cpus, host.load) === 0;
};

/* The share of its processors a machine has free, and of its memory, together: 2 for one that does nothing. */
export const freedom = (load: NodeLoad): number => {
  const host = hostResources(load);
  return Math.max(0, 1 - host.load / host.cpus) + (host.memTotal ? host.memFree / host.memTotal : 0);
};

/* The freest machine that may take a run needing this much free memory, or none. A loaded one takes none. */
export function pickMachine(spots: Spot[], need: PartNeed, limit?: number): Spot | null {
  const fits = spots.filter(s => s.lent && s.reaches && runBlock(s, need, limit) === null);
  const better = (a: Spot, b: Spot) => {
    const [x, y] = [freedom(a.load!), freedom(b.load!)];
    if (Math.abs(x - y) >= ABOUT_AS_FREE) return x > y;
    const [ja, jb] = [a.load!.jobs + a.load!.tests, b.load!.jobs + b.load!.tests];
    return ja !== jb ? ja < jb : x > y;
  };
  return fits.reduce<Spot | null>((best, s) => (!best || better(s, best) ? s : best), null);
}
