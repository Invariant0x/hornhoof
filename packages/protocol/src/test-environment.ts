import { z } from 'zod';

export const RepositoryPath = z.string().min(1).max(4096)
  .refine(path => !/^(?:\/|[a-z]:)|[\\\0]|(?:^|\/)\.\.(?:\/|$)/i.test(path), 'Use a path within the repository.');
const Argument = z.string().max(100_000).refine(value => !value.includes('\0'));

export const Command = z.strictObject({
  program: Argument.min(1),
  args: z.array(Argument).max(1000),
  cwd: RepositoryPath,
});
export type Command = z.infer<typeof Command>;

export const EnvironmentDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const RepositoryScope = z.strictObject({
  companyId: z.uuid(),
  repositoryOwnerId: z.uuid(),
  repoUrlHash: EnvironmentDigest,
});
export type RepositoryScope = z.infer<typeof RepositoryScope>;

const Id = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const Text = Argument.min(1).refine(value => value.trim().length > 0);
const Ids = z.array(Id).max(1000).refine(values => new Set(values).size === values.length, 'Identifiers must be distinct.');
const Inputs = z.array(RepositoryPath).max(10_000);
const ProfileIds = Ids.min(1);
const ServiceId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const ServiceBase = { id: ServiceId, runtime: Id, profiles: ProfileIds };

export const TestService = z.discriminatedUnion('driver', [
  z.strictObject({ ...ServiceBase, driver: z.literal('postgres'), options: z.strictObject({ database: Text.max(63), locale: Text.optional(), extensions: z.array(Text).max(128).optional() }) }),
  z.strictObject({ ...ServiceBase, driver: z.literal('browser'), options: z.strictObject({}) }),
  z.strictObject({ ...ServiceBase, driver: z.literal('process'), options: z.strictObject({ start: Command, readiness: Command, stop: z.strictObject({ signal: z.enum(['SIGTERM', 'SIGINT']), graceMs: z.number().int().min(1).max(30_000) }), statePaths: Inputs }) }),
]);
export type TestService = z.infer<typeof TestService>;

export const TestArtifact = z.union([
  /* link: every part shares it read-only through hard links, for what nothing writes into; else each part gets its own copy. */
  z.strictObject({ path: RepositoryPath, format: Text, env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), link: z.literal(true).optional() }),
  z.strictObject({ service: Id, path: RepositoryPath }),
]);
export type TestArtifact = z.infer<typeof TestArtifact>;
export const TestPrepare = z.strictObject({ id: Id, profiles: ProfileIds, serviceIds: Ids, inputs: Inputs, commands: z.array(Command).max(1000), artifacts: z.array(TestArtifact).max(1000) });
export type TestPrepare = z.infer<typeof TestPrepare>;

export const TestReset = z.strictObject({ suiteIds: Ids.min(1), scope: z.enum(['test', 'file', 'part']), command: Command.nullable(), inputs: Inputs })
  .refine(reset => reset.command !== null || reset.inputs.length > 0, { path: ['inputs'], message: 'A fixture reset needs its fixture path in inputs.' });
export type TestReset = z.infer<typeof TestReset>;
export const TestSplit = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('argv-files') }),
  z.strictObject({ kind: z.literal('json-file') }),
  z.strictObject({ kind: z.literal('vitest-shard') }),
  z.strictObject({ kind: z.literal('whole-package') }),
]);
/* scenarioSources: the code a suite drives without importing it, as browser scenarios drive screens. keep: what its runs leave for its next run. */
export const TestSuite = z.strictObject({ id: Id, root: RepositoryPath, files: Inputs.min(1), run: Command, split: TestSplit, profiles: ProfileIds, finalChecks: z.array(Command).max(1000).optional(), scenarioSources: RepositoryPath.optional(), keep: z.array(RepositoryPath).max(16).optional() });
export type TestSuite = z.infer<typeof TestSuite>;

const MigrationCheck = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported'), up: Command, down: Command }),
  z.strictObject({ status: z.literal('unsupported'), reason: Text }),
]);
const CandidateMutationCommand = Command.refine(command => ['{baseCommit}', '{commit}', '{planFile}'].every(token => command.args.filter(arg => arg === token).length === 1), 'A narrow mutation command needs the exact base, head and plan file arguments.');
export const TestMutation = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported'), language: Id, tool: Id, command: Command, candidateRun: CandidateMutationCommand.optional(), sourcePaths: Inputs.min(1), fastTestPaths: Inputs.min(1), coverageCommands: z.array(Command).min(1).max(1000), coverageFiles: Inputs.min(1) }),
  z.strictObject({ status: z.literal('unsupported'), language: Id, reason: Text }),
]);
const OncePreparation = z.strictObject({ profiles: ProfileIds, suiteIds: Ids, commands: z.array(Command).max(1000) })
  .refine(value => value.suiteIds.length + value.commands.length > 0, 'An explicit preparation must contain work.');
/* The profile every release runs: profile runs every suite of the profile it replaces, and more. The first run of a release
   runs it whole; a later run of that release runs only what failed or changed. everyTurns is what a server or node before
   0.24.0 requires, so a repository keeps it for them: it is read and nothing runs by it. */
const FullRun = z.strictObject({ everyTurns: z.number().int().min(1).max(1000).optional(), replaces: Id, profile: Id });
const ExecutionPolicy = z.strictObject({ version: z.literal(2), oncePreparation: OncePreparation.optional(), fullRun: FullRun.optional() });
/* Who reads a file the import graph cannot follow: the named suites whole, or with tests only those of their test files. */
const ImpactRule = z.strictObject({ globs: Inputs.min(1), suiteIds: Ids.min(1), tests: Inputs.min(1).optional() });
const EnvironmentShape = z.strictObject({
  version: z.literal(1), defaultProfile: Id,
  runtimes: z.array(z.strictObject({ id: Id, version: Text.max(100) })).max(64),
  profiles: z.array(z.strictObject({ id: Id, requiredSuiteIds: Ids.min(1) })).min(1).max(128),
  /* cache link: every part shares one read-only tree through hard links, which is for dependencies nothing writes into;
     copy: each part gets its own; none: each part installs. env: variables that name a path of the repository once it is
     installed, for a language that finds its packages that way. bin: folders of the repository that go first on PATH then,
     for a language whose tools come with its harness. Both hold while it installs, in what is prepared, and in every command. */
  dependencies: z.strictObject({ adapter: Id, inputs: Inputs, install: z.array(Command).max(1000), paths: Inputs, cache: z.enum(['copy', 'link', 'none']), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), RepositoryPath).optional(), bin: z.array(RepositoryPath).max(64).optional() }),
  services: z.array(TestService).max(128), prepare: z.array(TestPrepare).max(1000),
  reset: z.array(TestReset).min(1).max(1000).nullable(), suites: z.array(TestSuite).min(1).max(1000),
  impact: z.strictObject({ adapter: Id, fullPackageGlobs: z.array(ImpactRule).max(1000), migrationCheck: MigrationCheck }),
  mutation: TestMutation,
  execution: ExecutionPolicy.optional(),
});
type EnvironmentShape = z.infer<typeof EnvironmentShape>;
type IssuePath = (string | number)[];

function reference(value: string, allowed: ReadonlySet<string>, path: IssuePath, ctx: z.RefinementCtx): void {
  if (!allowed.has(value)) ctx.addIssue({ code: 'custom', path, message: `Unknown identifier: ${value}.` });
}
function references(values: string[], allowed: ReadonlySet<string>, path: IssuePath, ctx: z.RefinementCtx): void {
  values.forEach((value, index) => reference(value, allowed, [...path, index], ctx));
}
function identities(values: { id: string }[], path: string, ctx: z.RefinementCtx): Set<string> {
  const found = new Set<string>();
  values.forEach((value, index) => {
    if (found.has(value.id)) ctx.addIssue({ code: 'custom', path: [path, index, 'id'], message: `Duplicate identifier: ${value.id}.` });
    found.add(value.id);
  });
  return found;
}
function requiredSuites(env: EnvironmentShape, suites: ReadonlySet<string>, ctx: z.RefinementCtx): void {
  env.profiles.forEach((profile, index) => {
    references(profile.requiredSuiteIds, suites, ['profiles', index, 'requiredSuiteIds'], ctx);
    for (const id of profile.requiredSuiteIds) {
      const suite = env.suites.find(value => value.id === id);
      if (suite && !suite.profiles.includes(profile.id)) ctx.addIssue({ code: 'custom', path: ['profiles', index, 'requiredSuiteIds'], message: `Suite ${id} is not eligible for profile ${profile.id}.` });
    }
  });
}
function serviceProfiles(env: EnvironmentShape, profiles: ReadonlySet<string>, ctx: z.RefinementCtx): void {
  const runtimes = identities(env.runtimes, 'runtimes', ctx);
  env.services.forEach((service, index) => {
    references(service.profiles, profiles, ['services', index, 'profiles'], ctx);
    reference(service.runtime, runtimes, ['services', index, 'runtime'], ctx);
  });
}
function preparationArtifacts(unit: TestPrepare, path: IssuePath, ctx: z.RefinementCtx): void {
  unit.artifacts.forEach((artifact, index) => {
    if ('service' in artifact) reference(artifact.service, new Set(unit.serviceIds), [...path, 'artifacts', index, 'service'], ctx);
  });
}
function preparationProfiles(unit: TestPrepare, env: EnvironmentShape, path: IssuePath, ctx: z.RefinementCtx): void {
  for (const id of unit.serviceIds) {
    const service = env.services.find(value => value.id === id);
    if (service) references(unit.profiles, new Set(service.profiles), [...path, 'profiles'], ctx);
  }
}
function preparations(env: EnvironmentShape, profiles: ReadonlySet<string>, services: ReadonlySet<string>, ctx: z.RefinementCtx): void {
  identities(env.prepare, 'prepare', ctx);
  env.prepare.forEach((unit, index) => {
    const path = ['prepare', index];
    references(unit.profiles, profiles, [...path, 'profiles'], ctx);
    references(unit.serviceIds, services, [...path, 'serviceIds'], ctx);
    preparationArtifacts(unit, path, ctx); preparationProfiles(unit, env, path, ctx);
  });
}
function suiteReferences(env: EnvironmentShape, suites: ReadonlySet<string>, profiles: ReadonlySet<string>, ctx: z.RefinementCtx): void {
  env.suites.forEach((suite, index) => references(suite.profiles, profiles, ['suites', index, 'profiles'], ctx));
  env.reset?.forEach((reset, index) => references(reset.suiteIds, suites, ['reset', index, 'suiteIds'], ctx));
  env.impact.fullPackageGlobs.forEach((entry, index) => references(entry.suiteIds, suites, ['impact', 'fullPackageGlobs', index, 'suiteIds'], ctx));
}
function oncePreparationReferences(env: EnvironmentShape, profiles: ReadonlySet<string>, ctx: z.RefinementCtx): void {
  const preparation = env.execution?.oncePreparation;
  if (!preparation) return;
  const path = ['execution', 'oncePreparation'];
  references(preparation.profiles, profiles, [...path, 'profiles'], ctx);
  for (const profile of env.profiles.filter(value => preparation.profiles.includes(value.id))) {
    references(preparation.suiteIds, new Set(profile.requiredSuiteIds), [...path, 'suiteIds'], ctx);
  }
}
function fullRunReferences(env: EnvironmentShape, ctx: z.RefinementCtx): void {
  const full = env.execution?.fullRun;
  if (!full) return;
  const path = ['execution', 'fullRun'], requiredOf = (id: string) => env.profiles.find(profile => profile.id === id)?.requiredSuiteIds;
  const whole = requiredOf(full.profile), replaced = requiredOf(full.replaces);
  if (!whole || !replaced || full.profile === full.replaces) { ctx.addIssue({ code: 'custom', path, message: 'A full run names two known profiles.' }); return; }
  if (replaced.some(id => !whole.includes(id))) ctx.addIssue({ code: 'custom', path, message: 'A full run covers every suite of the profile it replaces.' });
}
function environmentReferences(env: EnvironmentShape, ctx: z.RefinementCtx): void {
  const profiles = identities(env.profiles, 'profiles', ctx), suites = identities(env.suites, 'suites', ctx), services = identities(env.services, 'services', ctx);
  reference(env.defaultProfile, profiles, ['defaultProfile'], ctx);
  requiredSuites(env, suites, ctx); serviceProfiles(env, profiles, ctx);
  preparations(env, profiles, services, ctx); suiteReferences(env, suites, profiles, ctx);
  oncePreparationReferences(env, profiles, ctx); fullRunReferences(env, ctx);
}

export const TEST_ENVIRONMENT_BYTES = 64 * 1024;
const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;
function environmentSize(env: EnvironmentShape, ctx: z.RefinementCtx): void {
  if (byteLength(JSON.stringify(env)) > TEST_ENVIRONMENT_BYTES) ctx.addIssue({ code: 'custom', message: 'The test environment exceeds 64KiB.' });
}
export const TestEnvironmentV1 = EnvironmentShape.superRefine(environmentReferences).superRefine(environmentSize);
export type TestEnvironmentV1 = z.infer<typeof TestEnvironmentV1>;

export function parseTestEnvironment(value: unknown): TestEnvironmentV1 {
  if (typeof value !== 'string') return TestEnvironmentV1.parse(value);
  if (byteLength(value) > TEST_ENVIRONMENT_BYTES) throw new RangeError('The test environment exceeds 64KiB.');
  return TestEnvironmentV1.parse(JSON.parse(value));
}

export async function hashTestEnvironment(source: string | Uint8Array): Promise<string> {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : Uint8Array.from(source);
  if (bytes.byteLength > TEST_ENVIRONMENT_BYTES) throw new RangeError('The test environment exceeds 64KiB.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/* The system a runtime runs on, as its node reads it: process.platform, process.arch and its libc family. */
const PlatformWord = z.string().regex(/^[a-z0-9_]+$/).max(40);
export const RuntimePlatform = z.strictObject({ os: PlatformWord, arch: PlatformWord, libc: PlatformWord });
export const RuntimeCapability = z.strictObject({ id: Id, version: Text.max(200), fingerprint: EnvironmentDigest, platform: RuntimePlatform.optional() });
export type RuntimeCapability = z.infer<typeof RuntimeCapability>;
export const ProductCommitSha = z.string().regex(/^[a-f0-9]{40}$/);
export const TestUnit = z.strictObject({ suiteId: Id, file: RepositoryPath, selectionUnit: RepositoryPath });
export type TestUnit = z.infer<typeof TestUnit>;
export const InputDigest = z.strictObject({ path: RepositoryPath, digest: EnvironmentDigest.nullable() });
export type InputDigest = z.infer<typeof InputDigest>;
export const TEST_DESCRIPTION_BYTES = 3 * 1024 * 1024;
const DescriptionShape = z.strictObject({
  version: z.literal(1), repositoryScope: RepositoryScope, commitSha: ProductCommitSha,
  manifestSource: z.string().min(1).refine(source => byteLength(source) <= TEST_ENVIRONMENT_BYTES),
  manifestHash: EnvironmentDigest, manifest: TestEnvironmentV1,
  inputDigests: z.array(InputDigest).max(10_000), inventory: z.array(TestUnit).max(10_000),
  runtimeCapabilities: z.array(RuntimeCapability).max(64),
});
type DescriptionShape = z.infer<typeof DescriptionShape>;
function distinct(values: string[], path: string, ctx: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path: [path], message: 'Evidence entries must be distinct.' });
}
function descriptionSource(value: DescriptionShape, ctx: z.RefinementCtx): void {
  try {
    const parsed = TestEnvironmentV1.safeParse(JSON.parse(value.manifestSource));
    if (parsed.success && JSON.stringify(parsed.data) === JSON.stringify(value.manifest)) return;
  } catch { /* The original bytes must be valid JSON as well as valid manifest data. */ }
  ctx.addIssue({ code: 'custom', path: ['manifest'], message: 'The snapshot differs from its original manifest bytes.' });
}
function descriptionEvidence(value: DescriptionShape, ctx: z.RefinementCtx): void {
  distinct(value.inputDigests.map(input => input.path), 'inputDigests', ctx);
  distinct(value.inventory.map(unit => `${unit.suiteId}:${unit.file}`), 'inventory', ctx);
  distinct(value.runtimeCapabilities.map(runtime => runtime.id), 'runtimeCapabilities', ctx);
  const suites = new Set(value.manifest.suites.map(suite => suite.id));
  value.inventory.forEach((unit, index) => reference(unit.suiteId, suites, ['inventory', index, 'suiteId'], ctx));
}
function descriptionSize(value: unknown, ctx: z.RefinementCtx): void {
  if (byteLength(JSON.stringify(value)) >= TEST_DESCRIPTION_BYTES) ctx.addIssue({ code: 'custom', message: 'The environment evidence exceeds its 3MiB limit.' });
}
function descriptionResponseSize(value: unknown, ctx: z.RefinementCtx): void {
  if (byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'The description response exceeds its 4MiB transport frame limit.' });
}
export const EnvironmentDescription = DescriptionShape.superRefine(descriptionSource).superRefine(descriptionEvidence).superRefine(descriptionSize);
export type EnvironmentDescription = z.infer<typeof EnvironmentDescription>;
export async function validateEnvironmentDescription(value: unknown): Promise<EnvironmentDescription> {
  const description = EnvironmentDescription.parse(value);
  if (await hashTestEnvironment(description.manifestSource) !== description.manifestHash) throw new Error('The original manifest hash differs from its description.');
  return description;
}
/* A node derives this from pinned Git objects and a conservative pure-function proof. */
export const MutationDelta = z.strictObject({ baseCommit: ProductCommitSha, commit: ProductCommitSha,
  changes: z.array(z.strictObject({ path: RepositoryPath, ranges: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).max(10_000) })).max(10_000),
}).refine(value => new Set(value.changes.map(change => change.path)).size === value.changes.length, 'Changed mutation paths must be distinct.');
export type MutationDelta = z.infer<typeof MutationDelta>;
export const MutationFunction = z.strictObject({ file: RepositoryPath, name: Text.max(1000), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  lines: z.array(z.number().int().positive()).min(1).max(10_000), tests: z.array(RepositoryPath).min(1).max(1000), reason: z.literal('changed_pure_function'),
}).refine(value => value.endLine - value.startLine + 1 === value.lines.length && value.lines.every((line, index) => line === value.startLine + index), 'Mutation lines must cover exactly the selected function.');
export type MutationFunction = z.infer<typeof MutationFunction>;
export const MutationSelection = z.strictObject({ version: z.literal(1), status: z.enum(['ready', 'blocked']), baseCommit: ProductCommitSha, commit: ProductCommitSha,
  selected: z.array(MutationFunction).max(2000), excluded: z.array(z.strictObject({ file: RepositoryPath, name: Text.max(1000).optional(), reason: Text.max(1000) })).max(10_000),
  problems: z.array(z.strictObject({ file: RepositoryPath.optional(), code: Text.max(1000) })).max(10_000),
}).refine(value => (value.status === 'ready') === (value.problems.length === 0), 'Blocked mutation scope must retain its problems.');
export type MutationSelection = z.infer<typeof MutationSelection>;
export const MutationResult = z.strictObject({ selection: MutationSelection, files: z.array(z.strictObject({ file: RepositoryPath, status: z.enum(['passed', 'failed']) })).max(10_000) });
export type MutationResult = z.infer<typeof MutationResult>;
export const CandidateMutation = z.strictObject({ delta: MutationDelta, selection: MutationSelection }).refine(value => {
  if (value.delta.commit !== value.selection.commit || value.delta.baseCommit !== value.selection.baseCommit) return false;
  return value.selection.selected.every(fn => value.delta.changes.some(change => change.path === fn.file && change.ranges.some(([start, count]) => start <= fn.endLine && start + count > fn.startLine)));
}, 'Mutation selection must belong to the same changed candidate lines.').refine(value => byteLength(JSON.stringify(value)) <= 512 * 1024, 'Mutation evidence exceeds its limit.');
export type CandidateMutation = z.infer<typeof CandidateMutation>;
/* A part proves just its assigned sources; the same candidate's other sources stay with their own parts. */
export function mutationSelectionMatches(expected: MutationSelection, actual: MutationSelection, files: string[]): boolean {
  if (expected.status !== 'ready' || actual.status !== 'ready' || expected.baseCommit !== actual.baseCommit || expected.commit !== actual.commit) return false;
  const selected = new Set(files), ordered = (values: unknown[]) => JSON.stringify(values.map(value => JSON.stringify(value)).sort());
  return ordered(expected.selected.filter(fn => selected.has(fn.file))) === ordered(actual.selected)
    && ordered(expected.excluded.filter(fn => selected.has(fn.file))) === ordered(actual.excluded);
}
export function mutationResultMatches(expected: MutationSelection, actual: MutationResult, files: string[]): boolean {
  const selected = new Set(files), reported = new Set(actual.files.map(file => file.file));
  return mutationSelectionMatches(expected, actual.selection, files) && actual.files.length === selected.size && reported.size === selected.size
    && actual.files.every(file => selected.has(file.file) && file.status === 'passed');
}
function boundMutation(value: CandidateMutation | undefined, description: EnvironmentDescription, base: string | undefined, ctx: z.RefinementCtx): void {
  if (!value) return;
  const { mutation } = description.manifest;
  if (!base || value.delta.baseCommit !== base || value.delta.commit !== description.commitSha || mutation.status !== 'supported'
    || value.selection.selected.some(fn => !mutation.sourcePaths.includes(fn.file))) ctx.addIssue({ code: 'custom', message: 'Mutation evidence differs from the pinned candidate or declared sources.' });
}
/* One test file's digest of what its result depends on, at the pinned commit. */
export const UnitFingerprint = z.strictObject({ suiteId: Id, file: RepositoryPath, fingerprint: EnvironmentDigest });
export type UnitFingerprint = z.infer<typeof UnitFingerprint>;
/* With a description at its own limit, they still fit one frame between a node and the server. */
export const UnitFingerprints = z.array(UnitFingerprint).max(10_001).refine(prints => byteLength(JSON.stringify(prints)) <= 960 * 1024, 'The fingerprints exceed their limit.');
const CandidateTestScope = z.strictObject({ baseCommit: ProductCommitSha, baseFingerprints: UnitFingerprints, fingerprints: UnitFingerprints, mutation: CandidateMutation.optional() });
export const EnvironmentSnapshot = z.strictObject({ description: EnvironmentDescription, profile: Id, candidate: CandidateTestScope.optional() })
  .refine(value => value.description.manifest.profiles.some(profile => profile.id === value.profile), 'Unknown product profile.')
  .superRefine((value, ctx) => boundMutation(value.candidate?.mutation, value.description, value.candidate?.baseCommit, ctx)).superRefine(descriptionSize);
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshot>;

const LegacySelection = z.strictObject({ kind: z.enum(['suite', 'final']), suiteId: Id, files: Inputs });
const Shard = z.strictObject({ index: z.number().int().min(1).max(10), count: z.number().int().min(1).max(10) })
  .refine(value => value.index <= value.count, 'A shard index cannot exceed its count.');
const BatchMember = z.strictObject({ kind: z.literal('suite'), suiteId: Id, files: Inputs.min(1), shard: Shard });
const BatchSelection = z.strictObject({ kind: z.literal('batch'), version: z.literal(2), expectedCommitSha: ProductCommitSha, selections: z.array(BatchMember).min(1).max(1000) });
const PrepareSelection = z.strictObject({ kind: z.literal('prepare'), version: z.literal(2), expectedCommitSha: ProductCommitSha });
const VersionedSelection = z.discriminatedUnion('kind', [BatchSelection, PrepareSelection]);
const Selection = z.union([LegacySelection, VersionedSelection]);
function finalSelection(selection: z.infer<typeof LegacySelection>, suite: TestSuite, ctx: z.RefinementCtx): void {
  if (selection.files.length || !suite.finalChecks?.length) ctx.addIssue({ code: 'custom', message: 'Final checks are a separate unsplit leaf without file selection.' });
}
function legacySelection(value: { snapshot: EnvironmentSnapshot; selection: z.infer<typeof LegacySelection> }, ctx: z.RefinementCtx): void {
  const { snapshot, selection } = value;
  const suite = snapshot.description.manifest.suites.find(item => item.id === selection.suiteId);
  if (!suite || !suite.profiles.includes(snapshot.profile)) { ctx.addIssue({ code: 'custom', message: 'The suite is not eligible for this profile.' }); return; }
  if (selection.kind === 'final') return finalSelection(selection, suite, ctx);
  const files = snapshot.description.inventory.filter(unit => unit.suiteId === suite.id).map(unit => unit.file);
  references(selection.files, new Set(files), ['selection', 'files'], ctx);
  distinct(selection.files, 'selection', ctx);
  if (!selection.files.length || (suite.split.kind === 'whole-package' && selection.files.length !== files.length)) ctx.addIssue({ code: 'custom', message: 'An execution needs a nonempty valid selection; whole-package suites cannot be split.' });
}
function oncePreparation(snapshot: EnvironmentSnapshot): z.infer<typeof OncePreparation> | undefined {
  if (snapshot.candidate) return undefined;
  const preparation = snapshot.description.manifest.execution?.oncePreparation;
  return preparation?.profiles.includes(snapshot.profile) ? preparation : undefined;
}
function batchMember(snapshot: EnvironmentSnapshot, selection: z.infer<typeof BatchMember>, ctx: z.RefinementCtx): void {
  legacySelection({ snapshot, selection }, ctx);
  if (oncePreparation(snapshot)?.suiteIds.includes(selection.suiteId)) ctx.addIssue({ code: 'custom', message: 'A once-only suite cannot execute again in a batch.' });
  const units = snapshot.description.inventory.filter(unit => unit.suiteId === selection.suiteId), selected = new Set(selection.files);
  const groups = new Set(units.filter(unit => selected.has(unit.file)).map(unit => unit.selectionUnit));
  if (units.some(unit => groups.has(unit.selectionUnit) && !selected.has(unit.file))) ctx.addIssue({ code: 'custom', message: 'An indivisible selection unit cannot be split.' });
}
function executionSelection(value: { snapshot: EnvironmentSnapshot; selection: z.infer<typeof Selection> }, ctx: z.RefinementCtx): void {
  const { snapshot, selection } = value;
  if (!('version' in selection)) return legacySelection({ snapshot, selection }, ctx);
  if (!snapshot.description.manifest.execution || selection.expectedCommitSha !== snapshot.description.commitSha) {
    ctx.addIssue({ code: 'custom', message: 'Versioned execution requires the pinned policy and exact source.' }); return;
  }
  if (selection.kind === 'prepare') {
    if (!oncePreparation(snapshot)) ctx.addIssue({ code: 'custom', message: 'This profile has no explicit once-preparation.' });
    return;
  }
  distinct(selection.selections.map(member => member.suiteId), 'selection', ctx);
  selection.selections.forEach(member => batchMember(snapshot, member, ctx));
}
export const TestExecution = z.strictObject({ snapshot: EnvironmentSnapshot, selection: Selection }).superRefine(executionSelection);
export type TestExecution = z.infer<typeof TestExecution>;
const CacheReceipt = z.strictObject({ key: EnvironmentDigest.nullable(), hit: z.boolean(), fetched: z.boolean().optional() })
  .refine(receipt => !receipt.hit || receipt.key !== null, 'An uncached preparation cannot be a cache hit.');
const Duration = z.number().finite().nonnegative();
const ReceiptFields = {
  commitSha: ProductCommitSha, manifestHash: EnvironmentDigest,
  mutations: z.array(MutationResult.extend({ suiteId: Id })).max(1000).optional(),
  runtimes: z.array(RuntimeCapability).max(64), dependencies: CacheReceipt,
  environments: z.array(CacheReceipt.safeExtend({ unitId: Id })).max(1000),
  phases: z.strictObject({ checkoutMs: Duration, dependenciesMs: Duration, environmentMs: Duration, servicesMs: Duration, commandMs: Duration, cleanupMs: Duration }),
};
const Outcome = z.strictObject({ index: z.number().int().nonnegative(), status: z.enum(['passed', 'failed', 'not-run']), exitCode: z.number().int().nullable() })
  .refine(value => value.status === 'passed' ? value.exitCode === 0 : value.status === 'not-run' ? value.exitCode === null : value.exitCode !== 0, 'The outcome differs from the command exit.');
const ReceiptV2 = z.strictObject({ ...ReceiptFields, version: z.literal(2), profile: Id, selection: VersionedSelection, outcomes: z.array(Outcome).min(1).max(2000) });
function receiptOutcomes(receipt: z.infer<typeof ReceiptV2>, ctx: z.RefinementCtx): void {
  if (receipt.commitSha !== receipt.selection.expectedCommitSha) ctx.addIssue({ code: 'custom', message: 'The receipt differs from its pinned source.' });
  if (receipt.outcomes.some((outcome, index) => outcome.index !== index)) ctx.addIssue({ code: 'custom', message: 'Outcomes must preserve every command in order.' });
  if (receipt.selection.kind === 'batch' && receipt.outcomes.length !== receipt.selection.selections.length) ctx.addIssue({ code: 'custom', message: 'A batch receipt must retain every selection outcome.' });
}
export const TestEnvironmentReceipt = z.union([
  z.strictObject({ ...ReceiptFields, version: z.literal(1), suiteId: Id, kind: z.enum(['suite', 'final']), files: Inputs }),
  ReceiptV2.superRefine(receiptOutcomes),
]).superRefine(descriptionSize);
export type TestEnvironmentReceipt = z.infer<typeof TestEnvironmentReceipt>;

/* What stands for the one explicit preparation among the units: its work depends on the whole tree. */
export const PREPARATION_UNIT = { suiteId: 'hornhoof-preparation', file: '.hornhoof/test-environment.json' } as const;
/* What a result came to, in one line. It stays with the result and is shown again whenever that result is reused. */
export const FileNote = z.string().min(1).max(300).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);
/* How one test file went, as its runner reported it. */
export const FileOutcome = z.strictObject({ suiteId: Id, file: RepositoryPath, status: z.enum(['passed', 'failed']), ms: Duration.optional(), note: FileNote.optional() });
export type FileOutcome = z.infer<typeof FileOutcome>;
export const KEPT_BYTES = 1024 * 1024;
/* What a suite's run left for its next run, as its manifest's keep names it. */
export const KeptFiles = z.array(z.strictObject({ suiteId: Id, files: z.array(z.strictObject({ path: RepositoryPath, text: z.string() })).max(1000) })).max(100)
  .refine(kept => byteLength(JSON.stringify(kept)) <= KEPT_BYTES, 'Kept files exceed their limit.');
export type KeptFiles = z.infer<typeof KeptFiles>;

export const EnvironmentProblem = z.strictObject({
  code: z.enum(['environment_missing', 'environment_invalid', 'environment_unsupported', 'environment_too_large', 'runtime_missing', 'isolation_missing', 'commit_unavailable', 'description_mismatch', 'transaction_timeout', 'save_failed', 'build_failed', 'cancelled', 'timeout']),
  detail: Text.max(2000),
});
export type EnvironmentProblem = z.infer<typeof EnvironmentProblem>;
export const TestsDescribed = z.strictObject({
  type: z.literal('tests.described'), requestId: z.uuid(), commitSha: ProductCommitSha,
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ready'), description: EnvironmentDescription, fingerprints: UnitFingerprints.optional(), baseFingerprints: z.strictObject({ commitSha: ProductCommitSha, fingerprints: UnitFingerprints }).optional(), mutation: CandidateMutation.optional() }),
    z.strictObject({ status: z.literal('error'), problem: EnvironmentProblem }),
  ]),
}).refine(value => value.result.status !== 'ready' || value.result.description.commitSha === value.commitSha, 'The described commit differs from the requested commit.')
  .superRefine((value, ctx) => { if (value.result.status === 'ready') boundMutation(value.result.mutation, value.result.description, value.result.baseFingerprints?.commitSha, ctx); }).superRefine(descriptionResponseSize);
export type TestsDescribed = z.infer<typeof TestsDescribed>;

export function runtimeVersionMatches(requested: string, actual: string): boolean {
  if (!/^\d+(?:\.\d+){0,2}$/.test(requested) || !/^\d+(?:\.\d+){1,2}$/.test(actual)) return false;
  return requested.split('.').every((value, index) => value === actual.split('.')[index]);
}
export function requiredTestRuntimes(manifest: TestEnvironmentV1, profile: string): TestEnvironmentV1['runtimes'] {
  const services = new Set(manifest.services.map(service => service.runtime));
  const active = new Set(manifest.services.filter(service => service.profiles.includes(profile)).map(service => service.runtime));
  const runtimes = manifest.runtimes.filter(runtime => !services.has(runtime.id) || active.has(runtime.id));
  return manifest.execution ? [...runtimes, { id: 'hornhoof-test-execution', version: '2.0.0' }] : runtimes;
}
export function supportsTestProfile(snapshot: EnvironmentSnapshot, capabilities: RuntimeCapability[]): boolean {
  return requiredTestRuntimes(snapshot.description.manifest, snapshot.profile).every(requested => capabilities.some(actual => actual.id === requested.id && runtimeVersionMatches(requested.version, actual.version)));
}
/* What a runtime stands for in a test result: its program and major version, and the system and libc it runs on, not its build
   or its processor. Our tests come out the same on every machine of a class. What a machine installs and builds stays keyed to
   its exact build. A runtime that does not name its system has no class. */
export function runtimeClass(runtime: RuntimeCapability): string | null {
  const major = /^(\d+)(?:\.|$)/.exec(runtime.version)?.[1];
  return runtime.platform && major ? JSON.stringify([runtime.id, major, runtime.platform.os, runtime.platform.libc]) : null;
}
const sameRuntime = (a: RuntimeCapability, b: RuntimeCapability): boolean => a.id === b.id && a.version === b.version && a.fingerprint === b.fingerprint;
function sameClass(described: RuntimeCapability | undefined, actual: RuntimeCapability | undefined): boolean {
  if (!described || !actual) return false;
  const kind = runtimeClass(described);
  return kind === null ? runtimeClass(actual) === null && sameRuntime(described, actual) : kind === runtimeClass(actual);
}
/* Whether runtimes run a profile of a run as the runtimes that described it would: every runtime the profile needs is of the same
   class. The scheduler gives a part only to such a node, and a part's receipt is accepted only when the runtimes it names are such,
   so a part never goes where its proof would be refused. */
export function runsInClass(snapshot: EnvironmentSnapshot, runtimes: RuntimeCapability[]): boolean {
  const described = snapshot.description.runtimeCapabilities, find = (list: RuntimeCapability[], id: string) => list.find(runtime => runtime.id === id);
  return supportsTestProfile(snapshot, runtimes) && requiredTestRuntimes(snapshot.description.manifest, snapshot.profile).every(needed => sameClass(find(described, needed.id), find(runtimes, needed.id)));
}
