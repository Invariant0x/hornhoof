import { describe, expect, it } from 'vitest';
import { EnvironmentDescription, FileOutcome, KeptFiles, TestEnvironmentV1, TestsDescribed, UnitFingerprint, UnitFingerprints, hashTestEnvironment, parseNodeMessage, parseServerMessage } from '../src/index.js';

const command = { program: 'node', args: ['run.js'], cwd: '.' };
const manifest = (execution?: object, suite: object = {}) => ({
  version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }],
  profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }, { id: 'final', requiredSuiteIds: ['unit'] }, { id: 'full', requiredSuiteIds: ['unit'] }],
  dependencies: { adapter: 'npm', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
  suites: [{ id: 'unit', root: '.', files: ['test/*.ts'], run: command, split: { kind: 'argv-files' }, profiles: ['fast', 'final', 'full'], ...suite }],
  impact: { adapter: 'typescript', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } },
  mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' },
  ...(execution ? { execution } : {}),
});
const fullRun = (value: object) => manifest({ version: 2, fullRun: value });
const digest = 'a'.repeat(64);

describe('the full run of a manifest', () => {
  it('names which profile runs everything and which one it covers, and no interval: every release runs it', () => {
    const parsed = TestEnvironmentV1.parse(fullRun({ replaces: 'final', profile: 'full' }));
    expect(parsed.execution?.fullRun).toEqual({ replaces: 'final', profile: 'full' });
  });

  it.each([
    ['an unknown profile', { replaces: 'final', profile: 'whole' }],
    ['an unknown profile it covers', { replaces: 'last', profile: 'full' }],
    ['the same profile twice', { replaces: 'final', profile: 'final' }],
    ['a number of turns that is not a whole number above zero', { everyTurns: 0, replaces: 'final', profile: 'full' }],
  ])('refuses %s', (_name, value) => {
    expect(TestEnvironmentV1.safeParse(fullRun(value)).success).toBe(false);
  });

  /* A server or node before 0.24.0 refuses a full run without its number of turns, and repositories wrote it for them:
     it still reads, and nothing runs by it. */
  it('takes the number of turns a manifest kept for an earlier server, and nothing runs by it', () => {
    const parsed = TestEnvironmentV1.parse(fullRun({ everyTurns: 5, replaces: 'final', profile: 'full' }));
    expect(parsed.execution?.fullRun).toMatchObject({ replaces: 'final', profile: 'full' });
  });

  it('refuses a full profile that leaves out a suite of what it covers', () => {
    const value = fullRun({ replaces: 'final', profile: 'full' }) as ReturnType<typeof manifest>;
    value.suites.push({ id: 'more', root: '.', files: ['more/*.ts'], run: command, split: { kind: 'argv-files' }, profiles: ['final'] });
    value.profiles[1]!.requiredSuiteIds.push('more');
    expect(TestEnvironmentV1.safeParse(value).success).toBe(false);
  });
});

describe('the release check of a manifest', () => {
  const declared = (releaseCheck: object) => manifest({ version: 2, releaseCheck });

  it('names the mechanism of the one whole run of a release that the project declares: its CI, a command of its own, or one run of Hornhoof', () => {
    expect(TestEnvironmentV1.parse(declared({ mechanism: 'ci' })).execution?.releaseCheck).toEqual({ mechanism: 'ci' });
    expect(TestEnvironmentV1.parse(declared({ mechanism: 'command', command })).execution?.releaseCheck).toEqual({ mechanism: 'command', command });
    expect(TestEnvironmentV1.parse(declared({ mechanism: 'hornhoof_run', profile: 'full' })).execution?.releaseCheck).toEqual({ mechanism: 'hornhoof_run', profile: 'full' });
  });

  it('sits beside the full run, which a manifest without a release check keeps as it was', () => {
    const both = TestEnvironmentV1.parse(manifest({ version: 2, fullRun: { replaces: 'final', profile: 'full' }, releaseCheck: { mechanism: 'ci' } }));
    expect(both.execution).toMatchObject({ fullRun: { replaces: 'final', profile: 'full' }, releaseCheck: { mechanism: 'ci' } });
    expect(TestEnvironmentV1.parse(fullRun({ replaces: 'final', profile: 'full' })).execution?.releaseCheck).toBeUndefined();
  });

  it.each([
    ['a mechanism nobody knows', { mechanism: 'github' }],
    ['a command check with no command', { mechanism: 'command' }],
    ['a CI check that carries a command', { mechanism: 'ci', command }],
    ['a run of Hornhoof of a profile the manifest does not have', { mechanism: 'hornhoof_run', profile: 'whole' }],
    ['a run of Hornhoof with no profile', { mechanism: 'hornhoof_run' }],
  ])('refuses %s', (_name, value) => {
    expect(TestEnvironmentV1.safeParse(declared(value)).success).toBe(false);
  });
});

describe('what a suite declares for reuse', () => {
  it('takes the source a scenario drives and the paths it keeps between runs', () => {
    const parsed = TestEnvironmentV1.parse(manifest(undefined, { scenarioSources: 'web/src', keep: ['.metrics/mutate'] }));
    expect(parsed.suites[0]).toMatchObject({ scenarioSources: 'web/src', keep: ['.metrics/mutate'] });
  });

  it('refuses a kept path outside the repository', () => {
    expect(TestEnvironmentV1.safeParse(manifest(undefined, { keep: ['../secrets'] })).success).toBe(false);
  });
});

describe('fingerprints on the wire', () => {
  const description = async () => {
    const value = manifest(), manifestSource = JSON.stringify(value);
    return { version: 1, repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: digest }, commitSha: 'b'.repeat(40), manifestSource, manifestHash: await hashTestEnvironment(manifestSource), manifest: value, inputDigests: [], inventory: [{ suiteId: 'unit', file: 'test/a.ts', selectionUnit: 'test/a.ts' }], runtimeCapabilities: [] };
  };
  const reply = async (fingerprints?: unknown) => ({ type: 'tests.described', requestId: '33333333-3333-4333-8333-333333333333', commitSha: 'b'.repeat(40), result: { status: 'ready', description: await description(), ...(fingerprints === undefined ? {} : { fingerprints }) } });

  it('an older node may send none', async () => {
    expect(TestsDescribed.safeParse(await reply()).success).toBe(true);
  });

  it('carries one digest per unit and refuses anything else', async () => {
    const good = { suiteId: 'unit', file: 'test/a.ts', fingerprint: digest };
    expect(UnitFingerprint.parse(good)).toEqual(good);
    expect(TestsDescribed.parse(await reply([good]))).toMatchObject({ result: { fingerprints: [good] } });
    expect(TestsDescribed.safeParse(await reply([{ ...good, fingerprint: 'short' }])).success).toBe(false);
    expect(TestsDescribed.safeParse(await reply([{ ...good, file: '../a.ts' }])).success).toBe(false);
  });

  it('leaves room for the description in one frame', async () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ suiteId: 'unit', file: `test/${index}.ts`, fingerprint: digest }));
    expect(UnitFingerprints.safeParse(many(1000)).success).toBe(true);
    expect(UnitFingerprints.safeParse(many(10_000)).success).toBe(false);
    const message = await reply(many(8000)), described = message.result.description;
    const long = (index: number) => `test/${'x'.repeat(280)}${index}.ts`;
    described.inventory = Array.from({ length: 4400 }, (_, index) => ({ suiteId: 'unit', file: long(index), selectionUnit: long(index) }));
    expect(JSON.stringify(described).length).toBeGreaterThan(2.5 * 1024 * 1024);
    expect(JSON.stringify(message).length).toBeGreaterThan(3 * 1024 * 1024);
    expect(JSON.stringify(message).length).toBeLessThan(4 * 1024 * 1024);
    expect(TestsDescribed.safeParse(message).error?.issues).toBeUndefined();
  });

  it('refuses a response beyond the transport frame even when its separate evidence lists fit', async () => {
    const fingerprints = Array.from({ length: 8000 }, (_, index) => ({ suiteId: 'unit', file: `test/${index}.ts`, fingerprint: digest }));
    const message = await reply(fingerprints), described = message.result.description;
    const long = (index: number) => `test/${'x'.repeat(280)}${index}.ts`;
    described.inventory = Array.from({ length: 4400 }, (_, index) => ({ suiteId: 'unit', file: long(index), selectionUnit: long(index) }));
    const full = { ...message, result: { ...message.result, baseFingerprints: { commitSha: 'a'.repeat(40), fingerprints } } };
    expect(EnvironmentDescription.safeParse(described).success).toBe(true);
    expect(UnitFingerprints.safeParse(fingerprints).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(4 * 1024 * 1024);
    expect(TestsDescribed.safeParse(full).error?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('4MiB') })]));
  });
});

describe('what a part reports of its files', () => {
  const done = { type: 'tests.done', partId: 'p', ok: false, exitCode: 1, error: 'failed', commit: null, log: '' };

  it('says per file how it went and how long it took', () => {
    const file = { suiteId: 'unit', file: 'test/a.ts', status: 'failed', ms: 12.5 };
    expect(FileOutcome.parse(file)).toEqual(file);
    expect(parseNodeMessage(JSON.stringify({ ...done, files: [file] }))).toMatchObject({ files: [file] });
  });

  it('can say in one line what a result came to', () => {
    const file = { suiteId: 'unit', file: 'test/a.ts', status: 'passed', note: '2 killed, 7 survived' };
    expect(FileOutcome.parse(file)).toEqual(file);
    expect(FileOutcome.safeParse({ ...file, note: 'two\nlines' }).success).toBe(false);
    expect(FileOutcome.safeParse({ ...file, note: 'x'.repeat(301) }).success).toBe(false);
  });

  it('refuses a status other than passed or failed', () => {
    expect(FileOutcome.safeParse({ suiteId: 'unit', file: 'test/a.ts', status: 'skipped' }).success).toBe(false);
  });

  it('carries the files a suite keeps both ways, within the repository', () => {
    const kept = [{ suiteId: 'unit', files: [{ path: '.metrics/mutate/a.edn', text: '{}' }] }];
    expect(KeptFiles.parse(kept)).toEqual(kept);
    expect(parseNodeMessage(JSON.stringify({ ...done, kept }))).toMatchObject({ kept });
    expect(parseServerMessage(JSON.stringify({ type: 'tests.run', partId: '44444444-4444-4444-8444-444444444444', repo: null, branch: null, task: 1, command: 'true', part: 1, parts: 1, timeoutMs: 1000, kept }))).toMatchObject({ kept });
    expect(KeptFiles.safeParse([{ suiteId: 'unit', files: [{ path: '../a.edn', text: '{}' }] }]).success).toBe(false);
  });
});
