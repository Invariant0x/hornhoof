import type { NodeMessage } from '@hornhoof/protocol';

/* Which of the turns Hornhoof asked about the node still runs, of those it holds: the ones it runs, the ones typed into its
   terminals, and the ones that ended and whose end Hornhoof has not confirmed yet, as its hello lists them. */
export function heldJobs(asked: readonly string[], holds: Iterable<string>): Extract<NodeMessage, { type: 'jobs.held' }> {
  const mine = new Set(holds);
  return { type: 'jobs.held', asked: [...asked], held: asked.filter(id => mine.has(id)) };
}
