import { vitestMemoryWorkers, type Command, type TestEnvironmentV1, type TestExecution } from '@hornhoof/protocol';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { departments, testParts, testRuns } from '../../db/schema.js';
import { TEST_MEMORY_GB } from '../departments/repository.js';

const GIB = 1024 ** 3;
type Selection = TestExecution['selection'];

export type PartNeed = { memoryBytes: number; cores: number };
export type PartBudget = PartNeed & { vitestWorkers: number };

export const needOf = (run: { memoryGb: number | null }, department: { repoTestMemoryGb: number | null } | null): number =>
  run.memoryGb ?? department?.repoTestMemoryGb ?? TEST_MEMORY_GB;

/* The commands within one part run in sequence, or share one Vitest pool. The largest demand sets the budget. */
function commandsFor(manifest: TestEnvironmentV1, selection: Selection): Command[] {
  if (selection.kind === 'batch') return selection.selections.flatMap(suite => commandsFor(manifest, suite));
  if (selection.kind === 'prepare') {
    const preparation = manifest.execution?.oncePreparation;
    if (!preparation) return [];
    return [...manifest.suites.filter(suite => preparation.suiteIds.includes(suite.id)).map(suite => suite.run), ...preparation.commands];
  }
  const suite = manifest.suites.find(candidate => candidate.id === selection.suiteId);
  if (!suite) return [];
  return selection.kind === 'final' ? suite.finalChecks ?? [] : [suite.run];
}

function pinnedWorkers(args: string[]): number | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const flag = /^(?:--workers|--maxWorkers|--max-workers)(?:=(.*))?$/.exec(args[i]!);
    if (!flag) continue;
    const value = Number(flag[1] ?? args[i + 1]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  return undefined;
}

const isVitest = (command: Command): boolean => [command.program, ...command.args].some(arg => /(?:^|[/\\])vitest(?:\.[cm]?js)?$/.test(arg));

export function partBudget(memoryGb: number, manifest?: TestEnvironmentV1 | null, selection?: Selection): PartBudget {
  const memoryBytes = memoryGb * GIB, vitestWorkers = vitestMemoryWorkers(memoryBytes);
  const commands = manifest && selection ? commandsFor(manifest, selection) : [];
  const cores = commands.length ? Math.max(...commands.map(command => pinnedWorkers(command.args) ?? (isVitest(command) ? vitestWorkers : 1))) : vitestWorkers;
  return { memoryBytes, cores, vitestWorkers };
}

export function bookedParts(db: Db, which?: SQL) {
  return db.select({ computer: testParts.computer, machineId: testParts.machineId, builtin: testParts.builtin, builtinMachine: testParts.builtinMachine, nodeId: testParts.nodeId,
    selection: testParts.environmentSelection, memoryGb: testRuns.memoryGb, repoTestMemoryGb: departments.repoTestMemoryGb,
    manifest: sql<TestEnvironmentV1 | null>`${testRuns.environmentSnapshot}->'description'->'manifest'` })
    .from(testParts).innerJoin(testRuns, eq(testRuns.id, testParts.runId)).leftJoin(departments, eq(departments.id, testRuns.departmentId))
    .where(and(eq(testParts.status, 'running'), which));
}

export function bookedBudget(part: Awaited<ReturnType<typeof bookedParts>>[number]): PartBudget {
  return partBudget(needOf(part, part), part.manifest, part.selection?.selection);
}
