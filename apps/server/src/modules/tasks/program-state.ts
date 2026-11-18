import { type TurnAlarm, type TurnProgram } from '@hornhoof/protocol/map';
import type { Ctx } from '../../app.js';
import { jobs } from '../../db/schema.js';
import { dropTurnSign } from './turn-signs.js';
export type Job = typeof jobs.$inferSelect;
export type GoneProgram = { state: 'gone'; exitCode: number | null; signal: string | null; screen: string | null };
/* goneAt: when the node first said, in this server's time, that the program is gone, while it still says so. */
export type StoredProgram = { program: TurnProgram; gone: GoneProgram | null; goneAt: number | null };

export const turnPrograms = new WeakMap<Ctx, Map<string, StoredProgram>>();
export const turnAlarms = new WeakMap<Ctx, Map<string, TurnAlarm>>();

export function mapOf<V>(store: WeakMap<Ctx, Map<string, V>>, ctx: Ctx): Map<string, V> {
  const map = store.get(ctx) ?? new Map<string, V>();
  store.set(ctx, map);
  return map;
}

/* Take the end's details before clearing the live state; they belong to the failed event, not to the next turn. */
export function clearTurnProgram(ctx: Ctx, jobId: string): GoneProgram | null {
  const gone = mapOf(turnPrograms, ctx).get(jobId)?.gone ?? null;
  mapOf(turnPrograms, ctx).delete(jobId);
  mapOf(turnAlarms, ctx).delete(jobId);
  dropTurnSign(ctx, jobId);
  return gone;
}

/* Since when the turn's node says its program is gone, in this server's time; null while it says the program is there. */
export function programGoneSince(ctx: Ctx, jobId: string): number | null {
  return mapOf(turnPrograms, ctx).get(jobId)?.goneAt ?? null;
}

export function agentProgramState(
  ctx: Ctx,
  running: { id: string } | null | undefined,
  visible?: boolean,
): { program: TurnProgram | null; alarm: TurnAlarm | null } {
  if (visible === false || !running) return { program: null, alarm: null };
  return {
    program: mapOf(turnPrograms, ctx).get(running.id)?.program ?? null,
    alarm: mapOf(turnAlarms, ctx).get(running.id) ?? null,
  };
}

/* A node says 0 until the program gives its first sign; until then the quiet counts from the turn start. */
export function signInTurn(program: Pick<TurnProgram, 'signAt'>, job: Pick<Job, 'startedAt' | 'createdAt'>): number | null {
  return program.signAt === 0 ? (job.startedAt ?? job.createdAt).getTime() : program.signAt;
}
