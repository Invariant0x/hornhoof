import { type Config } from '../../config.js';
import { type Db } from '../../db/client.js';
import { githubReaders } from '../testruns/compare.js';
import { GitHubLimits } from '../testruns/github-limit.js';
import { readBranches, readTags } from '../testruns/refs.js';
import { BATCH, BUDGET, restoreCommand, type Entry } from './prune-run.js';
import { pruneOne, repositoriesOf, type Pruning, type Reader } from './prune-job.js';
import { pushRefs } from './ref-push.js';

/* The command that prunes the branches of a company's repositories by hand, once or again (#1964): the dry run is what it does
   unless it is told to apply. Its lines are tab-separated, to keep as a file: repository, branch, head, what, kind, why. */

export const PRUNE_USAGE = 'Usage: node apps/server/dist/cli.js branch-prune [--apply] [--limit N] [--budget N] [--company ID] [--repo TEXT] [--all-branches]';

export type PruneReaders = Pick<Reader, 'readBranches' | 'readTags' | 'readMerged' | 'pushRefs' | 'log'>;
type Deps = { db: Db; config: Config; print: (line: string) => void; prune?: PruneReaders };

type Options = { apply: boolean; allBranches: boolean; limit: number; budget: number; company?: string; repo?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const whole = (text: string | undefined, least: number): number | null => (text !== undefined && /^\d{1,9}$/.test(text) && Number(text) >= least ? Number(text) : null);

const VALUED = new Set(['--limit', '--budget', '--company', '--repo']);

/* Sets what a flag with a value names, or says it could not: no value, or one that is none. */
function take(options: Options, flag: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (flag === '--company') return UUID.test(value) && Boolean((options.company = value));
  if (flag === '--repo') return value !== '' && Boolean((options.repo = value));
  const count = whole(value, flag === '--limit' ? 1 : 0);
  if (count === null) return false;
  options[flag === '--limit' ? 'limit' : 'budget'] = count;
  return true;
}

/* The options as given, or none where one is unknown, lacks its value or has a value that is none. */
export function optionsOf(args: readonly string[]): Options | null {
  const options: Options = { apply: false, allBranches: false, limit: BATCH, budget: BUDGET };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--apply') options.apply = true;
    else if (arg === '--all-branches') options.allBranches = true;
    else if (!VALUED.has(arg) || !take(options, arg, args[++i])) return null;
  }
  return options;
}

const line = (...cells: string[]): string => cells.join('\t');

/* The real readers: the repository's own git protocol, and GitHub's REST under the same request limit as the server's. */
function realReaders(): PruneReaders {
  const limits = new GitHubLimits(() => Date.now(), limit => console.error(`GitHub REST request limit exhausted: ${JSON.stringify(limit)}`));
  const log = { info: () => undefined, warn: (...what: unknown[]) => console.error(JSON.stringify(what)), error: (...what: unknown[]) => console.error(JSON.stringify(what)) };
  return { readBranches, readTags, readMerged: githubReaders(limits).readMerged, pushRefs, log: log as unknown as PruneReaders['log'] };
}

const counted = (counts: Pruning['counts']): string => Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => `${kind} ${n}`).join(', ');

function stopOf({ stopped }: Pruning['result']): string | null {
  if (!stopped) return null;
  if (stopped.why === 'batch') return 'more to do: run it again';
  if (stopped.why === 'budget') return 'more to do: the budget of requests was spent, run it again';
  if (stopped.why === 'limit') return `more to do: GitHub's request limit is used up${stopped.resetAt ? `, it ends at ${stopped.resetAt}` : ''}, run it again after`;
  return `left as it is: ${stopped.problem}`;
}

const done = (entries: readonly Entry[], what: Entry['done']): number => entries.filter(entry => entry.done === what).length;

/* What one repository's run says: the changes (or every branch), then the totals. */
function report(pruning: Pruning, options: Options, print: (line: string) => void): void {
  const { repository, result, counts } = pruning;
  const url = repository.url;
  if (result.stopped?.why === 'unreadable') return print(`# ${url}: ${stopOf(result)}`);
  const doing = options.apply ? result.entries : result.verdicts.filter(v => v.action !== 'keep').map(v => ({ ...v, done: v.action === 'archive' ? 'archived' : 'deleted' }) as Entry);
  for (const v of options.allBranches ? result.verdicts.filter(v => v.action === 'keep') : []) print(line(url, v.branch, v.head, v.action, v.category, v.reason));
  for (const entry of doing) print(line(url, entry.branch, entry.head, options.apply ? entry.done : entry.action, entry.category, entry.done === 'refused' ? `refused: ${entry.problem ?? ''}` : entry.reason));
  const [deleted, archived] = [done(doing, 'deleted'), done(doing, 'archived')];
  print(`# ${url}: ${result.branches} branches, by kind: ${counted(counts)}`);
  if (options.apply) {
    const refused = done(doing, 'refused');
    print(`# ${url}: applied: ${deleted} deleted, ${archived} archived, ${refused} refused; branches before ${result.branches}, after ${result.branches - deleted - archived}`);
    for (const entry of doing.filter(e => e.done === 'archived')) print(`# restore ${entry.branch}: ${restoreCommand(entry.branch)}`);
  } else print(`# ${url}: ${result.branches} branches, dry run: ${deleted} to delete, ${archived} to archive`);
  const more = stopOf(result);
  if (more) print(`# ${url}: ${more}`);
}

/* The command: a run over each repository that fits, and the exit code 0 when every one was read. */
export async function branchPrune(args: readonly string[], { db, config, print, prune = realReaders() }: Deps): Promise<number> {
  const options = optionsOf(args);
  if (!options) {
    print(PRUNE_USAGE);
    return 1;
  }
  const ctx: Reader = { db, config, ...prune };
  const text = options.repo?.toLowerCase();
  const repositories = (await repositoriesOf(ctx, options.company)).filter(r => !text || r.url.toLowerCase().includes(text));
  if (!repositories.length) {
    print('# no repository matches');
    return 1;
  }
  let code = 0;
  for (const repository of repositories) {
    const pruning = await pruneOne(ctx, repository, { apply: options.apply, limit: options.limit, budget: options.budget });
    report(pruning, options, print);
    if (pruning.result.stopped?.why === 'unreadable') code = 1;
  }
  return code;
}
