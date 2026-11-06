import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImpactChange, ImpactEnvironment, ImpactGraph, ImpactPackage } from './test-impact.js';
import type { FullComparator, ImpactReplay } from './test-impact-replay.js';
import { parseImpactDiff, replayImpactChanges } from './test-impact-replay.js';
import { collectVitestImpact, mapPytestImpact, type ImpactCollection, type PytestImpactResult } from './test-impact-adapters.js';

export interface ImpactReplayRequest { environment: ImpactEnvironment; projectSuites: Record<string, string[]>; comparator?: FullComparator }
const git = (root: string, args: string[]): Buffer => execFileSync('git', args, { cwd: root, timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const decode = (value: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(value);
const unavailablePython = (): ImpactGraph => ({ adapter: 'pytest', status: 'unavailable', units: [] });
function changedIn(pkg: ImpactPackage, changes: ImpactChange[]): string[] {
  const prefix = pkg.root === '.' ? '' : pkg.root + '/';
  return changes.map(change => change.path).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
}
function pythonGraph(root: string, pkg: ImpactPackage, request: ImpactReplayRequest, changes: ImpactChange[]): ImpactGraph {
  try {
    const folder = resolve(root, pkg.root);
    if (relative(root, folder).startsWith('..') || realpathSync(folder) !== folder || pkg.suiteIds.length !== 1) return unavailablePython();
    const prefix = pkg.root === '.' ? '' : pkg.root + '/';
    const files = decode(git(root, ['ls-files', '-z', '--', pkg.root])).split('\0').filter(file => file.endsWith('.py')).map(file => file.slice(prefix.length));
    const tests = request.environment.inventory.filter(unit => pkg.suiteIds.includes(unit.suiteId)).map(unit => unit.file.slice(prefix.length));
    const helper = fileURLToPath(new URL('../../../scripts/test/impact-python/pytest_impact.py', import.meta.url));
    const output = execFileSync('python3', [helper], { cwd: root, input: JSON.stringify({ root: folder, files, tests, changed: changedIn(pkg, changes) }), encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    return mapPytestImpact(JSON.parse(output) as PytestImpactResult, request.environment.inventory, pkg.suiteIds[0]!, pkg.root);
  } catch { return unavailablePython(); }
}
function vitestCollection(root: string, changed: string): ImpactCollection {
  const code = "const {probe}=await import('./scripts/test/related-probe.mjs');process.stdout.write(JSON.stringify(await probe({root:process.cwd()},process.argv[1])));";
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, changed], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })) as ImpactCollection;
}
async function graphs(root: string, request: ImpactReplayRequest, changes: ImpactChange[]): Promise<ImpactGraph[]> {
  const result: ImpactGraph[] = [];
  const typescript = changes.map(change => change.path).filter(path => /\.[cm]?[jt]sx?$/.test(path));
  const requiredSuiteIds = request.environment.packages.filter(pkg => ['typescript', 'javascript'].includes(pkg.language ?? request.environment.impact.adapter)).flatMap(pkg => pkg.suiteIds);
  if (typescript.length) result.push(await collectVitestImpact({ inventory: request.environment.inventory, projectSuites: request.projectSuites, changed: typescript, requiredSuiteIds }, async path => vitestCollection(root, path)));
  const python = request.environment.packages.filter(pkg => pkg.language === 'python' && changedIn(pkg, changes).length > 0);
  if (python.length) {
    const parts = python.map(pkg => pythonGraph(root, pkg, request, changes));
    result.push(parts.every(part => part.status === 'ready') ? { adapter: 'pytest', status: 'ready', units: parts.flatMap(part => part.units) } : unavailablePython());
  }
  return result;
}

/* Only read-only Git/collection commands. Comparator receipts are supplied by the caller. */
export async function runImpactReplay(root: string, request: ImpactReplayRequest): Promise<ImpactReplay> {
  const candidate = decode(git(root, ['rev-parse', 'HEAD'])).trim();
  const history = decode(git(root, ['log', '--first-parent', '--format=%H %P', '-n', '10', 'refs/remotes/origin/main'])).trim().split('\n');
  const commits = history.map(line => {
    const [commit, parent] = line.split(' ');
    if (!commit || !parent || !/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(parent)) throw new Error('impact_history_invalid');
    return { commit, parent, changes: parseImpactDiff(git(root, ['diff', '--name-status', '-z', '--find-renames', parent, commit])) };
  });
  return replayImpactChanges({ candidate, commits, environment: request.environment, comparator: request.comparator, collect: changes => graphs(root, request, changes) });
}
export const replayExitCode = (report: ImpactReplay): number => report.status === 'blocked' ? 3 : report.status === 'observed-misses' ? 2 : 0;
