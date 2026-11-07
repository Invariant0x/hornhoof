#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedIn } from '../test/tracked-files.mjs';

/* The mutation suite of a test run: mutator on each selected risky source file, against the fast tests that reach it. Its own
   snapshot, which the suite keeps between runs, leaves it only survivors and rewritten functions. From that snapshot the tool skips
   its baseline and keeps what it once killed, so the tests must pass first, and a source whose tests changed is judged whole again.
   A survivor is a finding, not a failure: the note keeps it with the result, so that a file that did not change need not run again
   and still says so. What cannot judge a file fails it: no fast test, tests that fail unmutated, nothing to mutate. */

const MANIFEST = '.hornhoof/test-environment.json';
const JUDGES = '.metrics/mutate/judges';
const WORKERS = '4';
const TOTAL = /^Total\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s*$/m;

const word = text => (/^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

export function selectedSources(listed, mutation) {
  return listed ? JSON.parse(listed).map(path => normalize(path)) : mutation.sourcePaths;
}

/* The bare configuration leaves out what prepares a database or a report, which a pure test does not need. */
export function testCommand(tests) {
  const packages = Map.groupBy(tests, test => test.split('/').slice(0, 2).join('/'));
  return [...packages].map(([root, files]) => `npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root ${word(root)} ${files.map(file => word(file.slice(root.length + 1))).join(' ')}`).join(' && ');
}

export function outcomeOf(code, output) {
  const total = TOTAL.exec(output);
  if ((code !== 0 && code !== 3) || !total || total[4] === '0') return { status: 'failed' };
  return { status: 'passed', note: `${total[1]} killed, ${total[2]} survived, ${total[3]} uncovered of ${total[4]} sites` };
}

function cannotJudge(file, why) {
  process.stdout.write(`${file}: ${why}, so mutation cannot judge it.\n`);
  return { status: 'failed' };
}

async function judge(file, tests, { testsPass, mutate }) {
  if (!tests.length) return cannotJudge(file, 'no fast test reaches it');
  if (!await testsPass(tests)) return cannotJudge(file, 'its fast tests fail unmutated');
  const { code, output } = await mutate(file, tests);
  return outcomeOf(code, output);
}

export async function mutateSources(sources, fastTests, tool) {
  const files = [];
  for (const file of sources) {
    const started = Date.now(), outcome = await judge(file, fastTests.get(file) ?? [], tool);
    files.push({ file, ...outcome, ms: Date.now() - started });
  }
  return files;
}

export function mutatorArgs(source, tests, whole) {
  return ['--root', '.', '--source-root', source, '--no-coverage', '--max-workers', WORKERS, ...(whole ? ['--mutate-all'] : []), '--test-command', testCommand(tests)];
}

/* What judged a source last time, kept beside the tool's snapshot. Parts of a run merge by file, so each source has its own. */
const judgesFile = (folder, source) => join(folder, source.replaceAll('/', '__'));
function kept(file) {
  try { return readFileSync(file, 'utf8'); }
  catch { return null; }
}
export function judgedAgain(folder, source, fingerprint) {
  return !fingerprint || kept(judgesFile(folder, source)) !== fingerprint;
}
export function keepJudges(folder, source, fingerprint) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(judgesFile(folder, source), fingerprint);
}

const toolEnv = () => ({ ...process.env, HH_TEST_FILES: '', HH_TEST_REPORT: '' });
function testsPass(tests) {
  return new Promise(done => {
    const child = spawn('sh', ['-c', testCommand(tests)], { env: toolEnv(), stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}

function mutate(tool, args) {
  return new Promise(done => {
    const child = spawn(tool, args, { env: toolEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.on('error', error => { process.stdout.write(`${tool} could not start: ${error.message}\n`); done({ code: null, output }); });
    child.on('close', code => done({ code, output }));
  });
}

/* The same fast tests a source's fingerprint reads: what they reach decides both. */
async function judgesFor(manifest, tracked, sources) {
  const fingerprint = await import('../../apps/node/dist/test-fingerprint.js');
  const texts = new Map(fingerprint.codeFilesOf(tracked).map(path => [path, readFileSync(path, 'utf8')]));
  const input = { description: { manifest, inventory: [], inputDigests: [], runtimeCapabilities: [] }, tracked, texts };
  const suite = manifest.suites.find(suite => suite.id === 'mutation');
  if (!suite) throw new Error('The mutation suite is missing.');
  return { tests: fingerprint.fastTestsOf(input, manifest.mutation, sources), prints: fingerprint.mutationJudgesOf(input, manifest.mutation, suite, sources) };
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')), { mutation } = manifest;
  const sources = selectedSources(process.env.HH_TEST_FILES && readFileSync(process.env.HH_TEST_FILES, 'utf8'), mutation);
  const { tests: fastTests, prints } = await judgesFor(manifest, trackedIn('.'), sources);
  const files = await mutateSources(sources, fastTests, {
    testsPass,
    mutate: async (source, tests) => {
      const ended = await mutate(mutation.tool, mutatorArgs(source, tests, judgedAgain(JUDGES, source, prints.get(source))));
      if (outcomeOf(ended.code, ended.output).status === 'passed') keepJudges(JUDGES, source, prints.get(source));
      return ended;
    },
  });
  if (process.env.HH_TEST_REPORT) writeFileSync(process.env.HH_TEST_REPORT, JSON.stringify({ files }));
  process.exitCode = files.some(file => file.status === 'failed') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
