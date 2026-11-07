import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, URL } from 'node:url';
import { parseTestEnvironment } from '@hornhoof/protocol';
import { buildTestInvocation, listTestUnits } from '../../apps/node/src/test-environment.ts';
import { codeFilesOf, fingerprintUnits } from '../../apps/node/src/test-fingerprint.ts';
import { parseFileReport } from '../../apps/node/src/test-report.ts';
import { unitKey } from '../../apps/server/src/modules/testruns/plan-environment.ts';
import { decideReuse, partFileResults, printKey } from '../../apps/server/src/modules/testruns/reuse.ts';
import { trackedIn } from './tracked-files.mjs';

/* Measures runs in a row on this one machine, in a clone it may change: the real fingerprints, the real suite commands, the real
   reports and the server's own decision, with the green results kept here instead of in a database. The first run takes it all,
   the second the same commit, the third an edit of the path given. Run from the repository root after preparing, as a part does:
   node --import tsx scripts/test/measure-reuse.mjs <path to edit> [profile] */
const root = fileURLToPath(new URL('../../', import.meta.url));
const [edited, profile] = process.argv.slice(2);
if (!edited) throw new Error('Name the path to edit between the second and the third run.');
const manifest = parseTestEnvironment(readFileSync(join(root, '.hornhoof/test-environment.json'), 'utf8'));
const wanted = manifest.profiles.find(item => item.id === (profile ?? manifest.defaultProfile)).requiredSuiteIds;
const folder = join(root, '.metrics/measure-reuse');
rmSync(folder, { recursive: true, force: true }); mkdirSync(folder, { recursive: true });
const green = new Set();

async function fingerprints() {
  const tracked = trackedIn(root), units = listTestUnits(manifest, tracked).filter(unit => wanted.includes(unit.suiteId));
  const texts = new Map(codeFilesOf(tracked).map(path => [path, readFileSync(join(root, path), 'utf8')]));
  const runtimeCapabilities = [{ id: 'node', version: process.versions.node, fingerprint: 'a'.repeat(64) }];
  return { units, prints: await fingerprintUnits({ description: { manifest, inventory: units, inputDigests: [], runtimeCapabilities }, tracked, texts }) };
}
function runCommand(command, env, log) {
  const output = openSync(log, 'a');
  return new Promise(done => {
    const child = spawn(command.program, command.args, { cwd: join(root, command.cwd), env: { ...process.env, ...env, CI: 'true', NO_COLOR: '1' }, stdio: ['ignore', output, output] });
    child.on('close', code => { closeSync(output); done(code); });
  });
}
/* One suite of a run: the files it was given, what its runner says of them, and what stays green. */
async function runSuite(name, suiteId, files, printOf) {
  const suite = manifest.suites.find(item => item.id === suiteId), base = join(folder, `${name}-${suiteId}`);
  const invocation = await buildTestInvocation(suite, files, { checkout: root, filesPath: `${base}.files.json`, shard: { index: 1, count: 1 } });
  const report = `${base}.report.json`, code = await runCommand(invocation.command, { ...invocation.env, HH_TEST_REPORT: report }, `${base}.log`);
  let text = null;
  try { text = readFileSync(report, 'utf8'); } catch { /* A runner that writes none is judged by its exit. */ }
  const said = parseFileReport(text, { checkout: root.replace(/\/$/, ''), suiteId, selected: files, suiteFailed: code !== 0 });
  const { green: passed, failed } = partFileResults({}, { kind: 'suite', suiteId, files }, code === 0, said);
  for (const file of passed) green.add(printKey(file, printOf(file.file)));
  return code === 0 ? failed.map(file => file.file) : [...failed.map(file => file.file), `${suiteId} exit ${code}`];
}
async function measure(name) {
  const started = performance.now(), { units, prints } = await fingerprints(), printing = performance.now() - started;
  const printOf = suiteId => file => prints.find(print => print.suiteId === suiteId && print.file === file).fingerprint;
  const decision = decideReuse({ units, prints, green, once: [] }), toRun = units.filter(unit => !decision.reused.has(unitKey(unit)));
  const failed = [], bySuite = {};
  for (const suiteId of wanted) {
    const files = toRun.filter(unit => unit.suiteId === suiteId).map(unit => unit.file);
    bySuite[suiteId] = files.length;
    if (files.length) failed.push(...await runSuite(name, suiteId, files, printOf(suiteId)));
  }
  const line = { run: name, files: units.length, reused: decision.reused.size, ran: toRun.length, bySuite, failed, fingerprintSeconds: Math.round(printing / 100) / 10, totalSeconds: Math.round((performance.now() - started) / 100) / 10 };
  process.stdout.write(`HH_REUSE_MEASURE ${JSON.stringify(line)}\n`);
}

await measure('first');
await measure('second');
appendFileSync(join(root, edited), edited.endsWith('.md') ? '\nOne more line.\n' : '\n// An edit for this measurement.\n');
execFileSync('git', ['add', '--', edited], { cwd: root });
await measure('after-edit');
