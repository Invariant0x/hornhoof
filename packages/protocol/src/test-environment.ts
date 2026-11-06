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
  z.strictObject({ path: RepositoryPath, format: Text, env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }),
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
  z.strictObject({ kind: z.literal('whole-package') }),
]);
export const TestSuite = z.strictObject({ id: Id, root: RepositoryPath, files: Inputs.min(1), run: Command, split: TestSplit, profiles: ProfileIds, finalChecks: z.array(Command).max(1000).optional() });
export type TestSuite = z.infer<typeof TestSuite>;

const MigrationCheck = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported'), up: Command, down: Command }),
  z.strictObject({ status: z.literal('unsupported'), reason: Text }),
]);
export const TestMutation = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported'), language: Id, tool: Id, command: Command, sourcePaths: Inputs.min(1), fastTestPaths: Inputs.min(1), coverageCommands: z.array(Command).min(1).max(1000), coverageFiles: Inputs.min(1) }),
  z.strictObject({ status: z.literal('unsupported'), language: Id, reason: Text }),
]);
const EnvironmentShape = z.strictObject({
  version: z.literal(1), defaultProfile: Id,
  runtimes: z.array(z.strictObject({ id: Id, version: Text.max(100) })).max(64),
  profiles: z.array(z.strictObject({ id: Id, requiredSuiteIds: Ids.min(1) })).min(1).max(128),
  dependencies: z.strictObject({ adapter: Id, inputs: Inputs, install: z.array(Command).max(1000), paths: Inputs, cache: z.enum(['copy', 'none']) }),
  services: z.array(TestService).max(128), prepare: z.array(TestPrepare).max(1000),
  reset: z.array(TestReset).min(1).max(1000).nullable(), suites: z.array(TestSuite).min(1).max(1000),
  impact: z.strictObject({ adapter: Id, fullPackageGlobs: z.array(z.strictObject({ globs: Inputs.min(1), suiteIds: Ids.min(1) })).max(1000), migrationCheck: MigrationCheck }),
  mutation: TestMutation,
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
function environmentReferences(env: EnvironmentShape, ctx: z.RefinementCtx): void {
  const profiles = identities(env.profiles, 'profiles', ctx), suites = identities(env.suites, 'suites', ctx), services = identities(env.services, 'services', ctx);
  reference(env.defaultProfile, profiles, ['defaultProfile'], ctx);
  requiredSuites(env, suites, ctx); serviceProfiles(env, profiles, ctx);
  preparations(env, profiles, services, ctx); suiteReferences(env, suites, profiles, ctx);
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

export const RuntimeCapability = z.strictObject({ id: Id, version: Text.max(200), fingerprint: EnvironmentDigest });
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
export const EnvironmentDescription = DescriptionShape.superRefine(descriptionSource).superRefine(descriptionEvidence).superRefine(descriptionSize);
export type EnvironmentDescription = z.infer<typeof EnvironmentDescription>;
export async function validateEnvironmentDescription(value: unknown): Promise<EnvironmentDescription> {
  const description = EnvironmentDescription.parse(value);
  if (await hashTestEnvironment(description.manifestSource) !== description.manifestHash) throw new Error('The original manifest hash differs from its description.');
  return description;
}
export const EnvironmentSnapshot = z.strictObject({ description: EnvironmentDescription, profile: Id })
  .refine(value => value.description.manifest.profiles.some(profile => profile.id === value.profile), 'Unknown product profile.');
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshot>;
const Selection = z.strictObject({ kind: z.enum(['suite', 'final']), suiteId: Id, files: Inputs });
function finalSelection(selection: z.infer<typeof Selection>, suite: TestSuite, ctx: z.RefinementCtx): void {
  if (selection.files.length || !suite.finalChecks?.length) ctx.addIssue({ code: 'custom', message: 'Final checks are a separate unsplit leaf without file selection.' });
}
function executionSelection(value: { snapshot: EnvironmentSnapshot; selection: z.infer<typeof Selection> }, ctx: z.RefinementCtx): void {
  const { snapshot, selection } = value;
  const suite = snapshot.description.manifest.suites.find(item => item.id === selection.suiteId);
  if (!suite || !suite.profiles.includes(snapshot.profile)) { ctx.addIssue({ code: 'custom', message: 'The suite is not eligible for this profile.' }); return; }
  if (selection.kind === 'final') return finalSelection(selection, suite, ctx);
  const files = snapshot.description.inventory.filter(unit => unit.suiteId === suite.id).map(unit => unit.file);
  references(selection.files, new Set(files), ['selection', 'files'], ctx);
  distinct(selection.files, 'selection', ctx);
  if (!selection.files.length || (suite.split.kind === 'whole-package' && selection.files.length !== files.length)) ctx.addIssue({ code: 'custom', message: 'An execution needs a nonempty valid selection; whole-package suites cannot be split.' });
}
export const TestExecution = z.strictObject({ snapshot: EnvironmentSnapshot, selection: Selection }).superRefine(executionSelection);
export type TestExecution = z.infer<typeof TestExecution>;
const CacheReceipt = z.strictObject({ key: EnvironmentDigest.nullable(), hit: z.boolean() })
  .refine(receipt => !receipt.hit || receipt.key !== null, 'An uncached preparation cannot be a cache hit.');
const Duration = z.number().finite().nonnegative();
export const TestEnvironmentReceipt = z.strictObject({
  version: z.literal(1), commitSha: ProductCommitSha, manifestHash: EnvironmentDigest,
  suiteId: Id, kind: z.enum(['suite', 'final']), files: Inputs,
  runtimes: z.array(RuntimeCapability).max(64), dependencies: CacheReceipt,
  environments: z.array(CacheReceipt.safeExtend({ unitId: Id })).max(1000),
  phases: z.strictObject({ checkoutMs: Duration, dependenciesMs: Duration, environmentMs: Duration, servicesMs: Duration, commandMs: Duration, cleanupMs: Duration }),
}).superRefine(descriptionSize);
export type TestEnvironmentReceipt = z.infer<typeof TestEnvironmentReceipt>;

export const EnvironmentProblem = z.strictObject({
  code: z.enum(['environment_missing', 'environment_invalid', 'environment_unsupported', 'environment_too_large', 'runtime_missing', 'isolation_missing', 'commit_unavailable', 'description_mismatch', 'cancelled', 'timeout']),
  detail: Text.max(2000),
});
export type EnvironmentProblem = z.infer<typeof EnvironmentProblem>;
export const TestsDescribed = z.strictObject({
  type: z.literal('tests.described'), requestId: z.uuid(), commitSha: ProductCommitSha,
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ready'), description: EnvironmentDescription }),
    z.strictObject({ status: z.literal('error'), problem: EnvironmentProblem }),
  ]),
}).refine(value => value.result.status !== 'ready' || value.result.description.commitSha === value.commitSha, 'The described commit differs from the requested commit.').superRefine(descriptionSize);
export type TestsDescribed = z.infer<typeof TestsDescribed>;

export function runtimeVersionMatches(requested: string, actual: string): boolean {
  if (!/^\d+(?:\.\d+){0,2}$/.test(requested) || !/^\d+(?:\.\d+){1,2}$/.test(actual)) return false;
  return requested.split('.').every((value, index) => value === actual.split('.')[index]);
}
export function requiredTestRuntimes(manifest: TestEnvironmentV1, profile: string): TestEnvironmentV1['runtimes'] {
  const services = new Set(manifest.services.map(service => service.runtime));
  const active = new Set(manifest.services.filter(service => service.profiles.includes(profile)).map(service => service.runtime));
  return manifest.runtimes.filter(runtime => !services.has(runtime.id) || active.has(runtime.id));
}
export function supportsTestProfile(snapshot: EnvironmentSnapshot, capabilities: RuntimeCapability[]): boolean {
  return requiredTestRuntimes(snapshot.description.manifest, snapshot.profile).every(requested => capabilities.some(actual => actual.id === requested.id && runtimeVersionMatches(requested.version, actual.version)));
}
