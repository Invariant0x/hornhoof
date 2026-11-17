type WaitEdge = { from: string; to: string };
type Graph = Map<string, string[]>;

/* A mutually waiting group carries every task reason between its members. */
export function waitingCycles<T extends WaitEdge>(edges: readonly T[]): T[][] {
  const graph: Graph = new Map();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    if (!graph.has(edge.to)) graph.set(edge.to, []);
    graph.get(edge.from)!.push(edge.to);
  }
  return components(graph).map(group => {
    const members = new Set(group);
    return edges.filter(edge => members.has(edge.from) && members.has(edge.to));
  }).filter(group => group.length > 0);
}

function components(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const groups: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, index.size);
    low.set(node, index.get(node)!);
    stack.push(node);
    active.add(node);
    for (const next of graph.get(node)!) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (active.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) === index.get(node)) groups.push(popGroup(stack, active, node));
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return groups;
}

function popGroup(stack: string[], active: Set<string>, root: string): string[] {
  const group: string[] = [];
  let node: string;
  do {
    node = stack.pop()!;
    active.delete(node);
    group.push(node);
  } while (node !== root);
  return group;
}
