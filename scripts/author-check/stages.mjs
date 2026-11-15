import { Buffer } from 'node:buffer';
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
const MAX_BATCH_ITEMS = 200;
const MAX_BATCH_BYTES = 16_384;

const ended = (name, status, exitCode, reason) => ({ name, status, exitCode, reason });
const unavailable = (name, reason, exitCode = null) => ended(name, 'unavailable', exitCode, reason);
const broken = (name, code) => unavailable(name, code === null ? `${name}_missing` : `${name}_failed`, code);
const fitsInBatch = (batch, bytes, size) => batch.length < MAX_BATCH_ITEMS && bytes + size <= MAX_BATCH_BYTES;

function batches(items) {
  const result = [];
  let current = [], bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(item) + 1;
    if (current.length && !fitsInBatch(current, bytes, size)) { result.push(current); current = []; bytes = 0; }
    current.push(item);
    bytes += size;
  }
  return current.length ? [...result, current] : result;
}

function fromCodes(name, codes) {
  const failed = codes.find(code => code !== 0 && code !== null);
  if (failed !== undefined) return ended(name, 'failed', failed);
  return codes.includes(null) ? unavailable(name, `${name}_missing`) : ended(name, 'passed', 0);
}

async function runAll(context, commands) {
  const codes = [];
  for (const command of commands) codes.push((await context.ports.exec(command.program, command.args, { cwd: command.cwd, env: command.env })).code);
  return codes;
}

async function formatStage(context) {
  if (!context.scripts['format:check']) return unavailable('format', 'repo_has_no_formatter');
  return fromCodes('format', await runAll(context, [{ program: 'npm', args: ['run', '-s', 'format:check'], cwd: '.' }]));
}

function lintBatches(files, suites) {
  if (batches(files).length <= 1) return batches(files);
  const groups = Map.groupBy(files, file => ownerOf(suites, file)?.root ?? '.');
  return [...groups.values()].flatMap(batches);
}

async function lintStage(context) {
  const files = context.paths.filter(isLintable);
  if (!files.length) return unavailable('lint', 'nothing_to_lint');
  const commands = lintBatches(files, context.suites).map(batch => ({ program: 'npx', args: ['--no-install', 'eslint', ...batch], cwd: '.' }));
  return fromCodes('lint', await runAll(context, commands));
}

const TSC = /^tsc -p (\S+)((?: \S+)*)$/;
const BUILD = /^npm run (?:-s )?build -w \S+$/;
const words = text => text.split(' ').filter(Boolean);

function workspaceOf(context, root) {
  try {
    const manifest = JSON.parse(context.ports.read(`${root}/package.json`));
    return { name: manifest.name, uses: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }) };
  } catch { return { name: null, uses: [] }; }
}

/* The projects the test types reach: those holding a changed file, and those that use one of them, at any remove. */
function reachedProjects(context, projects, typed) {
  const known = projects.map(project => ({ ...project, ...workspaceOf(context, project.root) }));
  const reached = new Set(known.filter(project => typed.some(path => path.startsWith(`${project.root}/`))));
  for (let grew = true; grew;) {
    const names = new Set([...reached].map(project => project.name).filter(Boolean));
    const more = known.filter(project => !reached.has(project) && project.uses.some(name => names.has(name)));
    for (const project of more) reached.add(project);
    grew = more.length > 0;
  }
  return known.filter(project => reached.has(project));
}

/* The repository's test types, step by step, of only the projects a change reaches. Its builds come first, as the script has
   them. A typed file outside every project reaches them all, and so does a script this cannot read step by step. */
function testTypeChecks(context) {
  const script = context.scripts['typecheck:tests'], typed = context.paths.filter(path => TYPED.test(path));
  if (!script || !typed.length) return [];
  const steps = script.split('&&').map(step => step.trim());
  const projects = steps.flatMap(step => { const found = TSC.exec(step); return found ? [{ config: found[1], root: posix.dirname(found[1]), rest: words(found[2]) }] : []; });
  if (!projects.length || steps.some(step => !TSC.test(step) && !BUILD.test(step))) return [TEST_TYPES];
  if (typed.some(path => !projects.some(project => path.startsWith(`${project.root}/`)))) return [TEST_TYPES];
  const builds = steps.filter(step => BUILD.test(step)).map(step => ({ program: 'npm', args: words(step).slice(1), cwd: '.' }));
  return [...builds, ...reachedProjects(context, projects, typed).map(project => ({ program: 'npx', args: ['--no-install', 'tsc', '-p', project.config, ...project.rest], cwd: '.' }))];
}

function typeChecks(context) {
  const selected = context.selection.packages ?? [];
  const touched = suite => selected.some(item => item.packageId === suite.id) || context.paths.some(path => ownerOf(context.suites, path) === suite);
  const checks = [...context.suites.filter(touched).flatMap(suite => suite.finalChecks), ...testTypeChecks(context)];
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
const reportName = (suiteId, index, extension) => `tests-${suiteId}${index ? `-${index + 1}` : ''}.${extension}`;
const suiteBatches = (suite, paths) => (suite.split.kind === 'argv-files' && paths.length ? batches(paths) : [paths]);
const lcovHits = text => (text === '-' ? 0 : Number(text));

function coverageIncludes(sources) {
  if (batches(sources).length <= 1) return sources;
  const compact = [...new Set(sources.map(source => (source.includes('/') ? `${source.split('/')[0]}/**` : source)))];
  return batches(compact).length <= 1 ? compact : ['**'];
}

function fileCoverage(files, name) {
  if (!files.has(name)) files.set(name, { da: new Map(), brda: new Map() });
  return files.get(name);
}

function addLcovLine(record, line) {
  const da = /^DA:(\d+),(\d+)/.exec(line);
  if (da) record.da.set(da[1], (record.da.get(da[1]) ?? 0) + Number(da[2]));
  const brda = /^BRDA:(\d+,[^,]+,[^,]+),(-|\d+)/.exec(line);
  if (brda) record.brda.set(brda[1], (record.brda.get(brda[1]) ?? 0) + lcovHits(brda[2]));
}

function mergeLcov(parts) {
  if (parts.length === 1) return parts[0];
  const files = new Map();
  let current = null;
  for (const line of parts.join('\n').split('\n')) {
    if (line.startsWith('SF:')) current = fileCoverage(files, line.slice(3));
    else if (current) addLcovLine(current, line);
  }
  return [...files].map(([file, { da, brda }]) => [
    `SF:${file}`, ...[...da].map(([k, v]) => `DA:${k},${v}`), ...[...brda].map(([k, v]) => `BRDA:${k},${v}`), 'end_of_record', '',
  ].join('\n')).join('');
}

/* How a suite is told its files: by arguments, or, as on a node, by the file its Vitest sequencer reads, which also asks for a shard. */
function chosenFiles(context, suite, paths) {
  if (suite.split.kind === 'argv-files') return { files: paths };
  if (suite.split.kind !== 'vitest-shard') return {};
  const filesPath = join(context.tmp, `files-${suite.id}.json`);
  context.ports.write(filesPath, JSON.stringify(paths));
  return { shard: ['--shard=1/1'], env: { HH_TEST_FILES: filesPath } };
}

function testCommand(context, suite, paths, index) {
  const adapter = adapterOf(suite.run);
  if (!adapter) return { command: suite.run, report: null };
  const { cwd } = suite.run;
  const sourceRoot = adapter === 'vitest' ? suite.root : cwd;
  const sources = context.paths.filter(path => isSource(path) && ownerOf(context.suites, path) === suite).map(path => posix.relative(sourceRoot, path));
  const { shard = [], files = [], env } = chosenFiles(context, suite, paths);
  const report = join(context.tmp, reportName(suite.id, index, REPORT_READER[adapter].extension));
  return { command: { ...suite.run, args: [...suite.run.args, ...shard, ...FLAGS[adapter](coverageIncludes(sources), report), ...files], env }, report, reader: REPORT_READER[adapter].read, coverageFile: sources.length ? join(cwd, 'coverage/lcov.info') : null };
}

function sumCounts(counts) {
  if (!counts.length || counts.includes(null)) return null;
  const add = name => counts.reduce((sum, item) => sum + item[name], 0);
  return { passed: add('passed'), failed: add('failed'), skipped: add('skipped'), total: add('total') };
}

function testReportStatus(counts) {
  if (counts.some(count => count !== null && (count.failed > 0 || count.passed === 0))) return ended('tests', 'failed', 1, 'tests_not_passed');
  if (counts.includes(null)) return unavailable('tests', 'test_report_unavailable');
  return null;
}

async function testsStage(context) {
  const { selection, ports } = context;
  if (selection.unavailable) return unavailable('tests', selection.unavailable);
  if (!selection.packages.length) return unavailable('tests', 'nothing_selected');
  if (selection.packages.some(item => !item.units.length && adapterOf(context.suites.find(suite => suite.id === item.packageId).run))) return ended('tests', 'failed', 1, 'empty_test_selection');
  const results = [], coverage = new Map();
  for (const item of selection.packages) results.push(await runTestSuite(context, item, coverage));
  for (const [path, parts] of coverage) ports.write(path, mergeLcov(parts));
  context.numbers.tests = sumCounts(results.map(result => result.counts));
  const execution = fromCodes('tests', results.flatMap(result => result.codes));
  const reported = results.filter(result => result.reported).map(result => result.counts);
  return execution.status === 'passed' ? testReportStatus(reported) ?? execution : execution;
}

function keepCoverage(ports, path, coverage) {
  if (!path) return;
  const text = ports.read(path);
  if (text !== null) coverage.set(path, [...(coverage.get(path) ?? []), text]);
}

async function runTestSuite(context, item, coverage) {
  const suite = context.suites.find(candidate => candidate.id === item.packageId);
  const paths = item.units.map(unit => `./${posix.relative(suite.run.cwd, unit.file)}`);
  const codes = [], counts = [];
  let reported = false;
  for (const [index, batch] of suiteBatches(suite, paths).entries()) {
    const { command, report, reader, coverageFile } = testCommand(context, suite, batch, index);
    context.ports.mkdir(join(command.cwd, 'coverage'));
    codes.push(...await runAll(context, [command]));
    keepCoverage(context.ports, coverageFile, coverage);
    if (report) { reported = true; counts.push(reader(context.ports.read(report))); }
  }
  return { codes, reported, counts: reported ? sumCounts(counts) : null };
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

async function crapperEntries(context, group) {
  const flag = group.measured ? '--use-existing-coverage' : '--no-coverage', entries = [];
  for (const batch of batches(group.files)) {
    const { code } = await context.ports.exec('crapper', [flag, ...batch], { cwd: group.cwd });
    if (code !== 0) return { failed: broken('crapper', code) };
    entries.push(...parseCrapEdn(context.ports.read(join(group.cwd, '.metrics/crap.edn')) ?? ''));
  }
  return { entries };
}

async function crapperStage(context) {
  const groups = sourceGroups(context);
  if (!groups.length) return unavailable('crapper', 'no_source_changed');
  if (context.selection.unavailable) return unavailable('crapper', 'no_coverage_measured');
  const judged = [];
  for (const group of groups) {
    const { entries, failed } = await crapperEntries(context, group);
    if (failed) return failed;
    judged.push(...judgeFunctions(entries, context.plan.grown[group.cwd] ?? []));
  }
  showJudged(judged, context.ports.log);
  context.numbers.worstCrap = worstCrap(judged);
  return crapperOutcome(judged, groups);
}

async function dryerStage(context) {
  const files = context.paths.filter(isCode);
  if (!files.length) return unavailable('dryer', 'no_source_changed');
  let flags = 0;
  for (const batch of batches(files)) {
    const { code, output } = await context.ports.exec('dryer', batch, { cwd: '.' });
    if (code !== 0) return broken('dryer', code);
    flags += countDuplicates(output);
  }
  context.numbers.dryerFlags = flags;
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
  const leftToFullRun = input.selection.leftToFullRun ?? [];
  ports.log(`TEST_SELECTION ${JSON.stringify({ version: 1, commit: input.sha, baseCommit: input.plan.base, status: input.selection.unavailable ? 'NOT_RUN' : 'selected', sourcePaths: input.plan.changes.map(change => change.path), packages: input.selection.packages ?? [], leftToFullRun, reason: input.selection.unavailable ?? null, fullSuiteComparator: 'unavailable' })}`);
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
  return finished(input.sha, { kind: whole ? 'package' : 'changed', paths: input.plan.changes.map(change => change.path), leftToFullRun }, stages, context.numbers);
}
