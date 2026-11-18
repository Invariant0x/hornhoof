import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { docsOnly, type AuthorCheckDone, type AuthorCheckRun } from '@hornhoof/protocol';
import { z } from 'zod';
import { currentCheckLease, withCheckSlot } from './check-queue.js';
import { prepareFolder, type JobUser } from './isolation.js';
import { runProgram } from './providers/process.js';
import type { TestPartUser } from './test-environment.js';
import { authorComparison, checkoutCommit } from './test-mirror.js';
import { partBase, stopTestUser } from './tests.js';

const CHECK_MS = 30 * 60_000;
const STAGES = ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'] as const;
const RecordStage = z.object({
  name: z.enum(STAGES), status: z.enum(['passed', 'failed', 'unavailable']), exitCode: z.number().int().nullable(), reason: z.string().optional(),
});
const CheckRecord = z.object({
  version: z.literal(1), submissionCommit: z.string(), checkCommit: z.string(),
  scope: z.object({ kind: z.enum(['changed', 'package']), paths: z.array(z.string()) }),
  stages: z.array(RecordStage).length(STAGES.length),
  numbers: z.object({ worstCrap: z.number().nonnegative().nullable() }),
});
const RECORD_PREFIX = 'AUTHOR_CHECK ';

export function authorCrap(records: string[], pin: AuthorCheckRun['pin']): number | null {
  if (records.length !== 1) return null;
  try {
    const result = CheckRecord.safeParse(JSON.parse(records[0]!));
    if (!result.success) return null;
    const record = result.data;
    if (record.submissionCommit !== pin.commit || record.checkCommit !== pin.commit) return null;
    if (JSON.stringify(record.scope.paths.toSorted()) !== JSON.stringify(pin.paths.toSorted())) return null;
    if (new Set(record.stages.map(stage => stage.name)).size !== STAGES.length) return null;
    if (record.stages.some(stage => stage.status === 'failed' || (stage.status === 'passed' && stage.exitCode !== 0))) return null;
    const complexity = record.stages.find(stage => stage.name === 'crapper');
    if (complexity?.status === 'passed') {
      return record.numbers.worstCrap ?? (complexity.reason === 'no_new_or_grown_functions' ? 0 : null);
    }
    return docsOnly(pin.paths) && complexity?.status === 'unavailable' && complexity.exitCode === null && complexity.reason === 'no_source_changed' ? 0 : null;
  } catch {
    return null;
  }
}

function authorEnvironment(root: string, dir: string) {
  return { ...partBase(root, dir, currentCheckLease()), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

async function stillPinned(run: AuthorCheckRun, dir: string, user: JobUser, root: string, repo: string, signal: AbortSignal): Promise<boolean> {
  const options = { bin: '/usr/bin/git', cwd: repo, env: authorEnvironment(root, dir), user, signal, timeoutMs: 30_000 };
  const head = await runProgram({ ...options, args: ['rev-parse', 'HEAD'] });
  if (head.code !== 0 || head.output.trim() !== run.pin.commit) return false;
  const status = await runProgram({ ...options, args: ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=no'] });
  return !signal.aborted && status.code === 0 && status.output.trim() === '';
}

async function scoreAt(run: AuthorCheckRun, dir: string, user: JobUser, root: string, repo: string, signal: AbortSignal): Promise<number | null> {
  const records: string[] = [];
  const result = await runProgram({
    bin: process.execPath, args: ['scripts/author-check.mjs', '--sha', run.pin.commit, '--base', run.pin.baseCommit],
    cwd: repo, env: authorEnvironment(root, dir), timeoutMs: CHECK_MS, user, signal,
    onLine: line => {
      if (line.startsWith(RECORD_PREFIX) && records.length < 2) records.push(line.slice(RECORD_PREFIX.length));
    },
  });
  return result.code === 0 && !result.timedOut && !signal.aborted ? authorCrap(records, run.pin) : null;
}

async function runAuthorCheck(run: AuthorCheckRun, dir: string, user: JobUser, signal: AbortSignal) {
  const context = { cacheRoot: join(dir, 'cache'), deadline: Date.now() + CHECK_MS, signal, log: () => {} };
  const cherryPick = await authorComparison(run, context);
  if (run.verifyCherryPick && !cherryPick) return { crap: null, cherryPick };
  const runs = join(dir, 'runs');
  await mkdir(runs, { recursive: true });
  const root = await mkdtemp(join(runs, 'author-check-'));
  try {
    await chmod(root, 0o711);
    const repo = join(root, 'repo');
    await checkoutCommit(run.repo, run.repositoryScope, run.pin.commit, repo, context);
    for (const folder of [repo, join(root, 'home'), join(root, 'tmp')]) prepareFolder(folder, user);
    await stopTestUser(user);
    const crap = await scoreAt(run, dir, user, root, repo, signal);
    if (crap === null) return { crap, cherryPick };
    await stopTestUser(user);
    return { crap: await stillPinned(run, dir, user, root, repo, signal) ? crap : null, cherryPick };
  } finally {
    await stopTestUser(user);
    await rm(root, { recursive: true, force: true });
  }
}

export class AuthorChecks {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly dir: string, private readonly user: JobUser | null,
    private readonly partUser: TestPartUser, private readonly emit: (result: AuthorCheckDone) => void) {}

  start(run: AuthorCheckRun): void {
    if (this.running.has(run.requestId)) return;
    const controller = new AbortController();
    this.running.set(run.requestId, controller);
    const user = this.user;
    const checked = user && user.uid !== 0 && user.uid !== process.getuid?.()
      ? withCheckSlot(signal => this.partUser.run(signal, () => runAuthorCheck(run, this.dir, user, signal), () => {}),
        { signal: controller.signal, label: 'check:author receipt' }) : Promise.reject(new Error('No isolated check user.'));
    void checked.catch(() => ({ crap: null, cherryPick: null })).then(result => this.emit({
      ...result, type: 'author_check.done', requestId: run.requestId, taskId: run.pin.taskId, commit: run.pin.commit,
    })).finally(() => { this.running.delete(run.requestId); });
  }

  stop(): void {
    for (const controller of this.running.values()) controller.abort();
  }
}
