import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { posix } from 'node:path';
import type { Ctx } from '../../app.js';
import { agents, tasks, testParts, testPartTimings, testRuns } from '../../db/schema.js';
import { median } from '../testruns/plan-statistics.js';
import { checkHolderName, claimedDescription, claimedPart, onClaimNode } from './check-slot-details.js';
import type { CheckClaim } from './check-slots-queue.js';
import { checkQueueSnapshot, waitingCheckClaims } from './check-slots.js';
import { identityOfKey, ownBuiltin } from './hub.js';

type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
type Target = { run: Run; part: Part | null; task: typeof tasks.$inferSelect };
type Agent = typeof agents.$inferSelect;

async function targetOf(ctx: Ctx, claim: CheckClaim): Promise<Target | null> {
  const partId = claimedPart(claim);
  if (!partId) {
    const description = await claimedDescription(ctx, claim);
    return description && { ...description, part: null };
  }
  const [row] = await ctx.db.select({ part: testParts, run: testRuns, task: tasks }).from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId)).innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(and(eq(testParts.id, partId), eq(testParts.status, 'running'), eq(testRuns.kind, 'tests'), eq(testRuns.status, 'running')));
  return row && onClaimNode(ctx, claim, row.part) ? row : null;
}

type Timing = Pick<typeof testPartTimings.$inferSelect, 'runId' | 'files'>;
async function recentTimings(ctx: Ctx, { run, part }: Target): Promise<Timing[]> {
  const request = run.environmentRequest;
  const repository = request
    ? sql`${testRuns.environmentRequest}->'repositoryScope'->>'repoUrlHash' = ${request.repositoryScope.repoUrlHash}`
    : eq(testRuns.command, run.command);
  const owner = run.departmentId ? eq(testRuns.departmentId, run.departmentId) : and(isNull(testRuns.departmentId), eq(testRuns.taskId, run.taskId));
  const suite = !part && request ? sql`${testRuns.environmentRequest}->>'suite' is not distinct from ${request.suite ?? null}` : undefined;
  const recent = ctx.db.select({ id: testRuns.id }).from(testRuns)
    .where(and(eq(testRuns.companyId, run.companyId), eq(testRuns.kind, 'tests'), owner, repository, suite, inArray(testRuns.status, ['passed', 'failed'])))
    .orderBy(desc(testRuns.createdAt), desc(testRuns.id)).limit(40);
  return ctx.db.select({ runId: testPartTimings.runId, files: testPartTimings.files }).from(testPartTimings)
    .innerJoin(testParts, eq(testParts.id, testPartTimings.partId))
    .where(and(inArray(testPartTimings.runId, recent), inArray(testParts.status, ['passed', 'failed']), or(isNull(testParts.error), eq(testParts.error, 'failed')),
      part && !part.environmentSelection ? eq(testParts.part, part.part) : undefined));
}

/* A description has no new inventory yet. Use older runs of the same repository and suite. A planned part can name its files. */
function usualMs(part: Part | null, history: Timing[]): number | null {
  const selection = part?.environmentSelection?.selection;
  if (selection && selection.kind !== 'suite' && selection.kind !== 'batch') return null;
  if (selection) {
    const wanted = new Set((selection.kind === 'batch' ? selection.selections : [selection]).flatMap(suite => suite.files));
    const samples = new Map<string, number[]>();
    for (const { files } of history) for (const file of files) {
      const path = posix.join(file.package, file.file);
      if (wanted.has(path) && file.totalMs > 0) samples.set(path, [...(samples.get(path) ?? []), file.totalMs]);
    }
    return wanted.size && samples.size === wanted.size ? [...samples.values()].reduce((sum, values) => sum + median(values), 0) : null;
  }
  const totals = new Map<string, number>();
  for (const { runId, files } of history) {
    const ms = files.reduce((sum, file) => sum + file.totalMs, 0);
    if (ms > 0) totals.set(runId, (totals.get(runId) ?? 0) + ms);
  }
  return totals.size ? median([...totals.values()]) : null;
}

export async function* slowCheckWaits(ctx: Ctx, now: number) {
  for (const claim of waitingCheckClaims(ctx, now)) {
    const target = await targetOf(ctx, claim);
    if (!target) continue;
    const usual = usualMs(target.part, await recentTimings(ctx, target));
    if (usual === null || now - claim.queuedAt <= usual) continue;
    const node = identityOfKey(claim.node, ownBuiltin(ctx.config)), snapshot = checkQueueSnapshot(ctx, node);
    if (snapshot?.holders.length && snapshot.queue.some(entry => entry.request.id === claim.request.id)) yield { claim, target, holders: snapshot.holders };
  }
}

export async function checkWaitWords(ctx: Ctx, { run, part }: Target, holders: CheckClaim[], agent: Agent, operations: boolean) {
  const viewer = { id: run.jobId, companyId: run.companyId, agentId: agent.id, agentKind: agent.kind, departmentId: agent.departmentId, roleKey: agent.roleKey, skills: agent.skills };
  const names = await Promise.all(holders.map(holder => checkHolderName(ctx, viewer, holder, operations)));
  const en = part ? `Test run ${run.number}, part ${part.part}` : `Environment description for test run ${run.number}`;
  const ru = part ? `Запуск проверок ${run.number}, часть ${part.part}` : `Описание среды для запуска проверок ${run.number}`;
  return {
    en: `${en} has waited for a machine check slot longer than its test files usually take. Holding the slot: ${names.map(name => name.en).join(', ')}.`,
    ru: `${ru}: ожидание места для проверки длится дольше, чем обычно идут сами проверки. Место занято: ${names.map(name => name.ru).join(', ')}.`,
  };
}
