import type { EnvironmentSnapshot } from '@hornhoof/protocol';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { posix } from 'node:path';
import type { Ctx } from '../../app.js';
import { testPartTimings, testParts, testRuns } from '../../db/schema.js';
import type { PlanningHistory } from './plan-history.js';
import { machinePaces, type FileTime } from './plan-speed.js';
import { median } from './plan-statistics.js';

/* The parts of a repository whose times a plan reads: the last ones, enough for each machine to have run most files. */
const PARTS_READ = 40;
const FALLBACK = { setupMs: 10_000, collectMs: 1000 };

type Row = { computer: string | null; files: (typeof testPartTimings.$inferSelect)['files']; receipt: (typeof testParts.$inferSelect)['environmentReceipt'] };

/* What a part said a file took, for the one unit of the inventory at that path. */
function fileTimes(rows: Row[], snapshot: EnvironmentSnapshot): { times: FileTime[]; unmatched: number } {
  const units = new Map<string, { suiteId: string; file: string }[]>();
  for (const unit of snapshot.description.inventory) units.set(unit.file, [...(units.get(unit.file) ?? []), unit]);
  const times: FileTime[] = [];
  let unmatched = 0;
  for (const row of rows) for (const file of row.files) {
    const found = units.get(posix.join(file.package, file.file));
    if (found?.length === 1 && row.computer) times.push({ computer: row.computer, suiteId: found[0]!.suiteId, file: found[0]!.file, ms: file.totalMs });
    else unmatched++;
  }
  return { times, unmatched };
}
/* What a part spends before its tests start: the checkout, the dependencies, the environment and its services. */
function setupOf(rows: Row[]): number | null {
  const spent = rows.flatMap(row => {
    const phases = row.receipt?.phases;
    return phases ? [phases.checkoutMs + phases.dependenciesMs + phases.environmentMs + phases.servicesMs] : [];
  });
  return spent.length ? median(spent) : null;
}

/* What the last parts of this repository took, file by file and machine by machine, as their logs said when they ended. */
export function measuredHistory(ctx: Pick<Ctx, 'db'>) {
  return async (_run: unknown, snapshot: EnvironmentSnapshot): Promise<PlanningHistory | null> => {
    const scope = snapshot.description.repositoryScope;
    const rows = await ctx.db.select({ computer: testParts.computer, files: testPartTimings.files, receipt: testParts.environmentReceipt })
      .from(testPartTimings).innerJoin(testParts, eq(testParts.id, testPartTimings.partId)).innerJoin(testRuns, eq(testRuns.id, testPartTimings.runId))
      .where(and(eq(testRuns.companyId, scope.companyId), eq(testRuns.departmentId, scope.repositoryOwnerId), sql`${testRuns.environmentRequest}->'repositoryScope'->>'repoUrlHash' = ${scope.repoUrlHash}`,
        inArray(testParts.status, ['passed', 'failed']), isNotNull(testParts.computer)))
      .orderBy(desc(testPartTimings.createdAt), desc(testPartTimings.partId)).limit(PARTS_READ);
    const { times, unmatched } = fileTimes(rows, snapshot);
    if (!times.length) return null;
    const { paces, durations } = machinePaces(times), setupMs = setupOf(rows);
    return { durations, paces, unmatchedFiles: unmatched, usedPartIds: [],
      costs: { setupMs: setupMs ?? FALLBACK.setupMs, collectMs: FALLBACK.collectMs },
      costBasis: { setup: setupMs === null ? 'fallback' : 'historical', collection: 'fallback' } };
  };
}
