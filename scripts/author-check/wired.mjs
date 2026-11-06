import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exitCodeOf, parseCrapEdn } from './judge.mjs';
import { buildPlan, cwdOf } from './plan.mjs';
import { fastSuites, selectTests } from './select.mjs';
import { realPorts } from './main.mjs';
import { runStages } from './stages.mjs';

const MANIFEST = '.hornhoof/test-environment.json';
const COLLECT_MS = 5 * 60 * 1000;
const COLLECT_BYTES = 64 * 1024 * 1024;
const PROBE = "const {probe}=await import('./scripts/test/related-probe.mjs');process.stdout.write(JSON.stringify(await probe({root:process.cwd()},JSON.parse(process.argv[1]))));";

/* A commit's files under the paths they have now, read by the same tool from the same folder depth as the run reads them. */
export const complexityAt = (git, tool = 'crapper') => (_cwd, commit, files) => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-author-base-'));
  try {
    for (const { path, from } of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), git(['show', `${commit}:${from}`]));
    }
    if (spawnSync(tool, ['--no-coverage', ...files.map(file => file.path)], { cwd: dir, stdio: 'ignore' }).status !== 0) throw new Error('crapper_unavailable');
    return parseCrapEdn(readFileSync(join(dir, '.metrics/crap.edn'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

function makePlan({ sha, base }, ports) {
  const suites = fastSuites(JSON.parse(ports.git(['show', `${sha}:${MANIFEST}`])));
  return buildPlan({ sha, base, cwdOf: path => cwdOf(suites, path) }, { git: ports.git, complexity: complexityAt(ports.git) });
}

export async function prepare(ports) {
  const steps = [...(ports.exists('node_modules') ? [] : [['ci', '--ignore-scripts']]), ['run', '-s', 'build', '-w', '@hornhoof/protocol'], ['run', '-s', 'build', '-w', '@hornhoof/node']];
  for (const args of steps) if ((await ports.exec('npm', args, { cwd: '.' })).code !== 0) return 'prepare_failed';
  return null;
}

export function tracked(git) {
  return git(['ls-files', '-s', '-z']).split('\0').filter(Boolean).map(line => {
    const [info, path] = line.split('\t'), [mode, oid] = info.split(' ');
    return { path, mode, oid };
  });
}

export async function selectionPorts(root) {
  const { selectAffectedTests } = await import('../../apps/node/dist/test-impact.js');
  const { collectVitestImpact } = await import('../../apps/node/dist/test-impact-adapters.js');
  const { listTestUnits } = await import('../../apps/node/dist/test-environment.js');
  const collect = async changed => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, JSON.stringify(changed)], { cwd: root, encoding: 'utf8', timeout: COLLECT_MS, maxBuffer: COLLECT_BYTES, stdio: ['ignore', 'pipe', 'inherit'] }));
  return { selectAffectedTests, collectVitestImpact, listTestUnits, collect };
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
  return { ...ports, prepare: () => prepare(ports), makePlan: args => makePlan(args, ports), check: (args, plan) => check(args, plan, ports, root) };
}
