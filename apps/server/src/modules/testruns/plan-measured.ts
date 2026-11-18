import type { EnvironmentSnapshot } from '@hornhoof/protocol';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { posix } from 'node:path';
import type { Ctx } from '../../app.js';
import { testPartTimings, testParts, testRuns } from '../../db/schema.js';
import type { PlanningHistory } from './plan-history.js';
import { machinePaces, partPaces, type FileTime, type PartTime } from './plan-speed.js';
import { median } from './plan-statistics.js';

/* The parts of a repository whose times a plan reads: the last ones, enough for each machine to have run most files. */
const PARTS_READ = 40;
/* The preparations that passed whose times a plan reads, the last ones. */
const PREPARATIONS_READ = 5;
const FALLBACK = { setupMs: 10_000, collectMs: 1000 };

type Row = { computer: string | null; files: (typeof testPartTimings.$inferSelect)['files']; receipt: (typeof testParts.$inferSelect)['environmentReceipt']; selection: (typeof testParts.$inferSelect)['environmentSelection']; error: string | null };

/* What a part said a file took, for the one unit of the inventory at that path. */
function fileTimes(rows: Row[], snapshot: EnvironmentSnapshot): FileTime[] {
  const units = new Map<string, { suiteId: string; file: string }[]>();
  for (const unit of snapshot.description.inventory) units.set(unit.file, [...(units.get(unit.file) ?? []), unit]);
  const times: FileTime[] = [];
  for (const row of rows) for (const file of row.files) {
    const found = units.get(posix.join(file.package, file.file));
    if (found?.length === 1 && row.computer) times.push({ computer: row.computer, suiteId: found[0]!.suiteId, file: found[0]!.file, ms: file.totalMs });
  }
  return times;
}
/* How long each part's command ran, for all its files: only a part whose command ran to its end, passed or failed, ran them all. One
   stopped at its limit, or by anything else, ran only some of them in that time. */
export function partTimes(rows: Row[]): PartTime[] {
  return rows.filter(row => row.error === null || row.error === 'failed').flatMap(row => {
    const selection = row.selection?.selection, ms = row.receipt?.phases.commandMs;
    const suites = selection?.kind === 'batch' ? selection.selections : selection?.kind === 'suite' ? [selection] : [];
    const files = suites.flatMap(suite => suite.files.map(file => ({ suiteId: suite.suiteId, file })));
    return row.computer && ms !== undefined && files.length ? [{ computer: row.computer, ms, files }] : [];
  });
}
/* What a part spends before its tests start: the checkout, the dependencies, the environment and its services. */
const setupMsOf = (phases: NonNullable<Row['receipt']>['phases']): number => phases.checkoutMs + phases.dependenciesMs + phases.environmentMs + phases.servicesMs;
function setupOf(rows: Row[]): number | null {
  const spent = rows.flatMap(row => row.receipt ? [setupMsOf(row.receipt.phases)] : []);
  return spent.length ? median(spent) : null;
}
/* How long a preparation takes from its start to its end, at the middle pace: what it took on a computer over that computer's pace. */
function preparationOf(rows: Pick<Row, 'computer' | 'receipt'>[], paces: Map<string, number>): number | undefined {
  const took = rows.flatMap(row => row.receipt && row.computer ? [(setupMsOf(row.receipt.phases) + row.receipt.phases.commandMs) / (paces.get(row.computer) ?? 1)] : []);
  return took.length ? median(took) : undefined;
}

/* What the last parts of this repository took, file by file and machine by machine, as they said when they ended. */
export function measuredHistory(ctx: Pick<Ctx, 'db'>) {
  return async (_run: unknown, snapshot: EnvironmentSnapshot): Promise<PlanningHistory | null> => {
    const scope = snapshot.description.repositoryScope;
    const repository = and(eq(testRuns.companyId, scope.companyId), eq(testRuns.departmentId, scope.repositoryOwnerId), sql`${testRuns.environmentRequest}->'repositoryScope'->>'repoUrlHash' = ${scope.repoUrlHash}`);
    const rows = await ctx.db.select({ computer: testParts.computer, files: testPartTimings.files, receipt: testParts.environmentReceipt, selection: testParts.environmentSelection, error: testParts.error })
      .from(testPartTimings).innerJoin(testParts, eq(testParts.id, testPartTimings.partId)).innerJoin(testRuns, eq(testRuns.id, testPartTimings.runId))
      .where(and(repository, inArray(testParts.status, ['passed', 'failed']), isNotNull(testParts.computer)))
      .orderBy(desc(testPartTimings.createdAt), desc(testPartTimings.partId)).limit(PARTS_READ);
    const times = fileTimes(rows, snapshot);
    if (!times.length) return null;
    /* The files' sizes come from what each took, the machines' paces from how long their parts ran. */
    const { paces, durations } = partPaces(partTimes(rows), machinePaces(times).durations), setupMs = setupOf(rows);
    const preparations = await ctx.db.select({ computer: testParts.computer, receipt: testParts.environmentReceipt })
      .from(testParts).innerJoin(testRuns, eq(testRuns.id, testParts.runId))
      .where(and(repository, eq(testParts.status, 'passed'), isNotNull(testParts.computer), sql`${testParts.environmentSelection}->'selection'->>'kind' = 'prepare'`))
      .orderBy(desc(testParts.finishedAt), desc(testParts.id)).limit(PREPARATIONS_READ);
    const preparationMs = preparationOf(preparations, paces);
    return { durations, paces, unknownFileMs: median(durations.map(duration => duration.ms)), ...(preparationMs ? { preparationMs } : {}),
      costs: { setupMs: setupMs ?? FALLBACK.setupMs, collectMs: FALLBACK.collectMs } };
  };
}
