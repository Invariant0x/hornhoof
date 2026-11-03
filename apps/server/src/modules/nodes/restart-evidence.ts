import type { Boot, NodeExit, NodeMessage } from '@hornhoof/protocol';
import { sql, type SQL } from 'drizzle-orm';
import { jobs, type Interruption, type RestartCause } from '../../db/schema.js';

export type NodeBoot = Boot & { stopped?: NodeExit };
export type Hello = Extract<NodeMessage, { type: 'hello' }>;
export type RestartCut = Omit<Interruption, 'task'> & { fallback?: { runningSince: string; diagnosis: NodeExit } };

const unknown = (): NodeExit => ({ kind: 'unknown', reason: 'unknown', startedAt: null, at: null, log: '' });

function disconnected(now: Hello, at: Date): NodeExit {
  if (now.nodeLog === undefined) return unknown();
  return { kind: 'unplanned', reason: 'disconnected', startedAt: now.boot?.startedAt ?? null, at: at.toISOString(), log: now.nodeLog };
}

function previous(before: NodeBoot | null, report?: NodeExit): NodeExit {
  if (!report) return unknown();
  if (before && report.startedAt !== before.startedAt) return unknown();
  return report;
}

function diagnosis(before: NodeBoot | null, now: Hello, at: Date): NodeExit {
  if (before && before.startedAt === now.boot?.startedAt) return disconnected(now, at);
  return before?.stopped ?? previous(before, now.restart);
}

/* On a server's first built-in hello, a node may still be the process that ran the job. Its previous exit then belongs
   to an older job. Compare each job's start with the current process start before attributing that exit to the job. */
function serverFallback(cause: RestartCause, now: Hello, at: Date): RestartCut['fallback'] {
  if (cause !== 'server' || !now.boot || now.nodeLog === undefined) return undefined;
  return { runningSince: now.boot.startedAt, diagnosis: { kind: 'planned', reason: 'server_restart', startedAt: now.boot.startedAt, at: at.toISOString(), log: now.nodeLog } };
}

export function restartDetails(before: { boot: NodeBoot | null } | null, now: Hello, cause: RestartCause, at: Date) {
  return { diagnosis: diagnosis(before?.boot ?? null, now, at), fallback: serverFallback(cause, now, at) };
}

export function interruptionValue(cut: RestartCut): SQL {
  const { fallback, ...record } = cut;
  const value = sql`${JSON.stringify(record)}::jsonb`;
  if (!fallback) return value;
  const current = { ...record, diagnosis: fallback.diagnosis };
  return sql`case when ${jobs.startedAt} < ${fallback.runningSince}::timestamptz then ${value} else ${JSON.stringify(current)}::jsonb end`;
}
