/* What the tests of turn-tag-close.test.ts start from, also the ones that take a database of their own. */
import { and, asc, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { approvalPolicies, departments, tasks, turns } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { BASE } from './development-echelons-fixture.js';
import { releasing, turnkeyAfterR } from './turn-release-fixture.js';

export const LATER = '4'.repeat(40);
export const OTHER = '3'.repeat(40);

/* A turn whose start the server has seen, its release recorded before main moved, then main moved and tagged. */
export async function released(options: { approval?: boolean; record?: boolean; tag?: string; at?: string; autonomous?: boolean; turnkey?: boolean } = {}) {
  const f = await releasing();
  const errors: string[] = [];
  const round = () => minuteRound(f.ctx, new Date(), what => () => { errors.push(what); });
  f.repo.tags['v1.6.0'] = BASE;
  await round();
  /* turnkey: the release also brings turnkey work its holder checked itself, joined to the turn branch after R. */
  const work = options.turnkey ? await turnkeyAfterR(f) : null;
  const commit = work?.head ?? f.R;
  const run = await f.fullRun({ commit });
  /* With autonomous release on, a release every commit of which was checked is approved by the log, by no person. */
  if (options.autonomous) {
    await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
    await f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!));
  } else if (options.approval !== false) await f.approve(commit);
  if (options.record !== false) expect((await f.recordRelease({ commit, runId: run.id })).isError).toBe(false);
  f.repo.heads.main = commit;
  f.repo.tags[options.tag ?? 'v1.7.0'] = options.at ?? commit;
  const departmentTurns = () => f.db.select().from(turns).where(eq(turns.departmentId, f.task.departmentId!)).orderBy(asc(turns.number));
  const open = async () => (await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open'))))[0]!;
  /* Another result of the turn, accepted after its release was recorded. */
  const lateResult = async () => {
    const { task } = await f.create({ title: 'Late change' });
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId: f.turn.id }).where(eq(tasks.id, task.id));
    return task;
  };
  return { ...f, round, errors, departmentTurns, open, lateResult, run, work, commit };
}
