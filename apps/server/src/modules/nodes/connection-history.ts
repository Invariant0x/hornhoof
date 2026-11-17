import type { ConnectionEnd, NodeDisconnectCause, NodeReconnect } from '@hornhoof/protocol';

/* What different nodes of a machine lost within this time of the first of them is one drop: a router going down takes them
   all, and the server notices each within a round of its pings. A node that drops again has dropped again. */
const SAME_DROP_MS = 60_000;
const SUMMARY_MS = 24 * 60 * 60 * 1000;
const LISTED = 50;

export type ConnectionRow = {
  nodeId: string;
  subscriptionId: string | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
  cause: ConnectionEnd | null;
  closeCode: number | null;
  closeReason: string | null;
  error: string | null;
  report: NodeReconnect | null;
};

/* One node's lost connection. offlineMs: the longer of what the server and the node measured, none until it is back. */
type NodeDrop = {
  nodeId: string;
  subscriptionId: string | null;
  at: Date;
  back: Date | null;
  offlineMs: number | null;
  cause: ConnectionEnd;
  closeCode: number | null;
  closeReason: string | null;
  error: string | null;
  report: NodeReconnect | null;
};

export type DropCause = ConnectionEnd | NodeDisconnectCause;

/* What happened to the machine: the lost connections of its nodes that go together. */
export type MachineDrop = { at: Date; back: Date | null; offlineMs: number | null; cause: DropCause; drops: NodeDrop[] };

export type ConnectionHistory = { summary: { drops: number; averageMs: number | null; cause: DropCause | null }; events: MachineDrop[] };

/* The connection a node lost, if it lost one, with when it came back. A node taken off its machine in Hornhoof lost nothing. */
function dropOf(row: ConnectionRow, back: Date | null): NodeDrop[] {
  if (!row.disconnectedAt || !row.cause || row.cause === 'disconnected') return [];
  const { nodeId, subscriptionId, closeCode, closeReason, error, report } = row;
  const offlineMs = back && Math.max(back.getTime() - row.disconnectedAt.getTime(), report?.offlineMs ?? 0);
  return [{ nodeId, subscriptionId, at: row.disconnectedAt, back, offlineMs, cause: row.cause, closeCode, closeReason, error, report }];
}

/* A node's lost connections, each with its next connection, which is when it came back. */
function nodeDrops(rows: ConnectionRow[]): NodeDrop[] {
  const ofNode = new Map<string, ConnectionRow[]>();
  for (const row of rows) ofNode.set(row.nodeId, [...(ofNode.get(row.nodeId) ?? []), row]);
  return [...ofNode.values()].flatMap(own => {
    const sorted = own.toSorted((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime());
    return sorted.flatMap((row, i) => dropOf(row, sorted[i + 1]?.connectedAt ?? null));
  });
}

/* A new connection taking the place of a socket says only that the node came back first; what it saw says why. */
const causeOf = (drop: NodeDrop): DropCause => (drop.cause === 'replaced' && drop.report ? drop.report.cause : drop.cause);

function machineDrop(drops: NodeDrop[]): MachineDrop {
  const [first] = drops as [NodeDrop, ...NodeDrop[]];
  const away = drops.some(d => !d.back);
  const back = away ? null : new Date(Math.max(...drops.map(d => d.back!.getTime())));
  const offlineMs = back && Math.max(back.getTime() - first.at.getTime(), ...drops.map(d => d.offlineMs!));
  return { at: first.at, back, offlineMs, cause: causeOf(first), drops };
}

/* Newest first. */
function machineDrops(rows: ConnectionRow[]): MachineDrop[] {
  const sorted = nodeDrops(rows).toSorted((a, b) => a.at.getTime() - b.at.getTime());
  const together: NodeDrop[][] = [];
  for (const drop of sorted) {
    const last = together.at(-1);
    if (last && drop.at.getTime() - last[0]!.at.getTime() <= SAME_DROP_MS && !last.some(d => d.nodeId === drop.nodeId)) last.push(drop);
    else together.push([drop]);
  }
  return together.map(machineDrop).reverse();
}

/* The most frequent; of equally frequent ones the newest, given newest first. */
function mostFrequent(causes: DropCause[]): DropCause | null {
  const count = (cause: DropCause) => causes.filter(c => c === cause).length;
  return causes.reduce<DropCause | null>((best, cause) => (best === null || count(cause) > count(best) ? cause : best), null);
}

/* What the connections of a machine's nodes say: the last day in short, and its latest drops. */
export function connectionHistory(rows: ConnectionRow[], now: Date): ConnectionHistory {
  const all = machineDrops(rows);
  const day = all.filter(d => d.at.getTime() >= now.getTime() - SUMMARY_MS);
  const lasted = day.flatMap(d => (d.offlineMs === null ? [] : [d.offlineMs]));
  const averageMs = lasted.length ? Math.round(lasted.reduce((sum, ms) => sum + ms, 0) / lasted.length) : null;
  return { summary: { drops: day.length, averageMs, cause: mostFrequent(day.map(d => d.cause)) }, events: all.slice(0, LISTED) };
}
