#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { trackedIn } from '../test/tracked-files.mjs';
import { parseHunks, parseNameStatus } from '../author-check/plan.mjs';
import { parseVitestJson } from '../author-check/judge.mjs';

/* The mutation suite of a test run: mutator on each selected risky source file, against the fast tests that reach it. Its own
   snapshot, which the suite keeps between runs, leaves it only survivors and rewritten functions. From that snapshot the tool skips
   its baseline and keeps what it once killed, so the tests must pass first, and a source whose tests changed is judged whole again.
   A survivor is a finding, not a failure: the note keeps it with the result, so that a file that did not change need not run again
   and still says so. What cannot judge a file fails it: no fast test, tests that fail unmutated, nothing to mutate. */

const MANIFEST = '.hornhoof/test-environment.json';
const JUDGES = '.metrics/mutate/judges';
const WORKERS = '4';
const TOTAL = /^Total\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+)\s+(\d+))?\s+\S+\s*$/m;
const SHA = /^[a-f0-9]{40}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const word = text => (/^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

export function selectedSources(listed, mutation) {
  return listed ? JSON.parse(listed).map(path => normalize(path)) : mutation.sourcePaths;
}

/* The bare configuration leaves out what prepares a database or a report, which a pure test does not need. Without reports
   it prints only the counts the tool judges a mutant by; a baseline given reports prints Vitest's full report too. */
export function testCommand(tests, reports) {
  const packages = Map.groupBy(tests, test => test.split('/').slice(0, 2).join('/'));
  return [...packages].map(([root, files]) => {
    const report = reports?.get(root), flags = reports ? ` --reporter=default${report ? ` --reporter=json --outputFile.json=${word(report)}` : ''}` : '';
    return `npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root ${word(root)}${flags} ${files.map(file => word(file.slice(root.length + 1))).join(' ')}`;
  }).join(' && ');
}

export function outcomeOf(code, output) {
  const total = TOTAL.exec(output);
  if ((code !== 0 && code !== 3) || !total) return { status: 'failed' };
  if (total[6] !== undefined) return extendedOutcome(total);
  if (total[4] === '0') return { status: 'failed' };
  return { status: 'passed', note: `${total[1]} killed, ${total[2]} survived, ${total[3]} uncovered of ${total[4]} sites` };
}

function extendedOutcome(total) {
  const note = `${total[1]} killed, ${total[2]} survived, ${total[3]} uncovered, ${total[4]} compile_error, ${total[5]} timeout of ${total[6]} sites`;
  return { status: total[6] === '0' || Number(total[4]) > 0 || Number(total[5]) > 0 ? 'failed' : 'passed', note };
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
  for (const file of new Set(sources)) {
    const started = Date.now(), outcome = await judge(file, fastTests.get(file) ?? [], tool);
    files.push({ file, ...outcome, ms: Date.now() - started });
  }
  return files;
}

export function mutatorArgs(source, tests, whole, lines) {
  return ['--root', '.', '--source-root', source, '--no-coverage', '--max-workers', WORKERS, ...lineArgs(lines), ...(whole ? ['--mutate-all'] : []), '--test-command', testCommand(tests)];
}
function lineArgs(lines) {
  if (lines === undefined) return [];
  if (!lines.length || lines.some(line => !Number.isSafeInteger(line) || line <= 0)) throw new Error('Mutation lines must be nonempty positive integers.');
  return ['--lines', [...new Set(lines)].sort((a, b) => a - b).join(',')];
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
function baselinePasses(command) {
  return new Promise(done => {
    const child = spawn('sh', ['-c', command], { env: toolEnv(), stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}
function reportPassed(path) {
  const counts = parseVitestJson(kept(path));
  return counts !== null && counts.passed > 0 && counts.failed === 0;
}
async function testsPass(tests, counted) {
  if (!counted) return baselinePasses(testCommand(tests, new Map()));
  const folder = mkdtempSync(join(tmpdir(), 'hh-mutation-baseline-'));
  try {
    const roots = [...new Set(tests.map(test => test.split('/').slice(0, 2).join('/')))];
    const reports = new Map(roots.map((root, index) => [root, join(folder, `${index}.json`)]));
    return await baselinePasses(testCommand(tests, reports)) && [...reports.values()].every(reportPassed);
  } finally { rmSync(folder, { recursive: true, force: true }); }
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
  const { tsImport } = await import('tsx/esm/api');
  const fingerprint = await tsImport('../../apps/node/src/test-fingerprint.ts', import.meta.url);
  const texts = new Map(fingerprint.codeFilesOf(tracked).map(path => [path, readFileSync(path, 'utf8')]));
  const input = { description: { manifest, inventory: [], inputDigests: [], runtimeCapabilities: [] }, tracked, texts };
  const suite = manifest.suites.find(suite => suite.id === 'mutation');
  if (!suite) throw new Error('The mutation suite is missing.');
  const conditions = [process.platform, process.arch, process.versions, process.report.getReport().header.glibcVersionRuntime ?? null];
  const prints = new Map([...fingerprint.mutationJudgesOf(input, manifest.mutation, suite, sources)].map(([file, print]) => [file, digest([print, conditions])]));
  return { tests: fingerprint.fastTestsOf(input, manifest.mutation, sources), prints,
    select: delta => fingerprint.selectPureMutations(input, { ...manifest.mutation, sourcePaths: manifest.mutation.sourcePaths.filter(source => sources.includes(source)) }, delta) };
}

function requestOf(args) {
  if (!args.length) return null;
  const request = {};
  while (args.length) takeOption(args, request);
  requireRequestCommits(request);
  readRequestPlan(request);
  return request;
}
function requireRequestCommits(request) {
  if (!SHA.test(request.base ?? '') || !SHA.test(request.head ?? '')) throw new Error('Mutation base and head require full commit SHAs.');
}
function readRequestPlan(request) {
  if (Object.hasOwn(request, 'plan') && Object.hasOwn(request, 'plan-file')) throw new Error('Choose one mutation delta plan.');
  if (Object.hasOwn(request, 'plan-file')) request.plan = readPlanFile(request['plan-file']);
}
function takeOption(args, request) {
  const flag = args.shift();
  if (!['--base', '--head', '--plan', '--plan-file'].includes(flag) || !args.length || Object.hasOwn(request, flag.slice(2))) throw new Error('Use --base <SHA> --head <SHA> [--plan <text> | --plan-file <path>].');
  request[flag.slice(2)] = args.shift();
}
function readPlanFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('The mutation delta must be a bounded regular file.');
    const bytes = readFileSync(fd);
    if (bytes.length > 512 * 1024) throw new Error('The mutation delta exceeds its limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
function hasCommit(sha) {
  try { git(['cat-file', '-e', `${sha}^{commit}`]); return true; }
  catch { return false; }
}
function deltaFromPlan(request) {
  if (!request.plan) throw new Error('The mutation base is unavailable; provide its bound --plan.');
  const plan = JSON.parse(request.plan);
  if (!matchesPlanRequest(plan, request) || !hasPlanHunks(plan)) throw new Error('The mutation plan must name this base and head and include its lines.');
  return { changes: plan.changes, hunks: plan.hunks, deltaSource: 'plan' };
}
function matchesPlanRequest(plan, request) {
  return plan?.sha === request.head && plan?.base === request.base && Array.isArray(plan.changes);
}
function hasPlanHunks(plan) {
  return plan.hunks && typeof plan.hunks === 'object' && !Array.isArray(plan.hunks);
}
function deltaFromGit(request) {
  git(['merge-base', '--is-ancestor', request.base, request.head]);
  return { changes: parseNameStatus(git(['diff', '--name-status', '-z', '--find-renames', request.base, request.head])),
    hunks: parseHunks(git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--find-renames', request.base, request.head])), deltaSource: 'git' };
}
function readDelta(request) {
  if (git(['rev-parse', 'HEAD']) !== request.head) throw new Error('The mutation candidate differs from HEAD.');
  git(['diff', '--quiet', request.head, '--']);
  const plan = request.plan === undefined ? null : deltaFromPlan(request);
  const result = hasCommit(request.base) ? deltaFromGit(request) : plan ?? deltaFromPlan(request);
  return { delta: { baseCommit: request.base, commit: request.head, changes: result.changes.map(change => ({ path: change.path, ranges: result.hunks[change.path] ?? [] })) }, deltaSource: result.deltaSource };
}
function scopeFiles(selected, prints) {
  const groups = Map.groupBy(selected, item => item.file), tests = new Map(), lines = new Map(), scopedPrints = new Map();
  for (const [file, functions] of groups) {
    const selectedLines = [...new Set(functions.flatMap(item => item.lines))].sort((a, b) => a - b);
    const selectedTests = [...new Set(functions.flatMap(item => item.tests))].sort();
    lines.set(file, selectedLines); tests.set(file, selectedTests);
    scopedPrints.set(file, digest([prints.get(file), selectedLines, selectedTests]));
  }
  return { tests, lines, prints: scopedPrints };
}
async function scopeOf(judges, delta) {
  if (!delta) return { ...judges, folder: JUDGES, lines: new Map(), selection: null };
  const selected = await judges.select(delta.delta), scoped = scopeFiles(selected.selected, judges.prints);
  const selection = { ...selected, deltaSource: delta.deltaSource, fullSuiteComparator: 'unavailable', fingerprints: [...scoped.prints].map(([file, fingerprint]) => ({ file, fingerprint })) };
  process.stdout.write(`MUTATION_SELECTION ${JSON.stringify(selection)}\n`);
  return { ...scoped, folder: join(JUDGES, 'narrow'), selection };
}
async function runRequested() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')), { mutation } = manifest;
  const request = requestOf(process.argv.slice(2)), delta = request ? readDelta(request) : null;
  const sources = selectedSources(process.env.HH_TEST_FILES && readFileSync(process.env.HH_TEST_FILES, 'utf8'), mutation);
  const scope = await scopeOf(await judgesFor(manifest, trackedIn('.'), sources), delta);
  const chosen = request ? [...scope.tests.keys()] : sources;
  if (scope.selection?.status === 'blocked' || (request && !chosen.length)) return { files: sources.map(file => ({ file, status: 'failed' })), selection: scope.selection, failed: true };
  const files = await mutateSources(chosen, scope.tests, {
    testsPass: tests => testsPass(tests, Boolean(request)),
    mutate: async (source, tests) => {
      const ended = await mutate(mutation.tool, mutatorArgs(source, tests, judgedAgain(scope.folder, source, scope.prints.get(source)), scope.lines.get(source)));
      if (outcomeOf(ended.code, ended.output).status === 'passed') keepJudges(scope.folder, source, scope.prints.get(source));
      return ended;
    },
  });
  return { files, selection: scope.selection, failed: files.some(file => file.status === 'failed') };
}
async function main() {
  let result;
  try { result = await runRequested(); }
  catch (error) { process.stderr.write(`Mutation selection failed: ${error.message}\n`); result = { files: [], selection: null, failed: true }; }
  const report = { files: result.files, ...(result.selection ? { selection: result.selection } : {}) };
  if (process.env.HH_TEST_REPORT) writeFileSync(process.env.HH_TEST_REPORT, JSON.stringify(report));
  process.exitCode = result.failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
