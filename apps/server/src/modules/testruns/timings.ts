import { parseTimingLines, SLOWEST_TESTS, type EnvironmentSnapshot, type FileOutcome, type PartTimings, type TestFileTiming } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { basename, posix } from 'node:path';
import type { Db } from '../../db/client.js';
import { attachments, testPartTimings, testParts, testRuns } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import type { Tx } from '../tasks/state.js';
import { logName } from './run-records.js';

const RUNNER_START = /\bRUN\s+v\S+\s+(\S.*?)\s*$/;
const FILE_LINE = /^\s*[✓❯×]\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(\d+ tests?[^)]*\)\s+(\d+(?:\.\d+)?)(ms|s)\s*$/;
const TEST_LINE = /^\s+[✓×]\s+(.+?)\s+(\d+(?:\.\d+)?)(ms|s)\s*$/;
const MOST_NAME = 500;

const millis = (count: string, unit: string): number => Number(count) * (unit === 's' ? 1000 : 1);

/* A part runs in a clone called repo: what lies under it names the package. */
function packageOf(folder: string): string {
  const under = /(?:^|\/)repo(?:\/(.+))?$/.exec(folder);
  return under ? (under[1] ?? '.') : basename(folder);
}

function mostSlow(file: TestFileTiming): TestFileTiming {
  return { ...file, slowest: [...file.slowest].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_TESTS) };
}

/* A log from before the timing lines still has what the runner printed of each file: its total, and its slow tests. */
function fromRunnerOutput(log: string): PartTimings {
  const files: TestFileTiming[] = [];
  let where = '.';
  for (const line of log.split('\n')) {
    const start = RUNNER_START.exec(line);
    const file = FILE_LINE.exec(line);
    const test = file ? null : TEST_LINE.exec(line);
    if (start) where = packageOf(start[1]!);
    else if (file) files.push({ package: where, file: file[1]!, totalMs: millis(file[2]!, file[3]!), setupMs: null, testsMs: null, teardownMs: null, slowest: [] });
    else if (test) files.at(-1)?.slowest.push({ name: test[1]!.slice(0, MOST_NAME), ms: millis(test[2]!, test[3]!) });
  }
  return { files: files.map(mostSlow), packages: [] };
}

/* What a part's log says of its test files. */
export function timingsOfLog(log: string): PartTimings {
  const said = parseTimingLines(log);
  return said.files.length ? said : fromRunnerOutput(log);
}

/* What the runner of a product part said each file took, under the root of its suite. */
function reportedTimings(snapshot: EnvironmentSnapshot, files: FileOutcome[]): TestFileTiming[] {
  return files.flatMap(file => {
    const root = snapshot.description.manifest.suites.find(suite => suite.id === file.suiteId)?.root;
    return root === undefined || file.ms === undefined ? [] : [{ package: root, file: posix.relative(root, file.file), totalMs: Math.round(file.ms), setupMs: null, testsMs: null, teardownMs: null, slowest: [] }];
  });
}
/* What a part says of its test files, kept as the part ends, so the next plan knows what each file took on its machine: its log's
   timing lines, which keepTimings would read later from the same log, or else what the runner of a product part reported. */
export async function keepPartTimings(db: Db | Tx, run: Pick<typeof testRuns.$inferSelect, 'environmentSnapshot'>, part: Pick<typeof testParts.$inferSelect, 'id' | 'companyId' | 'runId'>, message: { log: string; files?: FileOutcome[] }): Promise<void> {
  const said = timingsOfLog(message.log), files = said.files.length || !run.environmentSnapshot ? said.files : reportedTimings(run.environmentSnapshot, message.files ?? []);
  await db.insert(testPartTimings).values({ partId: part.id, companyId: part.companyId, runId: part.runId, files, packages: said.packages }).onConflictDoNothing();
}

/* Reads the log of each ended part of a test run of these tasks that was not read yet, once: what it said stays as it was
   read. A part whose log has not come yet waits for the next time. Runs of work print nothing of the kind. */
export async function keepTimings(db: Db | Tx, companyId: string, taskIds: string[]): Promise<void> {
  const waiting = await db
    .select({ id: testParts.id, part: testParts.part, runId: testRuns.id, number: testRuns.number, kind: testRuns.kind, taskId: testRuns.taskId })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .leftJoin(testPartTimings, eq(testPartTimings.partId, testParts.id))
    .where(and(inArray(testRuns.taskId, taskIds), eq(testRuns.kind, 'tests'), isNull(testPartTimings.partId), notInArray(testParts.status, ['queued', 'running'])));
  for (const part of waiting) {
    const [log] = await db.select(only(attachments, 'bytes')).from(attachments).where(and(eq(attachments.taskId, part.taskId), eq(attachments.name, logName(part, part.part)))).limit(1);
    if (!log) continue;
    const said = timingsOfLog(Buffer.from(log.bytes).toString('utf8'));
    await db.insert(testPartTimings).values({ partId: part.id, companyId, runId: part.runId, ...said }).onConflictDoNothing();
  }
}
