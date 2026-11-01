import type { NodeLoad } from '@hornhoof/protocol';
import type { SaidLoad } from '../nodes/hub.js';

const plain = ({ at: _, ...load }: SaidLoad): NodeLoad => load;

/* A machine's load from what its nodes said: they share its processors and memory, of which the newest word counts, and
   each runs jobs of its own. */
export function together(loads: (SaidLoad | null)[]): NodeLoad | null {
  const said = loads.filter((l): l is SaidLoad => l !== null);
  if (!said.length) return null;
  const newest = said.reduce((a, b) => (b.at > a.at ? b : a));
  return { ...plain(newest), tests: said.reduce((n, l) => n + l.tests, 0), jobs: said.reduce((n, l) => n + l.jobs, 0) };
}
