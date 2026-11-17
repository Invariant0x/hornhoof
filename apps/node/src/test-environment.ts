import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { CandidateMutation, CheckSlotQueue, hashTestEnvironment, parseTestEnvironment, validateEnvironmentDescription, TEST_ENVIRONMENT_BYTES, RepositoryPath, UnitFingerprints, type Command, type TestSuite, type TestPrepare, type NodeMessage, type ServerMessage, type TestsDescribed, type EnvironmentDescription, type EnvironmentSnapshot, type EnvironmentProblem, type InputDigest, type RepositoryScope, type RuntimeCapability, type TestEnvironmentV1, type TestUnit, type UnitFingerprint } from '@hornhoof/protocol';
import { cacheKey, checkCacheContext, prepareCache, restoreCache, privateCacheRoot, type CacheEntry, type CacheContext, type CacheShare } from './test-cache.js';
import { DiscoveryProblem, discoverEnvironment } from './test-discovery.js';
import { withCheckSlot } from './check-queue.js';
import { prepareServiceArtifacts, openServices, type OpenedServices, type ServiceArtifacts, type ServiceContext, type ServiceDefinition, type ServiceDefinitions } from './test-services.js';
import type { JobUser } from './isolation.js';
import { readCommit, type CommitTree, type GitEntry } from './test-mirror.js';
import { readCandidateMutations, readTestFingerprints } from './test-fingerprint.js';
import { matchesPattern as match } from './test-impact.js';

type Source = Parameters<typeof readCommit>[0];
type DescriptionContext = CacheContext & { runtimes?: RuntimeCapability[] };
export const MANIFEST = '.hornhoof/test-environment.json';
const INPUT_BYTES = 16 * 1024 * 1024;
const LFS = 'version https://git-lfs.github.com/spec/v1\n';
const lfsPointer = (bytes: Buffer): boolean => bytes.subarray(0, LFS.length).toString('ascii') === LFS;
export class EnvironmentFailure extends Error {
  constructor(readonly problem: EnvironmentProblem) { super(problem.detail); }
}
function fail(code: EnvironmentProblem['code'], detail: string): never { throw new EnvironmentFailure({ code, detail }); }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const inputHash = (mode: string) => createHash('sha256').update(mode).update('\0');
/* Git blobs, generated inputs and the builder's checkout all use the same content and executable-mode identity. */
export async function preparationInputDigest(path: string, context: Pick<CacheContext, 'deadline' | 'signal'>): Promise<string> {
  checkCacheContext(context);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail('environment_invalid', 'A preparation input is not a regular file.');
    const hash = inputHash(stat.mode & 0o111 ? '100755' : '100644');
    for await (const chunk of file.createReadStream({ autoClose: false })) { checkCacheContext(context); hash.update(chunk); }
    return hash.digest('hex');
  } finally { await file.close(); }
}
function regular(entry: GitEntry): void {
  if (!['100644', '100755'].includes(entry.mode)) fail('environment_unsupported', `A declared input is not a regular tracked file: ${entry.path}.`);
}
async function blob(tree: CommitTree, path: string, limit: number): Promise<Buffer> {
  const entry = tree.entries.find(item => item.path === path);
  if (!entry) fail('environment_invalid', `A declared file is missing: ${path}.`);
  regular(entry);
  const bytes = await tree.readBlob(path, limit);
  if (lfsPointer(bytes)) fail('environment_unsupported', `Git LFS materialization is not described for ${path}.`);
  return bytes;
}
function inputPatterns(manifest: TestEnvironmentV1): string[] {
  return [...new Set([...manifest.dependencies.inputs, ...manifest.prepare.flatMap(unit => unit.inputs), ...(manifest.reset ?? []).flatMap(reset => reset.inputs)])].sort();
}
async function inputDigests(tree: CommitTree, manifest: TestEnvironmentV1): Promise<InputDigest[]> {
  const inputs = new Map<string, string | null>(), wanted = new Set<string>(), pointers: string[] = [];
  for (const pattern of inputPatterns(manifest)) {
    const entries = tree.entries.filter(entry => match(entry.path, pattern));
    if (!entries.length) inputs.set(pattern, null);
    for (const entry of entries) { regular(entry); wanted.add(entry.path); }
  }
  const modes = new Map(tree.entries.map(entry => [entry.path, entry.mode]));
  await tree.readBlobs([...wanted], INPUT_BYTES, (path, bytes) => { if (lfsPointer(bytes)) pointers.push(path); inputs.set(path, inputHash(modes.get(path)!).update(bytes).digest('hex')); });
  if (pointers.length) fail('environment_unsupported', `Git LFS materialization is not described for ${pointers[0]}.`);
  return [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([path, digest]) => ({ path, digest }));
}
function fixtureInputs(tree: CommitTree, manifest: TestEnvironmentV1): void {
  for (const reset of manifest.reset ?? []) {
    if (reset.command === null && !reset.inputs.some(pattern => tree.entries.some(entry => match(entry.path, pattern)))) fail('environment_invalid', 'A fixture reset has no tracked fixture input.');
  }
}
export function listTestUnits(manifest: TestEnvironmentV1, tracked: GitEntry[]): TestUnit[] {
  const units: TestUnit[] = [];
  for (const suite of manifest.suites) {
    for (const entry of tracked) {
      if (!suite.files.some(pattern => match(entry.path, pattern))) continue;
      regular(entry);
      units.push({ suiteId: suite.id, file: entry.path, selectionUnit: suite.split.kind === 'whole-package' ? suite.root : entry.path });
    }
  }
  return units.sort((a, b) => `${a.suiteId}:${a.file}`.localeCompare(`${b.suiteId}:${b.file}`));
}
function manifestFrom(bytes: Buffer): TestEnvironmentV1 {
  try { return parseTestEnvironment(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('environment_invalid', 'The pinned test environment is not a valid version 1 manifest.'); }
}
/* The repository's own description, or else what its files say of it, which then goes on as if it had written that. */
async function manifestBytes(tree: CommitTree): Promise<Buffer> {
  if (tree.entries.some(entry => entry.path === MANIFEST)) return blob(tree, MANIFEST, TEST_ENVIRONMENT_BYTES);
  try { return Buffer.from(JSON.stringify(await discoverEnvironment(tree))); }
  catch (error) { if (error instanceof DiscoveryProblem) fail(error.code, error.message); throw error; }
}
export async function readTestEnvironment(source: Source, repositoryScope: RepositoryScope, commitSha: string, context: DescriptionContext): Promise<EnvironmentDescription> {
  const tree = await readCommit(source, repositoryScope, commitSha, context);
  const bytes = await manifestBytes(tree), manifest = manifestFrom(bytes);
  fixtureInputs(tree, manifest);
  return validateEnvironmentDescription({ version: 1, repositoryScope, commitSha, manifestSource: bytes.toString('utf8'), manifestHash: await hashTestEnvironment(bytes), manifest, inputDigests: await inputDigests(tree, manifest), inventory: listTestUnits(manifest, tree.entries), runtimeCapabilities: context.runtimes ?? await trustedTestRuntimes(context) });
}
/* A description with what lets the server reuse results. Only the description is needed for a run: without fingerprints, everything
   runs. A manifest that names no full run reuses nothing, so nothing of the commit is read for them. */
export async function describeTestEnvironment(source: Source, repositoryScope: RepositoryScope, commitSha: string, context: DescriptionContext, fingerprints = readTestFingerprints, baseCommit?: string): Promise<{ description: EnvironmentDescription; fingerprints?: UnitFingerprint[]; baseFingerprints?: { commitSha: string; fingerprints: UnitFingerprint[] }; mutation?: Awaited<ReturnType<typeof readCandidateMutations>> }> {
  const description = await readTestEnvironment(source, repositoryScope, commitSha, context);
  if (baseCommit !== undefined) {
    const sameRuntime = { ...context, runtimes: description.runtimeCapabilities };
    const finalPrints = UnitFingerprints.parse(await fingerprints(source, repositoryScope, description, sameRuntime));
    const base = await readTestEnvironment(source, repositoryScope, baseCommit, sameRuntime);
    const basePrints = UnitFingerprints.parse(await fingerprints(source, repositoryScope, base, sameRuntime));
    const mutation = await readCandidateMutations(source, repositoryScope, description, baseCommit, sameRuntime);
    return { description, fingerprints: mutationFingerprints(finalPrints, mutation), baseFingerprints: { commitSha: base.commitSha, fingerprints: basePrints }, ...(mutation ? { mutation } : {}) };
  }
  if (!description.manifest.execution?.fullRun) return { description };
  try { return { description, fingerprints: UnitFingerprints.parse(await fingerprints(source, repositoryScope, description, context)) }; }
  catch { context.signal.throwIfAborted(); return { description }; }
}

function mutationFingerprints(prints: UnitFingerprint[], mutation: Awaited<ReturnType<typeof readCandidateMutations>>): UnitFingerprint[] {
  return prints.map(print => {
    const functions = mutation?.selection.selected.filter(fn => fn.file === print.file);
    return functions?.length ? { ...print, fingerprint: digest(JSON.stringify(['hornhoof-mutation-function-v1', print.fingerprint, functions])) } : print;
  });
}

async function runtimeOutput(program: string, args: string[], context: CacheContext): Promise<string | null> {
  checkCacheContext(context);
  return new Promise(resolve => execFile(program, args, { cwd: context.cacheRoot, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: context.cacheRoot }, timeout: Math.max(1, Math.min(2000, context.deadline - Date.now())), signal: context.signal, maxBuffer: 16 * 1024 }, (error, stdout) => resolve(error ? null : stdout.trim())));
}
let libcVersion: string | undefined;
const libc = (): string => libcVersion ??= (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ?? 'unknown';
/* The fingerprint is of the exact build, for what a machine installs and builds; the platform says the class a test result holds for. */
function capability(id: string, version: string, build: unknown): RuntimeCapability {
  return { id, version, fingerprint: digest(JSON.stringify({ platform: process.platform, arch: process.arch, libc: libc(), build })),
    platform: { os: process.platform, arch: process.arch, libc: libc() === 'unknown' ? 'other' : 'glibc' } };
}
async function pythonRuntime(context: CacheContext): Promise<RuntimeCapability[]> {
  const output = await runtimeOutput('/usr/bin/python3', ['-I', '-c', 'import json,sys,sysconfig;print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"build":sys.version,"abi":sysconfig.get_config_var("SOABI")}))'], context);
  if (!output) return [];
  const info = JSON.parse(output) as { version: string; build: string; abi: string };
  return [capability('python', info.version, info)];
}
async function postgresRuntime(context: CacheContext): Promise<RuntimeCapability[]> {
  const output = await runtimeOutput('/usr/lib/postgresql/17/bin/postgres', ['--version'], context);
  const version = output && /PostgreSQL\)\s+(\d+(?:\.\d+){1,2})/.exec(output)?.[1];
  return version ? [capability('postgres', version, output)] : [];
}
export async function trustedTestRuntimes(context: CacheContext): Promise<RuntimeCapability[]> {
  const npm = await runtimeOutput('/usr/local/bin/npm', ['--userconfig=/dev/null', '--globalconfig=/dev/null', '--version'], context);
  const node = capability('node', process.versions.node, { abi: process.versions, npm });
  const [python, postgres] = await Promise.all([pythonRuntime(context), postgresRuntime(context)]);
  checkCacheContext(context);
  return [node, ...python, ...postgres, capability('hornhoof-test-execution', '2.0.0', { batch: 2, oncePreparation: 2 })];
}


export async function safeCheckoutPath(checkout: string, path: string): Promise<string> {
  RepositoryPath.parse(path);
  const root = await realpath(checkout), full = await realpath(resolve(checkout, path)), inside = relative(root, full);
  if (inside === '..' || inside.startsWith('../')) fail('environment_invalid', 'A command or selected file escapes its checkout.');
  return full;
}
function validShardCoordinates(shard: { index: number; count: number }): boolean {
  return Number.isInteger(shard.index) && Number.isInteger(shard.count) && shard.index >= 1 && shard.index <= shard.count && shard.count <= 10;
}
function shardCommand(suite: TestSuite, shard: { index: number; count: number } | undefined): Command {
  if (suite.split.kind !== 'vitest-shard') return suite.run;
  if (!shard || !validShardCoordinates(shard)) fail('environment_invalid', 'A native Vitest invocation needs valid local shard coordinates.');
  if (suite.run.args.some(arg => arg === '--shard' || arg.startsWith('--shard='))) fail('environment_invalid', 'The pinned suite command already sets shard coordinates.');
  return { ...suite.run, args: [...suite.run.args, `--shard=${shard.index}/${shard.count}`] };
}
type InvocationContext = { checkout: string; filesPath: string; shard?: { index: number; count: number }; snapshot?: EnvironmentSnapshot };
function selectedCandidateMutation(suite: TestSuite, files: string[], candidate: NonNullable<EnvironmentSnapshot['candidate']>, policy: Extract<TestEnvironmentV1['mutation'], { status: 'supported' }>) {
  if (suite.split.kind !== 'json-file' || !policy.candidateRun || !candidate.mutation) fail('environment_invalid', 'Candidate mutation requires a declared narrow invocation and its bound scope.');
  const mutation = CandidateMutation.parse(candidate.mutation), selected = new Set(mutation.selection.selected.map(fn => fn.file));
  if (mutation.selection.status !== 'ready' || files.some(file => !selected.has(file))) fail('environment_invalid', 'The mutation selection is blocked or includes an unproved source.');
  return { mutation, run: policy.candidateRun };
}
async function candidateMutationInvocation(suite: TestSuite, files: string[], context: InvocationContext): Promise<{ command: Command; planFile: string } | null> {
  const candidate = context.snapshot?.candidate, policy = context.snapshot?.description.manifest.mutation;
  if (!candidate || policy?.status !== 'supported' || !files.some(file => policy.sourcePaths.includes(file))) return null;
  const { mutation, run } = selectedCandidateMutation(suite, files, candidate, policy);
  const { delta } = mutation, planFile = `${context.filesPath}.mutation-plan.json`;
  const plan = { sha: delta.commit, base: delta.baseCommit, changes: delta.changes.map(change => ({ path: change.path, kind: 'modified' })), hunks: Object.fromEntries(delta.changes.map(change => [change.path, change.ranges])) };
  const output = await open(planFile, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(plan)); } finally { await output.close(); }
  const argumentsFor: Record<string, string> = { '{baseCommit}': delta.baseCommit, '{commit}': delta.commit, '{planFile}': planFile };
  return { planFile, command: { ...run, args: run.args.map(arg => argumentsFor[arg] ?? arg) } };
}
async function validateSuiteFiles(suite: TestSuite, files: string[], checkout: string): Promise<void> {
  for (const file of files) {
    await safeCheckoutPath(checkout, file);
    if (!(await lstat(resolve(checkout, file))).isFile() || !suite.files.some(pattern => match(file, pattern))) fail('environment_invalid', 'A selection is not a regular file of the suite.');
  }
}
export async function buildTestInvocation(suite: TestSuite, files: string[], context: InvocationContext): Promise<{ command: Command; env: Record<string, string> }> {
  if (!files.length) fail('environment_invalid', 'A suite needs a nonempty file inventory.');
  const mutation = await candidateMutationInvocation(suite, files, context);
  const command = mutation?.command ?? shardCommand(suite, context.shard);
  await safeCheckoutPath(context.checkout, command.cwd);
  await validateSuiteFiles(suite, files, context.checkout);
  if (suite.split.kind === 'whole-package') return { command, env: {} };
  const paths = files.map(file => `./${relative(resolve(context.checkout, command.cwd), resolve(context.checkout, file))}`);
  if (suite.split.kind === 'argv-files') return { command: { ...command, args: [...command.args, ...paths] }, env: {} };
  const output = await open(context.filesPath, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(paths)); } finally { await output.close(); }
  return { command, env: { HH_TEST_FILES: context.filesPath, ...(mutation ? { HH_MUTATION_PLAN_FILE: mutation.planFile } : {}) } };
}

/* Vitest suites whose commands differ only in the projects they name can run as one command over the projects and files of them
   all: one pool of workers then takes the files of every suite, instead of each suite's slowest file holding the machine in turn. */
export type SharedMember = { suite: TestSuite; files: string[]; shard: { index: number; count: number } };
const PROJECT = /^--project=./;
const withoutProjects = (command: Command): string => JSON.stringify({ ...command, args: command.args.filter(arg => !PROJECT.test(arg)) });
function shareable(member: SharedMember, snapshot: EnvironmentSnapshot | undefined): boolean {
  const { suite, files, shard } = member, policy = snapshot?.description.manifest.mutation;
  /* A suite whose candidate mutation needs a command of its own never shares one. */
  const mutated = !!snapshot?.candidate && policy?.status === 'supported' && files.some(file => policy.sourcePaths.includes(file));
  return suite.split.kind === 'vitest-shard' && files.length > 0 && validShardCoordinates(shard) && !mutated
    && !suite.run.args.some(arg => arg === '--project' || arg === '--shard' || arg.startsWith('--shard=')) && suite.run.args.some(arg => PROJECT.test(arg));
}
export function sharedVitestCommand(members: SharedMember[], snapshot?: EnvironmentSnapshot): Command | null {
  if (members.length < 2 || members.some(member => !shareable(member, snapshot))) return null;
  const commands = members.map(member => shardCommand(member.suite, member.shard)), first = commands[0]!;
  if (commands.some(command => withoutProjects(command) !== withoutProjects(first))) return null;
  const projects = [...new Set(commands.flatMap(command => command.args.filter(arg => PROJECT.test(arg))))], at = first.args.findIndex(arg => PROJECT.test(arg));
  const rest = first.args.filter(arg => !PROJECT.test(arg));
  return { ...first, args: [...rest.slice(0, at), ...projects, ...rest.slice(at)] };
}
/* The one command of such suites, given every selected file of each, checked as for one suite. */
export async function buildSharedTestInvocation(members: SharedMember[], context: InvocationContext): Promise<{ command: Command; env: Record<string, string> }> {
  const command = sharedVitestCommand(members, context.snapshot);
  if (!command) fail('environment_invalid', 'These suites cannot share one command.');
  await safeCheckoutPath(context.checkout, command.cwd);
  for (const member of members) await validateSuiteFiles(member.suite, member.files, context.checkout);
  const paths = members.flatMap(member => member.files.map(file => `./${relative(resolve(context.checkout, command.cwd), resolve(context.checkout, file))}`));
  const output = await open(context.filesPath, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(paths)); } finally { await output.close(); }
  return { command, env: { HH_TEST_FILES: context.filesPath } };
}


function selectedInputs(description: EnvironmentDescription, patterns: string[]): InputDigest[] {
  return description.inputDigests.filter(input => patterns.some(pattern => match(input.path, pattern)));
}
/* Which of the machine's programs a command runs on: by its name, or by what a shell line of it calls. */
function commandRuntime(command: Command): string[] {
  const program = basename(command.program), line = program === 'sh' ? command.args.join(' ') : '';
  const node = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack'].includes(program) || /\b(?:node|npm|npx|pnpm|yarn|corepack)\b/.test(line);
  const python = /^python(?:[23](?:\.\d+)?)?$/.test(program) || /\bpython[23]?\b/.test(line);
  return [...(node ? ['node'] : []), ...(python ? ['python'] : [])];
}
function commandRuntimes(description: EnvironmentDescription, commands: Command[]): string[] {
  const serviceRuntimes = new Set(description.manifest.services.map(service => service.runtime));
  return [...new Set([...description.manifest.runtimes.filter(runtime => !serviceRuntimes.has(runtime.id)).map(runtime => runtime.id), ...commands.flatMap(commandRuntime)])];
}
/* What any command builds depends on the machine, whichever program it names, and this runtime holds the machine's platform,
   architecture and libc. So a key always holds it, and another architecture always builds its own. */
const MACHINE_RUNTIME = 'hornhoof-test-execution';
function runtimeFingerprint(description: EnvironmentDescription, ids: string[]): string {
  const fingerprints = [...new Set([...ids, MACHINE_RUNTIME])].sort().map(id => {
    const actual = description.runtimeCapabilities.find(runtime => runtime.id === id);
    if (!actual) fail('runtime_missing', `The node lacks the ${id} runtime.`);
    return { id, fingerprint: actual.fingerprint };
  });
  return digest(JSON.stringify(fingerprints));
}
export function dependencyCacheKey(description: EnvironmentDescription): string {
  const { dependencies } = description.manifest;
  return cacheKey({ runtime: runtimeFingerprint(description, commandRuntimes(description, dependencies.install)), settings: { format: 'hornhoof-dependencies-v1', repositoryScope: description.repositoryScope, adapter: dependencies.adapter, install: dependencies.install, paths: [...dependencies.paths].sort(), cache: dependencies.cache, env: dependencies.env ?? {}, bin: dependencies.bin ?? [] }, inputs: selectedInputs(description, dependencies.inputs) });
}
export function environmentCacheKey(description: EnvironmentDescription, unitId: string, dependencyKey: string, preparedInputs?: InputDigest[]): string {
  const unit = description.manifest.prepare.find(unit => unit.id === unitId);
  if (!unit) fail('environment_invalid', 'The preparation unit does not exist in the pinned manifest.');
  const services = description.manifest.services.filter(service => unit.serviceIds.includes(service.id));
  const runtimes = [...commandRuntimes(description, unit.commands), ...services.map(service => service.runtime)];
  const settings = { format: 'hornhoof-environment-v1', repositoryScope: description.repositoryScope, unitId, dependencyKey, commands: unit.commands, artifacts: unit.artifacts, reset: description.manifest.reset, services: services.map(({ id, driver, runtime, options }) => ({ id, driver, runtime, options })) };
  return cacheKey({ runtime: runtimeFingerprint(description, runtimes), settings, inputs: preparedInputs ?? selectedInputs(description, unit.inputs) });
}


/* One version of a product's harness, the same on every architecture while nothing it is built from changes. What a machine
   builds from it has a key of its own, as that also holds the machine's program and architecture. */
export function harnessVersion(description: EnvironmentDescription): string {
  const { dependencies, prepare, services, reset } = description.manifest;
  return digest(JSON.stringify({ dependencies, prepare, services, reset, inputs: description.inputDigests }));
}
export const harnessPlatform = (): string => `${process.platform}-${process.arch}`;
export type TestCapabilities = { testEnvironmentVersion?: 1; testRuntimes?: RuntimeCapability[]; testHarness?: 1 };
export async function nodeTestCapabilities(dir: string, user: JobUser | null): Promise<TestCapabilities> {
  if (!user || user.uid === 0 || user.uid === process.getuid?.()) return {};
  const cacheRoot = await privateCacheRoot(join(dir, 'cache'));
  return { testEnvironmentVersion: 1, testHarness: 1, testRuntimes: await trustedTestRuntimes({ cacheRoot, signal: new AbortController().signal, deadline: Date.now() + 10_000, log: () => {} }) };
}
type TestRunMessage = Extract<ServerMessage, { type: 'tests.run' }>;
type DescribeMessage = Extract<ServerMessage, { type: 'tests.describe' }>;
type HarnessMessage = Extract<ServerMessage, { type: 'tests.harness' }>;
type TestMessage = Extract<ServerMessage, { type: 'tests.run' | 'tests.cancel' | 'tests.describe' | 'tests.describe.cancel' | 'tests.harness' }>;
type ActiveTest = { stop: AbortController; done: Promise<void> };
export function isNodeTestMessage(message: { type: string }): message is TestMessage {
  return ['tests.run', 'tests.cancel', 'tests.describe', 'tests.describe.cancel', 'tests.harness'].includes(message.type);
}
type TestMessageOptions = {
  dir: string; describe?: typeof readTestEnvironment; capabilities: TestCapabilities; stopped: () => boolean;
  testing: Map<string, ActiveTest>;
  /* The parts whose end Hornhoof has not confirmed yet: none of them runs again. */
  unconfirmed: { has(partId: string): boolean };
  run: (message: TestRunMessage, signal: AbortSignal) => Promise<void>;
  harness?: (message: HarnessMessage, signal: AbortSignal) => Promise<NodeMessage>;
  emit: (message: NodeMessage) => void;
};
function describeSignature(message: DescribeMessage): string {
  return digest(JSON.stringify({ scope: message.repositoryScope, url: message.repo.url, sha: message.commitSha, base: message.baseCommit }));
}
function descriptionProblem(error: unknown, signal: AbortSignal): EnvironmentProblem {
  if (signal.aborted) return { code: 'cancelled', detail: 'The test environment description was cancelled.' };
  if (error instanceof EnvironmentFailure) return error.problem;
  if (error instanceof DOMException && error.name === 'TimeoutError') return { code: 'timeout', detail: 'The test environment description exceeded its execution deadline.' };
  return { code: 'commit_unavailable', detail: 'The node could not describe the pinned repository commit.' };
}
export class NodeTestMessages {
  private readonly describing = new Map<string, ActiveTest & { signature: string }>();
  private readonly described = new Map<string, { signature: string; reply: TestsDescribed }>();
  private readonly syncing = new Map<string, ActiveTest>();
  constructor(private readonly options: TestMessageOptions) {}
  handle(message: TestMessage): Promise<void> | void {
    switch (message.type) {
      case 'tests.run': return this.run(message);
      case 'tests.cancel': return this.options.testing.get(message.partId)?.stop.abort();
      case 'tests.describe': return this.describe(message);
      case 'tests.describe.cancel': return this.describing.get(message.requestId)?.stop.abort();
      case 'tests.harness': return this.harness(message);
    }
  }
  private harness(message: HarnessMessage): Promise<void> | void {
    const { harness, stopped, emit } = this.options;
    if (!harness || stopped() || this.syncing.has(message.requestId)) return;
    const stop = new AbortController();
    const done = Promise.resolve().then(async () => {
      try { emit(await harness(message, stop.signal)); }
      finally { this.syncing.delete(message.requestId); }
    });
    this.syncing.set(message.requestId, { stop, done }); return done;
  }
  private run(message: TestRunMessage): Promise<void> | void {
    const { options } = this;
    if (options.stopped() || options.testing.has(message.partId) || options.unconfirmed.has(message.partId)) return;
    const stop = new AbortController(), done = Promise.resolve().then(() => options.run(message, stop.signal));
    options.testing.set(message.partId, { stop, done }); return done;
  }
  activeDescriptions(): ActiveTest[] { return [...this.describing.values(), ...this.syncing.values()]; }
  cancelDescriptions(): void { for (const request of this.activeDescriptions()) request.stop.abort(); }
  replay(): void { for (const { reply } of this.described.values()) this.options.emit(reply); }
  private mismatch(message: DescribeMessage): void {
    this.options.emit({ type: 'tests.described', requestId: message.requestId, commitSha: message.commitSha, result: { status: 'error', problem: { code: 'description_mismatch', detail: 'A description request ID was reused for another repository commit.' } } });
  }
  private describe(message: DescribeMessage): Promise<void> | void {
    const signature = describeSignature(message), previous = this.described.get(message.requestId), active = this.describing.get(message.requestId);
    if (previous) return this.replayCached(message, signature, previous);
    if (active) return active.signature === signature ? active.done : this.mismatch(message);
    if (this.options.stopped()) return;
    const stop = new AbortController(), done = Promise.resolve().then(() => this.discover(message, stop.signal));
    this.describing.set(message.requestId, { signature, stop, done }); return done;
  }
  private replayCached(message: DescribeMessage, signature: string, previous: { signature: string; reply: TestsDescribed }): void {
    if (previous.signature === signature) this.options.emit(previous.reply);
    else this.mismatch(message);
  }
  private async discover(message: DescribeMessage, signal: AbortSignal): Promise<void> {
    let executionSignal = signal, result: TestsDescribed['result'];
    try {
      if (this.options.capabilities.testEnvironmentVersion !== 1) fail('isolation_missing', 'Product tests require an isolated job user and a private preparation cache.');
      const described = await withCheckSlot(async granted => {
        executionSignal = granted;
        const context = { cacheRoot: join(this.options.dir, 'cache'), deadline: Date.now() + 60_000, signal: granted, runtimes: this.options.capabilities.testRuntimes, log: () => {} };
        return this.options.describe && message.baseCommit === undefined ? { description: await this.options.describe(message.repo, message.repositoryScope, message.commitSha, context) } : describeTestEnvironment(message.repo, message.repositoryScope, message.commitSha, context, undefined, message.baseCommit);
      }, { signal, label: 'Describe product test environment' });
      result = { status: 'ready', ...described };
    } catch (error) { result = { status: 'error', problem: descriptionProblem(error, executionSignal) }; }
    const reply: TestsDescribed = { type: 'tests.described', requestId: message.requestId, commitSha: message.commitSha, result };
    this.describing.delete(message.requestId);
    this.described.set(message.requestId, { signature: describeSignature(message), reply });
    if (this.described.size > 20) this.described.delete(this.described.keys().next().value!);
    this.options.emit(reply);
  }
}


type PreparationInputContext = CacheContext & { checkout: string; profile: string; completed: string[] };
function overlapsOutput(pattern: string, output: string): boolean {
  if (output === '.' || match(output, pattern) || pattern.startsWith(`${output}/`)) return true;
  const wildcard = pattern.search(/[?*[{]/);
  if (wildcard < 0) return output.startsWith(`${pattern}/`);
  const prefix = pattern.slice(0, wildcard), directory = prefix.slice(0, prefix.lastIndexOf('/'));
  return !directory || directory === output || directory.startsWith(`${output}/`) || output.startsWith(`${directory}/`);
}
type PreparationOutput = { unit: TestPrepare; index: number; root: string };
type PreparationReference = { pattern: string; root: string };
function referencesForPattern(outputs: PreparationOutput[], pattern: string, current: number, context: PreparationInputContext): PreparationReference[] {
  const owners = outputs.filter(output => overlapsOutput(pattern, output.root)), active = owners.filter(owner => owner.unit.profiles.includes(context.profile));
  if (owners.length && !active.length) fail('environment_invalid', 'A required preparation result is unavailable in this profile.');
  return active.map(owner => {
    if (owner.index >= current || !context.completed.includes(owner.unit.id)) fail('environment_invalid', 'A preparation input refers to itself or an unfinished preparation result.');
    return { pattern, root: owner.root };
  });
}
function preparationReferences(description: EnvironmentDescription, unitId: string, context: PreparationInputContext): PreparationReference[] {
  const units = description.manifest.prepare, current = units.findIndex(unit => unit.id === unitId);
  if (current < 0 || !units[current].profiles.includes(context.profile)) fail('environment_invalid', 'The preparation unit is not eligible for this profile.');
  const outputs = units.flatMap((unit, index) => unit.artifacts.flatMap(artifact => 'service' in artifact ? [] : [{ unit, index, root: artifact.path }]));
  return units[current].inputs.flatMap(pattern => referencesForPattern(outputs, pattern, current, context));
}
async function generatedFiles(path: string, context: PreparationInputContext): Promise<string[]> {
  checkCacheContext(context);
  const full = await safeCheckoutPath(context.checkout, path), stat = await lstat(full);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) fail('environment_invalid', 'Generated inputs must be regular files or directories.');
  const result: string[] = [];
  for (const name of (await readdir(full)).sort()) result.push(...await generatedFiles(`${path}/${name}`, context));
  return result;
}
export async function readPreparationInputs(description: EnvironmentDescription, unitId: string, context: PreparationInputContext): Promise<InputDigest[]> {
  const references = preparationReferences(description, unitId, context), unit = description.manifest.prepare.find(unit => unit.id === unitId)!;
  const inputs = new Map(selectedInputs(description, unit.inputs).map(input => [input.path, input.digest]));
  for (const reference of references) {
    const files = await preparationFiles(reference, context);
    inputs.delete(reference.pattern);
    for (const path of files) inputs.set(path, await preparationInputDigest(resolve(context.checkout, path), context));
  }
  return [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([path, digest]) => ({ path, digest }));
}

export type PreparationBuilder = {
  root: string; user: JobUser; env: Record<string, string>;
  run: (command: Command, env?: Record<string, string>) => Promise<void>;
  quiesce: () => Promise<void>; close: () => Promise<void>;
};
export type PreparationContext = DescriptionContext & {
  checkout: string; profile: string; attemptRoot: string; nodeOwner: JobUser; jobUser: JobUser;
  env: Record<string, string>; registerSecrets: (values: string[]) => void;
  builder: (inputs: InputDigest[], dependencies: CacheEntry | null, setup?: BuilderSetup) => Promise<PreparationBuilder>;
  run: (command: Command, env?: Record<string, string>) => Promise<void>; quiesce: () => Promise<void>;
  /* Where what this machine lacks comes from: another machine's build, through Hornhoof. None: it builds here. */
  share?: (unit: string, description: EnvironmentDescription) => CacheShare;
};
/* How a builder gets the dependencies: linked when they are shared read-only, and the variables and folders that name them. */
export type BuilderSetup = { link: boolean; env: Record<string, string>; bin: string[] };
export type PreparedDependencies = { entry: CacheEntry | null; receipt: { key: string | null; hit: boolean; fetched?: boolean } };
type PreparedUnit = { definitions: ServiceDefinitions; artifacts: ServiceArtifacts };
type PreparedEnvironment = { env: Record<string, string>; receipts: { unitId: string; key: string | null; hit: boolean; fetched?: boolean }[]; services: PreparedUnit[] };
/* What a run needs, by default. A machine getting ready ahead of a run keeps services for it, and starts none of them; a
   manual command gets no services at all. */
type PreparationScope = { serviceUnits?: boolean; freshServices?: boolean };
const SERVICE_PAYLOAD = '.hornhoof-services';
const builderSetup = (description: EnvironmentDescription): BuilderSetup => ({ link: description.manifest.dependencies.cache === 'link', env: description.manifest.dependencies.env ?? {}, bin: description.manifest.dependencies.bin ?? [] });
const withBin = (folders: string[], path: string | undefined): string => [...folders, path].filter(Boolean).join(':');
/* The variables of a harness whose folder is root, before there need be anything in it: for whatever is building it. */
export function setupEnv(setup: Pick<BuilderSetup, 'env' | 'bin'>, root: string, path: string | undefined): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(setup.env).map(([name, value]) => [name, join(root, value)])), ...(setup.bin.length ? { PATH: withBin(setup.bin.map(folder => join(root, folder)), path) } : {}) };
}
const fetchedField = (entry: CacheEntry) => (entry.fetched === undefined ? {} : { fetched: entry.fetched });
async function runPreparation(commands: Command[], builder: Pick<PreparationBuilder, 'run' | 'quiesce'>): Promise<void> {
  try { for (const command of commands) await builder.run(command); }
  finally { await builder.quiesce(); }
}
/* own: the checkout gets copies of its own, which its user may change, even of what runs share by read-only links. */
export async function prepareDependencies(description: EnvironmentDescription, context: PreparationContext, { own = false }: { own?: boolean } = {}): Promise<PreparedDependencies> {
  const dependencies = description.manifest.dependencies;
  if (dependencies.cache === 'none') {
    const env = setupEnv(builderSetup(description), context.checkout, context.env.PATH);
    await runPreparation(dependencies.install, { run: (command, extra = {}) => context.run(command, { ...env, ...extra }), quiesce: context.quiesce });
    return { entry: null, receipt: { key: null, hit: false } };
  }
  const key = dependencyCacheKey(description);
  let builder: PreparationBuilder | undefined;
  try {
    const entry = await prepareCache(join(context.cacheRoot, 'dependencies'), key, key, context, async () => {
      builder = await context.builder(selectedInputs(description, dependencies.inputs), null, builderSetup(description));
      await runPreparation(dependencies.install, builder);
      return { root: builder.root, paths: dependencies.paths };
    }, context.share?.('dependencies', description));
    await restoreCache(entry, context.checkout, context, { link: !own && dependencies.cache === 'link', owner: context.jobUser });
    return { entry, receipt: { key, hit: entry.hit, ...fetchedField(entry) } };
  } finally { await builder?.close(); }
}
function definitionsFor(description: EnvironmentDescription, unit: TestPrepare): ServiceDefinitions {
  const services = description.manifest.services.filter(service => unit.serviceIds.includes(service.id) && service.driver !== 'browser') as ServiceDefinition[];
  return { services, prepare: [{ id: unit.id, serviceIds: services.map(service => service.id), commands: unit.commands }] };
}
function serviceContext(context: PreparationContext, jobUser = context.jobUser, env = context.env): ServiceContext {
  return { nodeOwner: context.nodeOwner, jobUser, deadline: context.deadline, signal: context.signal, log: context.log, registerSecrets: context.registerSecrets, env };
}
async function servicePaths(unit: TestPrepare, artifacts: ServiceArtifacts): Promise<void> {
  for (const artifact of unit.artifacts) {
    if (!('service' in artifact)) continue;
    const root = artifacts.paths[artifact.service];
    if (!root) fail('environment_invalid', 'A requested service artifact was not produced.');
    await safeCheckoutPath(root, artifact.path);
  }
}
async function buildUnit(description: EnvironmentDescription, unit: TestPrepare, key: string, builder: PreparationBuilder, context: PreparationContext): Promise<string[]> {
  const definitions = definitionsFor(description, unit), paths = unit.artifacts.flatMap(artifact => 'service' in artifact ? [] : [artifact.path]);
  if (!definitions.services.length) { await runPreparation(unit.commands, builder); return paths; }
  const serviceRoot = await mkdtemp(join(await privateCacheRoot(context.cacheRoot), '.service-build-'));
  try {
    const artifacts = await prepareServiceArtifacts(definitions, builder.root, { ...serviceContext(context, builder.user, builder.env), cacheRoot: serviceRoot, envKey: key, inputDigest: key });
    await builder.quiesce(); await servicePaths(unit, artifacts);
    const destination = join(builder.root, SERVICE_PAYLOAD);
    if (paths.some(path => match(SERVICE_PAYLOAD, path) || match(path, SERVICE_PAYLOAD))) fail('environment_invalid', 'A file artifact overlaps the reserved service payload.');
    await rm(destination, { recursive: true, force: true });
    await cp(serviceRoot, destination, { recursive: true, dereference: false, errorOnExist: true });
    return [...paths, SERVICE_PAYLOAD];
  } finally { await builder.quiesce(); await rm(serviceRoot, { recursive: true, force: true }); }
}
async function cachedUnit(description: EnvironmentDescription, unit: TestPrepare, dependencies: PreparedDependencies, key: string, inputs: InputDigest[], context: PreparationContext): Promise<CacheEntry> {
  let builder: PreparationBuilder | undefined;
  try {
    const entry = await prepareCache(join(context.cacheRoot, 'environments'), key, key, context, async () => {
      builder = await context.builder([...new Map([...selectedInputs(description, description.manifest.dependencies.inputs), ...inputs].map(input => [input.path, input])).values()], dependencies.entry, builderSetup(description));
      return { root: builder.root, paths: await buildUnit(description, unit, key, builder, context) };
    }, context.share?.(unit.id, description));
    const shared = unit.artifacts.flatMap(artifact => ('link' in artifact && artifact.link ? [artifact.path] : []));
    await restoreCache(entry, context.checkout, context, { owner: context.jobUser, except: SERVICE_PAYLOAD, link: shared }); return entry;
  } finally { await builder?.close(); }
}
async function uncachedUnit(description: EnvironmentDescription, unit: TestPrepare, context: PreparationContext, env: Record<string, string>): Promise<PreparedUnit | null> {
  const definitions = definitionsFor(description, unit);
  if (!definitions.services.length) { await runPreparation(unit.commands, { run: (command, extra = {}) => context.run(command, { ...env, ...extra }), quiesce: context.quiesce }); return null; }
  const key = digest(randomUUID());
  const artifacts = await prepareServiceArtifacts(definitions, context.checkout, { ...serviceContext(context), cacheRoot: join(context.attemptRoot, 'service-templates', unit.id), envKey: key, inputDigest: key });
  await context.quiesce(); await servicePaths(unit, artifacts); return { definitions, artifacts };
}
function cachedServices(description: EnvironmentDescription, unit: TestPrepare, entry: CacheEntry): PreparedUnit | null {
  const definitions = definitionsFor(description, unit);
  if (!definitions.services.length) return null;
  const paths = Object.fromEntries(definitions.services.map(service => [service.id, join(entry.path, 'payload', SERVICE_PAYLOAD, entry.key, 'payload', service.id)]));
  return { definitions, artifacts: { paths, format: 'hornhoof-services-v1', inputDigest: entry.inputDigest } };
}
async function artifactEnvironment(unit: TestPrepare, checkout: string, env: Record<string, string>): Promise<void> {
  for (const artifact of unit.artifacts) {
    if ('service' in artifact) continue;
    const path = await safeCheckoutPath(checkout, artifact.path);
    if (artifact.env) addEnvironment(env, { [artifact.env]: path });
  }
}
function addEnvironment(target: Record<string, string>, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (Object.hasOwn(target, name) && target[name] !== value) fail('environment_invalid', `Two preparation units define conflicting ${name} values.`);
    target[name] = value;
  }
}
async function prepareUnit(description: EnvironmentDescription, unit: TestPrepare, dependencies: PreparedDependencies, prepared: PreparedEnvironment, completed: string[], context: PreparationContext): Promise<void> {
  const inputs = await readPreparationInputs(description, unit.id, { ...context, completed });
  if (dependencies.receipt.key === null) {
    const services = await uncachedUnit(description, unit, context, prepared.env);
    if (services) prepared.services.push(services);
    prepared.receipts.push({ unitId: unit.id, key: null, hit: false });
  } else {
    const key = environmentCacheKey(description, unit.id, dependencies.receipt.key, inputs), entry = await cachedUnit(description, unit, dependencies, key, inputs, context);
    const services = cachedServices(description, unit, entry);
    if (services) prepared.services.push(services);
    prepared.receipts.push({ unitId: unit.id, key, hit: entry.hit, ...fetchedField(entry) });
  }
  await artifactEnvironment(unit, context.checkout, prepared.env); completed.push(unit.id);
}
async function dependencyPaths(description: EnvironmentDescription, context: Pick<PreparationContext, 'checkout' | 'env'>, env: Record<string, string>): Promise<void> {
  const { env: named = {}, bin = [] } = description.manifest.dependencies;
  for (const [name, path] of Object.entries(named)) addEnvironment(env, { [name]: await safeCheckoutPath(context.checkout, path) });
  if (bin.length) addEnvironment(env, { PATH: withBin(await Promise.all(bin.map(folder => safeCheckoutPath(context.checkout, folder))), context.env.PATH) });
}
export async function prepareEnvironment(description: EnvironmentDescription, dependencies: PreparedDependencies, context: PreparationContext, { serviceUnits = true, freshServices = true }: PreparationScope = {}): Promise<PreparedEnvironment> {
  const prepared: PreparedEnvironment = { env: {}, receipts: [], services: [] }, completed: string[] = [];
  await dependencyPaths(description, context, prepared.env);
  for (const unit of description.manifest.prepare.filter(unit => unit.profiles.includes(context.profile) && (serviceUnits || !unit.serviceIds.length))) await prepareUnit(description, unit, dependencies, prepared, completed, context);
  if (freshServices) await freshServiceArtifacts(description, prepared, context);
  return prepared;
}
export async function openEnvironment(prepared: PreparedEnvironment, context: PreparationContext): Promise<OpenedServices> {
  const opened: OpenedServices[] = [], env = { ...prepared.env };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { const results = await Promise.allSettled(opened.map(service => service.close())); for (const result of results) if (result.status === 'rejected') throw result.reason; })();
  try {
    await mkdir(join(context.attemptRoot, 'services'), { recursive: true, mode: 0o755 });
    for (const [index, service] of prepared.services.entries()) {
      const current = await openServices(service.definitions, service.artifacts, { ...serviceContext(context), checkout: context.checkout, attemptRoot: join(context.attemptRoot, 'services', String(index)) });
      opened.push(current); addEnvironment(env, current.env);
    }
    return { env, close };
  } catch (error) { await close(); throw error; }
}

async function freshServiceArtifacts(description: EnvironmentDescription, prepared: PreparedEnvironment, context: PreparationContext): Promise<void> {
  const covered = new Set(prepared.services.flatMap(item => item.definitions.services.map(service => service.id)));
  const fresh = description.manifest.services.filter(service => service.driver !== 'browser' && service.profiles.includes(context.profile) && !covered.has(service.id)) as ServiceDefinition[];
  for (const service of fresh) {
    const definitions = { services: [service] }, key = digest(randomUUID());
    const artifacts = await prepareServiceArtifacts(definitions, context.checkout, { ...serviceContext(context), cacheRoot: join(context.attemptRoot, 'fresh-services', service.id), envKey: key, inputDigest: key });
    await context.quiesce(); prepared.services.push({ definitions, artifacts });
  }
}

async function preparationFiles(reference: PreparationReference, context: PreparationInputContext): Promise<string[]> {
  let files: string[];
  try { files = (await generatedFiles(reference.root, context)).filter(path => match(path, reference.pattern)); }
  catch (error) { checkCacheContext(context); if (error instanceof EnvironmentFailure) throw error; return fail('environment_invalid', `A required preparation result is missing: ${reference.root}.`); }
  if (!files.length) fail('environment_invalid', `A required preparation input is empty: ${reference.pattern}.`);
  return files;
}

/* A node's parts share one disposable UID. Its cleanup must finish before the next part uses it,
   even if the machine coordinator has spare CPU slots. This resource guard runs inside that slot. */
export class TestPartUser {
  private readonly user = new CheckSlotQueue(() => 1);
  run<T>(signal: AbortSignal | undefined, run: () => Promise<T>, waiting: (position: number) => void): Promise<T> {
    return this.user.withSlot(run, { signal, onPosition: waiting });
  }
}
