import { authorCheckDocuments, type AuthorCheckCrap, type AuthorCheckDone, type AuthorCheckRequest } from '@hornhoof/protocol';
import { z } from 'zod';

export type AuthorCheckout = { repoUrl: string; commit: string; baseCommit: string | null; clean: boolean };
export type AuthorCheckPorts = {
  inspect(place: 'source' | 'checked', request: AuthorCheckRequest): Promise<AuthorCheckout>;
  execute(request: AuthorCheckRequest): Promise<{ exitCode: number | null; output: string }>;
  finish(request: AuthorCheckRequest): Promise<void>;
  now(): Date;
};

const Stage = z.object({ name: z.enum(['format', 'lint', 'types', 'tests', 'crapper', 'dryer']), status: z.enum(['passed', 'failed', 'unavailable']), exitCode: z.number().int().nullable() });
const Record = z.object({ version: z.literal(1), submissionCommit: z.string(), checkCommit: z.string(),
  scope: z.object({ kind: z.literal('changed'), paths: z.array(z.string()) }), stages: z.array(Stage).length(6),
  numbers: z.object({ worstCrap: z.number().nonnegative().nullable(), tests: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).nullable() }),
});

function matchingRecord(record: z.infer<typeof Record>, request: AuthorCheckRequest): boolean {
  return record.submissionCommit === request.commit && record.checkCommit === request.commit
    && JSON.stringify([...record.scope.paths].sort()) === JSON.stringify([...request.paths].sort())
    && new Set(record.stages.map(stage => stage.name)).size === 6;
}

function measuredCrap(record: z.infer<typeof Record>, request: AuthorCheckRequest): AuthorCheckCrap {
  if (record.numbers.worstCrap === null) return { kind: authorCheckDocuments(request.paths) ? 'no_functions' : 'unknown' };
  const measured = record.stages.every(stage => stage.name === 'format' || (stage.status === 'passed' && stage.exitCode === 0));
  if (!measured || !record.numbers.tests || record.numbers.tests.passed === 0 || record.numbers.tests.failed !== 0) return { kind: 'unknown' };
  return { kind: 'measured', max: record.numbers.worstCrap };
}

export function parseAuthorCheckOutput(output: string, request: AuthorCheckRequest): AuthorCheckCrap | null {
  const records = output.split('\n').filter(line => line.startsWith('AUTHOR_CHECK '));
  if (records.length !== 1) return null;
  try {
    const record = Record.safeParse(JSON.parse(records[0]!.slice('AUTHOR_CHECK '.length)));
    return record.success && matchingRecord(record.data, request) ? measuredCrap(record.data, request) : null;
  } catch { return null; }
}

export function authorCheckoutRefusal(checkout: AuthorCheckout, request: AuthorCheckRequest): AuthorCheckDone['reason'] {
  if (checkout.repoUrl !== request.repoUrl) return 'repository_mismatch';
  if (checkout.commit !== request.commit) return 'sha_mismatch';
  if (checkout.baseCommit !== request.baseCommit) return 'base_mismatch';
  return checkout.clean ? null : 'dirty_tree';
}

async function checkedResult(request: AuthorCheckRequest, ports: AuthorCheckPorts): Promise<Pick<AuthorCheckDone, 'exitCode' | 'crap' | 'reason'>> {
  const refused = authorCheckoutRefusal(await ports.inspect('source', request), request);
  if (refused) return { exitCode: null, crap: { kind: 'unknown' }, reason: refused };
  const result = await ports.execute(request);
  const changed = authorCheckoutRefusal(await ports.inspect('checked', request), request) ?? authorCheckoutRefusal(await ports.inspect('source', request), request);
  if (changed) return { exitCode: null, crap: { kind: 'unknown' }, reason: 'checkout_changed' };
  if (result.exitCode !== 0) return { exitCode: result.exitCode, crap: { kind: 'unknown' }, reason: 'failed' };
  const crap = parseAuthorCheckOutput(result.output, request);
  return { exitCode: result.exitCode, crap: crap ?? { kind: 'unknown' }, reason: crap ? null : 'invalid_output' };
}

export async function runAuthorCheck(request: AuthorCheckRequest, ports: AuthorCheckPorts): Promise<AuthorCheckDone> {
  const startedAt = ports.now().toISOString();
  let result: Pick<AuthorCheckDone, 'exitCode' | 'crap' | 'reason'>;
  try { result = await checkedResult(request, ports); }
  catch { result = { exitCode: null, crap: { kind: 'unknown' }, reason: 'unavailable' }; }
  finally { await ports.finish(request); }
  return { ...request, type: 'author_check.done', ...result, startedAt, finishedAt: ports.now().toISOString() };
}
