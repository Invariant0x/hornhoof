import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join, matchesGlob, relative, resolve } from 'node:path';
import { CheckSlotQueue, hashTestEnvironment, parseTestEnvironment, validateEnvironmentDescription, TEST_ENVIRONMENT_BYTES, RepositoryPath, type Command, type TestSuite, type TestPrepare, type NodeMessage, type ServerMessage, type TestsDescribed, type EnvironmentDescription, type EnvironmentProblem, type InputDigest, type RepositoryScope, type RuntimeCapability, type TestEnvironmentV1, type TestUnit } from '@hornhoof/protocol';
import { cacheKey, checkCacheContext, fileDigest, prepareCache, restoreCache, privateCacheRoot, type CacheEntry, type CacheContext } from './test-cache.js';
import { withCheckSlot } from './check-queue.js';
import { prepareServiceArtifacts, openServices, type OpenedServices, type ServiceArtifacts, type ServiceContext, type ServiceDefinition, type ServiceDefinitions } from './test-services.js';
import type { JobUser } from './isolation.js';
import { readCommit, type CommitTree, type GitEntry } from './test-mirror.js';

type Source = Parameters<typeof readCommit>[0];
type DescriptionContext = CacheContext & { runtimes?: RuntimeCapability[] };
const MANIFEST = '.hornhoof/test-environment.json';
const LFS = 'version https://git-lfs.github.com/spec/v1\n';
export class EnvironmentFailure extends Error {
  constructor(readonly problem: EnvironmentProblem) { super(problem.detail); }
}
function fail(code: EnvironmentProblem['code'], detail: string): never { throw new EnvironmentFailure({ code, detail }); }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function match(path: string, pattern: string): boolean {
  return path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`) || matchesGlob(path, pattern);
}
function regular(entry: GitEntry): void {
  if (!['100644', '100755'].includes(entry.mode)) fail('environment_unsupported', `A declared input is not a regular tracked file: ${entry.path}.`);
}
async function blob(tree: CommitTree, path: string, limit: number): Promise<Buffer> {
  const entry = tree.entries.find(item => item.path === path);
  if (!entry) fail('environment_invalid', `A declared file is missing: ${path}.`);
  regular(entry);
  const bytes = await tree.readBlob(path, limit);
  if (bytes.subarray(0, LFS.length).toString('ascii') === LFS) fail('environment_unsupported', `Git LFS materialization is not described for ${path}.`);
  return bytes;
}
function inputPatterns(manifest: TestEnvironmentV1): string[] {
  return [...new Set([...manifest.dependencies.inputs, ...manifest.prepare.flatMap(unit => unit.inputs), ...(manifest.reset ?? []).flatMap(reset => reset.inputs)])].sort();
}
async function inputDigests(tree: CommitTree, manifest: TestEnvironmentV1): Promise<InputDigest[]> {
  const inputs = new Map<string, string | null>();
  for (const pattern of inputPatterns(manifest)) {
    const entries = tree.entries.filter(entry => match(entry.path, pattern));
    if (!entries.length) inputs.set(pattern, null);
    for (const entry of entries) inputs.set(entry.path, digest(await blob(tree, entry.path, 16 * 1024 * 1024)));
  }
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
export async function readTestEnvironment(source: Source, repositoryScope: RepositoryScope, commitSha: string, context: DescriptionContext): Promise<EnvironmentDescription> {
  const tree = await readCommit(source, repositoryScope, commitSha, context);
  if (!tree.entries.some(entry => entry.path === MANIFEST)) fail('environment_missing', 'No test environment exists at the pinned commit.');
  const bytes = await blob(tree, MANIFEST, TEST_ENVIRONMENT_BYTES), manifest = manifestFrom(bytes);
  fixtureInputs(tree, manifest);
  return validateEnvironmentDescription({ version: 1, repositoryScope, commitSha, manifestSource: bytes.toString('utf8'), manifestHash: await hashTestEnvironment(bytes), manifest, inputDigests: await inputDigests(tree, manifest), inventory: listTestUnits(manifest, tree.entries), runtimeCapabilities: context.runtimes ?? await trustedTestRuntimes(context) });
}

async function runtimeOutput(program: string, args: string[], context: CacheContext): Promise<string | null> {
  checkCacheContext(context);
  return new Promise(resolve => execFile(program, args, { cwd: context.cacheRoot, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: context.cacheRoot }, timeout: Math.max(1, Math.min(2000, context.deadline - Date.now())), signal: context.signal, maxBuffer: 16 * 1024 }, (error, stdout) => resolve(error ? null : stdout.trim())));
}
function capability(id: string, version: string, build: unknown): RuntimeCapability {
  const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  return { id, version, fingerprint: digest(JSON.stringify({ platform: process.platform, arch: process.arch, libc: header.glibcVersionRuntime ?? 'unknown', build })) };
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
export async function buildTestInvocation(suite: TestSuite, files: string[], context: { checkout: string; filesPath: string }): Promise<{ command: Command; env: Record<string, string> }> {
  if (!files.length) fail('environment_invalid', 'A suite needs a nonempty file inventory.');
  await safeCheckoutPath(context.checkout, suite.run.cwd);
  for (const file of files) {
    await safeCheckoutPath(context.checkout, file);
    if (!(await lstat(resolve(context.checkout, file))).isFile() || !suite.files.some(pattern => match(file, pattern))) fail('environment_invalid', 'A selection is not a regular file of the suite.');
  }
  if (suite.split.kind === 'whole-package') return { command: suite.run, env: {} };
  const paths = files.map(file => `./${relative(resolve(context.checkout, suite.run.cwd), resolve(context.checkout, file))}`);
  if (suite.split.kind === 'argv-files') return { command: { ...suite.run, args: [...suite.run.args, ...paths] }, env: {} };
  const output = await open(context.filesPath, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(paths)); } finally { await output.close(); }
  return { command: suite.run, env: { HH_TEST_FILES: context.filesPath } };
}


function selectedInputs(description: EnvironmentDescription, patterns: string[]): InputDigest[] {
  return description.inputDigests.filter(input => patterns.some(pattern => match(input.path, pattern)));
}
function commandRuntime(command: Command): string[] {
  const program = basename(command.program);
  if (['node', 'npm', 'npx', 'pnpm', 'yarn'].includes(program)) return ['node'];
  return /^python(?:[23](?:\.\d+)?)?$/.test(program) ? ['python'] : [];
}
function commandRuntimes(description: EnvironmentDescription, commands: Command[]): string[] {
  const serviceRuntimes = new Set(description.manifest.services.map(service => service.runtime));
  return [...new Set([...description.manifest.runtimes.filter(runtime => !serviceRuntimes.has(runtime.id)).map(runtime => runtime.id), ...commands.flatMap(commandRuntime)])];
}
function runtimeFingerprint(description: EnvironmentDescription, ids: string[]): string {
  const fingerprints = [...new Set(ids)].sort().map(id => {
    const actual = description.runtimeCapabilities.find(runtime => runtime.id === id);
    if (!actual) fail('runtime_missing', `The node lacks the ${id} runtime.`);
    return { id, fingerprint: actual.fingerprint };
  });
  return digest(JSON.stringify(fingerprints));
}
export function dependencyCacheKey(description: EnvironmentDescription): string {
  const { dependencies } = description.manifest;
  return cacheKey({ runtime: runtimeFingerprint(description, commandRuntimes(description, dependencies.install)), settings: { format: 'hornhoof-dependencies-v1', repositoryScope: description.repositoryScope, adapter: dependencies.adapter, install: dependencies.install, paths: [...dependencies.paths].sort(), cache: dependencies.cache }, inputs: selectedInputs(description, dependencies.inputs) });
}
export function environmentCacheKey(description: EnvironmentDescription, unitId: string, dependencyKey: string, preparedInputs?: InputDigest[]): string {
  const unit = description.manifest.prepare.find(unit => unit.id === unitId);
  if (!unit) fail('environment_invalid', 'The preparation unit does not exist in the pinned manifest.');
  const services = description.manifest.services.filter(service => unit.serviceIds.includes(service.id));
  const runtimes = [...commandRuntimes(description, unit.commands), ...services.map(service => service.runtime)];
  const settings = { format: 'hornhoof-environment-v1', repositoryScope: description.repositoryScope, unitId, dependencyKey, commands: unit.commands, artifacts: unit.artifacts, reset: description.manifest.reset, services: services.map(({ id, driver, runtime, options }) => ({ id, driver, runtime, options })) };
  return cacheKey({ runtime: runtimeFingerprint(description, runtimes), settings, inputs: preparedInputs ?? selectedInputs(description, unit.inputs) });
}


export type TestCapabilities = { testEnvironmentVersion?: 1; testRuntimes?: RuntimeCapability[] };
export async function nodeTestCapabilities(dir: string, user: JobUser | null): Promise<TestCapabilities> {
  if (!user || user.uid === 0 || user.uid === process.getuid?.()) return {};
  const cacheRoot = await privateCacheRoot(join(dir, 'cache'));
  return { testEnvironmentVersion: 1, testRuntimes: await trustedTestRuntimes({ cacheRoot, signal: new AbortController().signal, deadline: Date.now() + 10_000, log: () => {} }) };
}
type TestRunMessage = Extract<ServerMessage, { type: 'tests.run' }>;
type DescribeMessage = Extract<ServerMessage, { type: 'tests.describe' }>;
type TestMessage = Extract<ServerMessage, { type: 'tests.run' | 'tests.cancel' | 'tests.describe' | 'tests.describe.cancel' }>;
type ActiveTest = { stop: AbortController; done: Promise<void> };
export function isNodeTestMessage(message: { type: string }): message is TestMessage {
  return ['tests.run', 'tests.cancel', 'tests.describe', 'tests.describe.cancel'].includes(message.type);
}
type TestMessageOptions = {
  dir: string; describe?: typeof readTestEnvironment; capabilities: TestCapabilities; stopped: () => boolean;
  testing: Map<string, ActiveTest>; unconfirmed: Map<string, NodeMessage>;
  run: (message: TestRunMessage, signal: AbortSignal) => Promise<void>;
  emit: (message: NodeMessage) => void;
};
function describeSignature(message: DescribeMessage): string {
  return digest(JSON.stringify({ scope: message.repositoryScope, url: message.repo.url, sha: message.commitSha }));
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
  constructor(private readonly options: TestMessageOptions) {}
  handle(message: TestMessage): Promise<void> | void {
    switch (message.type) {
      case 'tests.run': return this.run(message);
      case 'tests.cancel': return this.options.testing.get(message.partId)?.stop.abort();
      case 'tests.describe': return this.describe(message);
      case 'tests.describe.cancel': return this.describing.get(message.requestId)?.stop.abort();
    }
  }
  private run(message: TestRunMessage): Promise<void> | void {
    const { options } = this;
    if (options.stopped() || options.testing.has(message.partId) || options.unconfirmed.has(message.partId)) return;
    const stop = new AbortController(), done = Promise.resolve().then(() => options.run(message, stop.signal));
    options.testing.set(message.partId, { stop, done }); return done;
  }
  activeDescriptions(): ActiveTest[] { return [...this.describing.values()]; }
  cancelDescriptions(): void { for (const request of this.describing.values()) request.stop.abort(); }
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
      const description = await withCheckSlot(async granted => {
        executionSignal = granted;
        return (this.options.describe ?? readTestEnvironment)(message.repo, message.repositoryScope, message.commitSha, { cacheRoot: join(this.options.dir, 'cache'), deadline: Date.now() + 60_000, signal: granted, runtimes: this.options.capabilities.testRuntimes, log: () => {} });
      }, { signal, label: 'Describe product test environment' });
      result = { status: 'ready', description };
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
    for (const path of files) inputs.set(path, await fileDigest(resolve(context.checkout, path), context));
  }
  return [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([path, digest]) => ({ path, digest }));
}

export type PreparationBuilder = {
  root: string; user: JobUser; env: Record<string, string>;
  run: (command: Command, env?: Record<string, string>) => Promise<void>;
  quiesce: () => Promise<void>; close: () => Promise<void>;
};
export type PreparationContext = CacheContext & {
  checkout: string; profile: string; attemptRoot: string; nodeOwner: JobUser; jobUser: JobUser;
  env: Record<string, string>; registerSecrets: (values: string[]) => void;
  builder: (inputs: InputDigest[], dependencies: CacheEntry | null) => Promise<PreparationBuilder>;
  run: (command: Command, env?: Record<string, string>) => Promise<void>; quiesce: () => Promise<void>;
};
export type PreparedDependencies = { entry: CacheEntry | null; receipt: { key: string | null; hit: boolean } };
type PreparedUnit = { definitions: ServiceDefinitions; artifacts: ServiceArtifacts };
export type PreparedEnvironment = { env: Record<string, string>; receipts: { unitId: string; key: string | null; hit: boolean }[]; services: PreparedUnit[] };
const SERVICE_PAYLOAD = '.hornhoof-services';
async function runPreparation(commands: Command[], builder: Pick<PreparationBuilder, 'run' | 'quiesce'>): Promise<void> {
  try { for (const command of commands) await builder.run(command); }
  finally { await builder.quiesce(); }
}
export async function prepareDependencies(description: EnvironmentDescription, context: PreparationContext): Promise<PreparedDependencies> {
  const dependencies = description.manifest.dependencies;
  if (dependencies.cache === 'none') { await runPreparation(dependencies.install, context); return { entry: null, receipt: { key: null, hit: false } }; }
  const key = dependencyCacheKey(description);
  let builder: PreparationBuilder | undefined;
  try {
    const entry = await prepareCache(join(context.cacheRoot, 'dependencies'), key, key, context, async () => {
      builder = await context.builder(selectedInputs(description, dependencies.inputs), null);
      await runPreparation(dependencies.install, builder);
      return { root: builder.root, paths: dependencies.paths };
    });
    await restoreCache(entry, context.checkout, context);
    return { entry, receipt: { key, hit: entry.hit } };
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
      builder = await context.builder([...new Map([...selectedInputs(description, description.manifest.dependencies.inputs), ...inputs].map(input => [input.path, input])).values()], dependencies.entry);
      return { root: builder.root, paths: await buildUnit(description, unit, key, builder, context) };
    });
    await restoreCache(entry, context.checkout, context); return entry;
  } finally { await builder?.close(); }
}
async function uncachedUnit(description: EnvironmentDescription, unit: TestPrepare, context: PreparationContext): Promise<PreparedUnit | null> {
  const definitions = definitionsFor(description, unit);
  if (!definitions.services.length) { await runPreparation(unit.commands, context); return null; }
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
    const services = await uncachedUnit(description, unit, context);
    if (services) prepared.services.push(services);
    prepared.receipts.push({ unitId: unit.id, key: null, hit: false });
  } else {
    const key = environmentCacheKey(description, unit.id, dependencies.receipt.key, inputs), entry = await cachedUnit(description, unit, dependencies, key, inputs, context);
    const services = cachedServices(description, unit, entry);
    if (services) prepared.services.push(services);
    prepared.receipts.push({ unitId: unit.id, key, hit: entry.hit });
  }
  await artifactEnvironment(unit, context.checkout, prepared.env); completed.push(unit.id);
}
export async function prepareEnvironment(description: EnvironmentDescription, dependencies: PreparedDependencies, context: PreparationContext): Promise<PreparedEnvironment> {
  const prepared: PreparedEnvironment = { env: {}, receipts: [], services: [] }, completed: string[] = [];
  for (const unit of description.manifest.prepare.filter(unit => unit.profiles.includes(context.profile))) await prepareUnit(description, unit, dependencies, prepared, completed, context);
  await freshServiceArtifacts(description, prepared, context);
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
