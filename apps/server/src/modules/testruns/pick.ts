import type { NodeLoad } from '@hornhoof/protocol';

/* A place a test run can go: a machine of the company, or the built-in node. load: what its nodes said last, none while
   none of them is connected. reaches: its owner reaches the department whose repository the run clones. busy: it runs a
   part of a test run already. */
export type Spot = { key: string; lent: boolean; reaches: boolean; busy: boolean; load: NodeLoad | null };

/* Two machines whose free shares differ by less than this count as equally free, and the one running fewer jobs wins. */
const ABOUT_AS_FREE = 0.1;

/* The share of its processors a machine has free, and of its memory, together: 2 for one that does nothing. */
const freedom = (load: NodeLoad) => Math.max(0, 1 - load.load / load.cpus) + (load.memTotal ? load.memFree / load.memTotal : 0);

/* The freest machine that may take a run needing this much free memory, or none. */
export function pickMachine(spots: Spot[], needBytes: number): Spot | null {
  const fits = spots.filter(s => s.lent && s.reaches && !s.busy && s.load !== null && s.load.memFree >= needBytes);
  const better = (a: Spot, b: Spot) => {
    const [x, y] = [freedom(a.load!), freedom(b.load!)];
    if (Math.abs(x - y) >= ABOUT_AS_FREE) return x > y;
    const [ja, jb] = [a.load!.jobs + a.load!.tests, b.load!.jobs + b.load!.tests];
    return ja !== jb ? ja < jb : x > y;
  };
  return fits.reduce<Spot | null>((best, s) => (!best || better(s, best) ? s : best), null);
}
