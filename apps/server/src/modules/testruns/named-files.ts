import type { Ctx } from '../../app.js';
import { refuse } from '../tasks/state.js';
import type { TestRunMode } from './describe.js';
import type { RepoAddress } from './refs.js';

/* A file a test runner takes by its name: a test or spec file of JavaScript or TypeScript, or a Python or Go test file. */
const TEST_FILE = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|test_[^/]+\.py|[^/]+_test\.(?:py|go))$/;
/* A word with a wildcard, a variable, a part number or a value of a flag names no one file. */
const NO_ONE_FILE = /[*?[\]{}$=:<>`\\]/;

/* The test files a command names by path, as the commit would have them: a selection inside a file (::test, :line) and the
   folders the path climbs out of left off. */
export function namedTestFiles(command: string): string[] {
  const words = command.split(/[\s;&|()]+/).map(word => word.replace(/^['"]+|['"]+$/g, '').replace(/::.*$|:\d+$/, '').replace(/^(?:\.\.?\/)+/, ''));
  return [...new Set(words.filter(word => word && !word.startsWith('-') && !word.startsWith('/') && !NO_ONE_FILE.test(word) && TEST_FILE.test(word)))];
}

/* A named file is there when a file of the commit is it, or ends in it from the folder a workspace or cd runs in. */
export function missingFrom(paths: readonly string[], named: readonly string[]): string[] {
  return named.filter(name => !paths.some(path => path === name || path.endsWith(`/${name}`)));
}

/* Refuses a manual run that names a test file its pinned commit does not have, before any part goes out: a runner given one
   it cannot find runs the others, or none, and says nothing a run's result would show. Where the repository cannot list the
   commit, the run goes as before and the answer says the names went unchecked. */
export async function checkNamedFiles(ctx: Pick<Ctx, 'readTree'>, found: { repo: RepoAddress } | null, mode: TestRunMode, pin: { branch: string | null; commitSha: string | null }): Promise<string> {
  const named = mode.mode === 'manual' && found && pin.commitSha ? namedTestFiles(mode.command) : [];
  if (!named.length) return '';
  const tree = await ctx.readTree!(found!.repo, pin.commitSha!);
  if (!tree.complete) return ` Hornhoof could not check that commit ${pin.commitSha} has the test files the command names (${tree.reason}).`;
  const missing = missingFrom(tree.paths, named);
  if (missing.length) throw refuse(409, 'task_invalid', `The command names ${missing.join(', ')}, and commit ${pin.commitSha} of ${pin.branch} has no such file. Name the test files that commit has, or push the missing ones and run again. No part went out.`);
  return '';
}
