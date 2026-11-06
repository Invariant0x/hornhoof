import { join, posix } from 'node:path';
import { changedLines, countDuplicates, judgeFunctions, parseCrapEdn, parseLcov, parseTap, parseVitestJson, worstCrap } from './judge.mjs';
import { cwdOf, isCode, isLintable, isSource, ownerOf } from './plan.mjs';
import { adapterOf } from './select.mjs';

const NAMES = ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'];
const TYPED = /\.(?:ts|tsx|mts|cts)$/;
const TEST_TYPES = { program: 'npm', args: ['run', 'typecheck:tests'], cwd: '.' };
const REPORT_READER = { vitest: { extension: 'json', read: parseVitestJson }, 'node-test': { extension: 'tap', read: parseTap } };
/* crapper's own code for a score over its threshold; this gate decides for itself what counts. */
const OVER_LIMIT = 2;

const ended = (name, status, exitCode, reason) => ({ name, status, exitCode, reason });
const unavailable = (name, reason, exitCode = null) => ended(name, 'unavailable', exitCode, reason);
const broken = (name, code) => unavailable(name, code === null ? `${name}_missing` : `${name}_failed`, code);

function fromCodes(name, codes) {
  const failed = codes.find(code => code !== 0 && code !== null);
  if (failed !== undefined) return ended(name, 'failed', failed);
  return codes.includes(null) ? unavailable(name, `${name}_missing`) : ended(name, 'passed', 0);
}

async function runAll(context, commands) {
  const codes = [];
  for (const command of commands) codes.push((await context.ports.exec(command.program, command.args, { cwd: command.cwd })).code);
  return codes;
}

async function formatStage(context) {
  if (!context.scripts['format:check']) return unavailable('format', 'repo_has_no_formatter');
  return fromCodes('format', await runAll(context, [{ program: 'npm', args: ['run', '-s', 'format:check'], cwd: '.' }]));
}

async function lintStage(context) {
  const files = context.paths.filter(isLintable);
  if (!files.length) return unavailable('lint', 'nothing_to_lint');
  return fromCodes('lint', await runAll(context, [{ program: 'npx', args: ['--no-install', 'eslint', ...files], cwd: '.' }]));
}

function typeChecks(context) {
  const selected = context.selection.packages ?? [];
  const touched = suite => selected.some(item => item.packageId === suite.id) || context.paths.some(path => ownerOf(context.suites, path) === suite);
  const checks = context.suites.filter(touched).flatMap(suite => suite.finalChecks);
  if (context.scripts['typecheck:tests'] && context.paths.some(path => TYPED.test(path))) checks.push(TEST_TYPES);
  return [...new Map(checks.map(check => [JSON.stringify(check), check])).values()];
}

async function typesStage(context) {
  const checks = typeChecks(context);
  return checks.length ? fromCodes('types', await runAll(context, checks)) : unavailable('types', 'nothing_to_typecheck');
}

function vitestFlags(sources, report) {
  const coverage = sources.length ? ['--coverage', '--coverage.reporter=lcov', '--coverage.reportsDirectory=coverage', '--coverage.reportOnFailure=true', ...sources.map(source => `--coverage.include=${source}`)] : [];
  return [...coverage, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
}

function nodeTestFlags(sources, report) {
  const coverage = sources.length ? ['--experimental-test-coverage', ...sources.map(source => `--test-coverage-include=${source}`), '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info'] : [];
  return [...coverage, '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${report}`];
}

const FLAGS = { vitest: vitestFlags, 'node-test': nodeTestFlags };

function testCommand(context, suite, units) {
  const adapter = adapterOf(suite.run);
  if (!adapter) return { command: suite.run, report: null };
  const { cwd } = suite.run;
  const sources = context.paths.filter(path => isSource(path) && ownerOf(context.suites, path) === suite).map(path => posix.relative(cwd, path));
  const files = suite.split.kind === 'argv-files' ? units.map(unit => `./${posix.relative(cwd, unit.file)}`) : [];
  const report = join(context.tmp, `tests-${suite.id}.${REPORT_READER[adapter].extension}`);
  return { command: { ...suite.run, args: [...suite.run.args, ...FLAGS[adapter](sources, report), ...files] }, report, reader: REPORT_READER[adapter].read };
}

function sumCounts(counts) {
  if (!counts.length || counts.includes(null)) return null;
  const add = name => counts.reduce((sum, item) => sum + item[name], 0);
  return { passed: add('passed'), failed: add('failed'), skipped: add('skipped'), total: add('total') };
}

async function testsStage(context) {
  const { selection, ports } = context;
  if (selection.unavailable) return unavailable('tests', selection.unavailable);
  if (!selection.packages.length) return unavailable('tests', 'nothing_selected');
  const codes = [], counts = [];
  for (const item of selection.packages) {
    const suite = context.suites.find(candidate => candidate.id === item.packageId);
    const { command, report, reader } = testCommand(context, suite, item.units);
    ports.mkdir(join(command.cwd, 'coverage'));
    codes.push(...await runAll(context, [command]));
    counts.push(report ? reader(ports.read(report)) : null);
  }
  context.numbers.tests = sumCounts(counts);
  return fromCodes('tests', codes);
}

function sourceGroups({ paths, suites }) {
  const groups = new Map();
  for (const path of paths.filter(isSource)) {
    const owner = ownerOf(suites, path), cwd = cwdOf(suites, path);
    const group = groups.get(cwd) ?? { cwd, files: [], measured: Boolean(owner && adapterOf(owner.run)) };
    group.files.push(posix.relative(cwd, path));
    groups.set(cwd, group);
  }
  return [...groups.values()];
}

function showJudged(judged, log) {
  for (const item of judged) {
    if (item.verdict !== 'fails' && item.verdict !== 'touched') continue;
    log(`${item.verdict === 'fails' ? 'FAILS' : 'TOUCHED'} ${item.namespace} ${item.name} cc=${item.complexity} base=${item.verdict === 'touched' ? 'kept' : item.baseCc ?? 'new'} cov=${item.coverage} crap=${item.crap}`);
  }
}

function crapperOutcome(judged, groups) {
  if (judged.some(item => item.verdict === 'fails')) return ended('crapper', 'failed', OVER_LIMIT);
  if (!judged.some(item => item.verdict === 'unknown')) return ended('crapper', 'passed', 0);
  return unavailable('crapper', groups.every(group => group.measured) ? 'crap_unknown' : 'no_coverage_adapter');
}

async function crapperStage(context) {
  const groups = sourceGroups(context);
  if (!groups.length) return unavailable('crapper', 'no_source_changed');
  if (context.selection.unavailable) return unavailable('crapper', 'no_coverage_measured');
  const judged = [];
  for (const group of groups) {
    const { code } = await context.ports.exec('crapper', [group.measured ? '--use-existing-coverage' : '--no-coverage', ...group.files], { cwd: group.cwd });
    if (code !== 0) return broken('crapper', code);
    const entries = parseCrapEdn(context.ports.read(join(group.cwd, '.metrics/crap.edn')) ?? '');
    judged.push(...judgeFunctions(entries, context.plan.grown[group.cwd] ?? []));
  }
  showJudged(judged, context.ports.log);
  context.numbers.worstCrap = worstCrap(judged);
  return crapperOutcome(judged, groups);
}

async function dryerStage(context) {
  const files = context.paths.filter(isCode);
  if (!files.length) return unavailable('dryer', 'no_source_changed');
  const { code, output } = await context.ports.exec('dryer', files, { cwd: '.' });
  if (code !== 0) return broken('dryer', code);
  context.numbers.dryerFlags = countDuplicates(output);
  return ended('dryer', 'passed', 0);
}

function changedLineNumbers(context) {
  const sources = context.paths.filter(isSource), coverage = {};
  for (const cwd of new Set(sources.map(path => cwdOf(context.suites, path)))) {
    for (const [file, lines] of Object.entries(parseLcov(context.ports.read(join(cwd, 'coverage/lcov.info')) ?? ''))) coverage[posix.join(cwd, file)] = lines;
  }
  return changedLines(context.plan.hunks, coverage, sources);
}

function stageLine({ name, status, exitCode, reason }, seconds) {
  return `STAGE ${name} ${status} exit=${exitCode}${seconds === undefined ? '' : ` secs=${seconds}`}${reason ? ` reason=${reason}` : ''}`;
}

function finished(sha, scope, stages, numbers) {
  const record = { version: 1, submissionCommit: sha, checkCommit: sha, scope, stages: stages.map(({ name, status, exitCode }) => ({ name, status, exitCode, partId: null })), numbers };
  return { stages, numbers, record };
}

/* Every stage for one reason, when none of them could begin. */
export function allUnavailable(sha, reason, paths, log) {
  const stages = NAMES.map(name => unavailable(name, reason));
  for (const stage of stages) log(stageLine(stage));
  return finished(sha, { kind: 'changed', paths }, stages, { tests: null, changedLines: null, worstCrap: null, dryerFlags: null });
}

const STEPS = [formatStage, lintStage, typesStage, testsStage, crapperStage, dryerStage];

export async function runStages(input, ports) {
  const paths = input.plan.changes.filter(change => change.kind !== 'deleted').map(change => change.path);
  const context = { ...input, ports, paths, numbers: { tests: null, changedLines: null, worstCrap: null, dryerFlags: null } };
  for (const note of input.selection.notes) ports.log(`NOTE ${note}`);
  const stages = [];
  for (const step of STEPS) {
    const started = Date.now();
    const stage = await step(context);
    stages.push(stage);
    ports.log(stageLine(stage, Math.round((Date.now() - started) / 1000)));
  }
  context.numbers.changedLines = changedLineNumbers(context);
  const whole = (input.selection.packages ?? []).some(item => item.mode === 'whole-package');
  return finished(input.sha, { kind: whole ? 'package' : 'changed', paths: input.plan.changes.map(change => change.path) }, stages, context.numbers);
}
