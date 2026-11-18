import { PROGRAM_STATES } from '@hornhoof/protocol';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import type { Tx } from './state.js';
import { agentEvents, jobs } from '../../db/schema.js';
import type { FactTurn, ProgramPoint } from './tree-programs.js';

const Alarm = z.object({ reason: z.enum(['program_stalled', 'node_silent']), since: z.number().finite() });
const Change = z.object({
  program: z.object({ state: z.enum(PROGRAM_STATES), since: z.number().finite(), tool: z.string().nullable() }).nullable(),
  alarm: Alarm.nullable(),
});
const OldAlarm = z.object({ silentJob: z.string(), silentReason: Alarm.shape.reason, text: z.string() });
const Failed = z.object({ program: z.object({ state: z.literal('gone') }) });
type HistoryRow = { jobId: string | null; kind: string; data: unknown; createdAt: Date | string };
type KeptPoint = { jobId: string; point: ProgramPoint };

function historyRows(db: Db | Tx, jobIds: string[]) {
  const direct = and(inArray(agentEvents.jobId, jobIds), sql`${agentEvents.kind} in ('program', 'failed')`);
  const legacy = and(sql`${agentEvents.kind} = 'message'`, sql`${agentEvents.data} ? 'silentJob'`, inArray(sql`(${agentEvents.data}->>'silentJob')`, jobIds));
  return db.select({ jobId: agentEvents.jobId, kind: agentEvents.kind, data: agentEvents.data, createdAt: agentEvents.createdAt })
    .from(agentEvents).where(or(direct, legacy)).orderBy(asc(agentEvents.createdAt), asc(agentEvents.seq));
}

/* The same query as the reader, exposed for checking its plan on realistic event volumes. */
export function historyQuery(db: Db, jobIds: string[]): SQL {
  return historyRows(db, jobIds).getSQL();
}

function oldAlarm(row: HistoryRow, at: Date): KeptPoint[] {
  const parsed = OldAlarm.safeParse(row.data);
  if (!parsed.success) return [];
  const said = /Last change: [^(]*\(([^)]+)\)/.exec(parsed.data.text);
  const since = Date.parse(said?.[1] ?? '');
  if (!Number.isFinite(since)) return [];
  return [{ jobId: parsed.data.silentJob, point: { at, program: null, alarm: { reason: parsed.data.silentReason, since } } }];
}

function directPoint(row: HistoryRow, at: Date): KeptPoint[] {
  if (!row.jobId) return [];
  if (row.kind === 'failed') {
    if (!Failed.safeParse(row.data).success) return [];
    return [{ jobId: row.jobId, point: { at, program: { state: 'gone', since: at.getTime(), tool: null }, alarm: null } }];
  }
  const parsed = Change.safeParse(row.data);
  return parsed.success ? [{ jobId: row.jobId, point: { ...parsed.data, at } }] : [];
}

function keptPoints(row: HistoryRow): KeptPoint[] {
  const at = new Date(row.createdAt);
  return row.kind === 'message' ? oldAlarm(row, at) : directPoint(row, at);
}

async function readHistory(db: Db | Tx, jobIds: string[]): Promise<Map<string, ProgramPoint[]>> {
  const rows = await historyRows(db, jobIds);
  const out = new Map<string, ProgramPoint[]>();
  for (const { jobId, point } of rows.flatMap(keptPoints)) out.set(jobId, [...(out.get(jobId) ?? []), point]);
  return out;
}

/* Up to the end of a turn that is over; a running turn has no end yet. */
export const upTo = (column: AnyColumn, until?: Date): SQL | undefined => (until ? lte(column, until) : undefined);

/* All turns of participating agents, including a conversation that held their task turns in the queue. */
export async function readTurnHistory(db: Db | Tx, companyId: string, agentIds: string[], from: Date, until?: Date): Promise<FactTurn[]> {
  if (!agentIds.length) return [];
  const rows = await db.select({ id: jobs.id, taskId: jobs.taskId, agentId: jobs.agentId, createdAt: jobs.createdAt,
    startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, status: jobs.status }).from(jobs)
    .where(and(eq(jobs.companyId, companyId), eq(jobs.kind, 'conversation'), inArray(jobs.agentId, agentIds), or(isNull(jobs.finishedAt), gte(jobs.finishedAt, from)), upTo(jobs.createdAt, until)))
    .orderBy(asc(jobs.createdAt));
  if (!rows.length) return [];
  const points = await readHistory(db, rows.map(r => r.id));
  return rows.flatMap(r => r.agentId ? [{ ...r, agentId: r.agentId, history: points.get(r.id) ?? [] }] : []);
}
