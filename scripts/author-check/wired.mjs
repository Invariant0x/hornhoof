import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { exitCodeOf, parseCrapEdn } from './judge.mjs';
import { installedFrom, shareModules } from './modules.mjs';
import { buildPlan, cwdOf } from './plan.mjs';
import { fastSuites, selectTests } from './select.mjs';
import { realPorts } from './main.mjs';
import { runStages } from './stages.mjs';
import { tracked } from '../test/tracked-files.mjs';

const MANIFEST = '.hornhoof/test-environment.json';
const COLLECT_MS = 5 * 60 * 1000;
const COLLECT_BYTES = 64 * 1024 * 1024;
const PROBE = "const {probe}=await import('./scripts/test/related-probe.mjs');process.stdout.write(JSON.stringify(await probe({root:process.cwd()},JSON.parse(process.argv[1]))));";

/* Why a tool did not run: its last line of errors, or what kept it from starting. */
const lastWords = ran => ran.error?.message ?? (ran.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 300) ?? '';

/* A commit's files under the paths they have now, read by the same tool from the same folder depth as the run reads them. */
export const complexityAt = (git, tool = 'crapper') => (_cwd, commit, files) => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-author-base-'));
  try {
    for (const { path, from } of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), git(['show', `${commit}:${from}`]));
    }
    const ran = spawnSync(tool, ['--no-coverage', ...files.map(file => file.path)], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(['crapper_unavailable', lastWords(ran)].filter(Boolean).join(': '));
    return parseCrapEdn(readFileSync(join(dir, '.metrics/crap.edn'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

function makePlan({ sha, base }, ports) {
  const suites = fastSuites(JSON.parse(ports.git(['show', `${sha}:${MANIFEST}`])));
  return buildPlan({ sha, base, cwdOf: path => cwdOf(suites, path) }, { git: ports.git, complexity: complexityAt(ports.git) });
}

/* What the selector reads, where each is built, and the files each is built from. The node is built against the protocol. */
const SHARED = ['tsconfig.base.json', 'package-lock.json'];
const BUILDS = [
  { output: 'packages/protocol/dist', workspace: '@hornhoof/protocol', from: ['packages/protocol/src', 'packages/protocol/package.json', 'packages/protocol/tsconfig.json', ...SHARED] },
  { output: 'apps/node/dist', workspace: '@hornhoof/node', from: ['apps/node/src', 'apps/node/package.json', 'apps/node/tsconfig.json', 'packages/protocol/src', ...SHARED] },
];
/* Beside a build: the digest of the files it was built from. */
const BUILT_FROM = '.built-from';

/* The files under these paths of the workspace, by path and content: a build of other files has another digest. */
export function sourceDigest(root, paths) {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) for (const file of filesUnder(root, path)) hash.update(`${file}\0`).update(readFileSync(join(root, file))).update('\0');
  return hash.digest('hex');
}

function filesUnder(root, path) {
  const found = statSync(join(root, path), { throwIfNoEntry: false });
  if (!found?.isDirectory()) return found?.isFile() ? [path] : [];
  const entries = readdirSync(join(root, path), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  return entries.map(entry => relative(root, join(entry.parentPath, entry.name))).sort();
}

const npm = async (ports, args) => (await ports.exec('npm', args, { cwd: '.' })).code === 0;

/* The check runs in a workspace that is used again, so what it imports is built again whenever its files have changed since
   it was built; dependencies are installed only when missing or installed from another lockfile, and a worktree takes those
   its clone installed from the same lockfile. --ignore-scripts keeps the scripts of the dependencies off, and the
   repository's own prepare with them: a package needs what that links. */
export async function prepare(ports) {
  const install = ports.installed() ? [] : ports.shareModules?.() ? [['run', '-s', 'prepare']] : [['ci', '--ignore-scripts'], ['run', '-s', 'prepare']];
  for (const args of install) if (!(await npm(ports, args))) return 'prepare_failed';
  for (const build of BUILDS) {
    const digest = ports.digest(build.from);
    const stamp = `${build.output}/${BUILT_FROM}`;
    if (ports.read(stamp) === digest) continue;
    if (!(await npm(ports, ['run', '-s', 'build', '-w', build.workspace]))) return 'prepare_failed';
    ports.write(stamp, digest);
  }
  return null;
}

export async function selectionPorts(root) {
  const { namedAfter, selectAffectedTests } = await import('../../apps/node/dist/test-impact.js');
  const { collectVitestImpact } = await import('../../apps/node/dist/test-impact-adapters.js');
  const { listTestUnits } = await import('../../apps/node/dist/test-environment.js');
  const collect = async changed => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, JSON.stringify(changed)], { cwd: root, encoding: 'utf8', timeout: COLLECT_MS, maxBuffer: COLLECT_BYTES, stdio: ['ignore', 'pipe', 'inherit'] }));
  const read = path => { try { return readFileSync(join(root, path), 'utf8'); } catch { return null; } };
  return { namedAfter, selectAffectedTests, collectVitestImpact, listTestUnits, collect, read, readers: input => documentReaders(input, read) };
}

/* The tests that read a document, by the graph a fingerprint follows. A document gone from the commit is still named where it was. */
async function documentReaders({ manifest, tracked: entries, paths, tests }, read) {
  const { codeFilesOf, readersOf } = await import('../../apps/node/dist/test-fingerprint.js');
  const known = new Set(entries.map(entry => entry.path));
  const all = [...entries, ...paths.filter(path => !known.has(path)).map(path => ({ path, mode: '100644', oid: '0'.repeat(40) }))];
  const texts = new Map(codeFilesOf(all).flatMap(path => { const text = read(path); return text === null ? [] : [[path, text]]; }));
  return readersOf({ description: { manifest, inventory: [], inputDigests: [], runtimeCapabilities: [] }, tracked: all, texts }, paths, tests);
}

async function selection(args, plan, manifest, ports, root) {
  return selectTests({ changes: plan.changes, manifest, tracked: tracked(ports.git), allowWhole: args.allowWhole }, await selectionPorts(root));
}

async function check(args, plan, ports, root) {
  const { parseTestEnvironment } = await import('@hornhoof/protocol');
  const manifest = parseTestEnvironment(ports.read(MANIFEST));
  const chosen = await selection(args, plan, manifest, ports, root).catch(error => { ports.log(`NOTE ${error.message}`); return { unavailable: 'selection_failed', notes: [] }; });
  const tmp = mkdtempSync(join(tmpdir(), 'hh-author-'));
  const result = await runStages({ sha: args.sha, tmp, scripts: JSON.parse(ports.read('package.json')).scripts, suites: fastSuites(manifest), plan, selection: chosen }, ports);
  ports.log(`AUTHOR_CHECK ${JSON.stringify(result.record)}`);
  return { code: exitCodeOf(result.stages) };
}

export function wiredPorts(root) {
  const ports = realPorts(root);
  const built = { ...ports, digest: paths => sourceDigest(root, paths), installed: () => installedFrom(root), shareModules: () => shareModules(root, ports.git) };
  return { ...ports, prepare: () => prepare(built), makePlan: args => makePlan(args, ports), check: (args, plan) => check(args, plan, ports, root) };
}
