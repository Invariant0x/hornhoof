const roots = new Map<string, Set<number>>();

/* The bridge starts these on an authenticated agent's behalf, outside its terminal pane. */
export const checkProcesses = (agent: string): number[] => [...(roots.get(agent) ?? [])];

export function trackCheckProcess(agent: string, pid: number | undefined): () => void {
  if (pid === undefined) return () => {};
  const owned = roots.get(agent) ?? new Set<number>();
  roots.set(agent, owned); owned.add(pid);
  return () => { owned.delete(pid); if (!owned.size) roots.delete(agent); };
}
