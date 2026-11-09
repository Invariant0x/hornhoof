import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { candidateTestUnits, EnvironmentSnapshot, MutationSelection, mutationResultMatches, mutationSelectionMatches, PREPARATION_UNIT, TestEnvironmentV1 } from '../src/test-environment.js';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), BEFORE = 'c'.repeat(64), AFTER = 'd'.repeat(64);
const command = { program: 'node', args: ['run.js'], cwd: '.' };

function selection() {
  return MutationSelection.parse({ version: 1, status: 'ready', baseCommit: BASE, commit: HEAD, problems: [], excluded: [], selected: [
    { file: 'src/pure.ts', name: 'price', startLine: 1, endLine: 1, lines: [1], tests: ['spec/a.ts'], reason: 'changed_pure_function' },
  ] });
}

function snapshot(withMutation = false): EnvironmentSnapshot {
  const manifest = TestEnvironmentV1.parse({ version: 1, defaultProfile: 'fast', runtimes: [],
    profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }],
    dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
    suites: ['unit', 'other'].map(id => ({ id, root: '.', files: ['spec/*.ts', 'src/*.ts'], run: command, split: { kind: 'argv-files' }, profiles: ['fast'] })),
    impact: { adapter: 'typescript', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No migrations.' } },
    mutation: withMutation ? { status: 'supported', language: 'typescript', tool: 'mutator', command, sourcePaths: ['src/pure.ts'], fastTestPaths: ['spec/a.ts'], coverageCommands: [command], coverageFiles: ['coverage/lcov.info'] }
      : { status: 'unsupported', language: 'typescript', reason: 'No mutation applicability in this case.' },
  });
  const inventory = [
    { suiteId: 'unit', file: 'spec/a.ts', selectionUnit: 'spec/group.ts' },
    { suiteId: 'unit', file: 'spec/b.ts', selectionUnit: 'spec/group.ts' },
    { suiteId: 'unit', file: 'src/pure.ts', selectionUnit: 'src/pure.ts' },
    { suiteId: 'other', file: 'spec/c.ts', selectionUnit: 'spec/c.ts' },
  ];
  const fingerprints = inventory.map((unit, index) => ({ suiteId: unit.suiteId, file: unit.file, fingerprint: index === 0 || index === 3 ? AFTER : BEFORE }));
  const manifestSource = JSON.stringify(manifest);
  return EnvironmentSnapshot.parse({ profile: 'fast', description: { version: 1, commitSha: HEAD,
    repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: BEFORE },
    manifest, manifestSource, manifestHash: createHash('sha256').update(manifestSource).digest('hex'), inventory, inputDigests: [], runtimeCapabilities: [],
  }, candidate: { baseCommit: BASE, fingerprints, baseFingerprints: fingerprints.map(unit => ({ ...unit, fingerprint: BEFORE })) } });
}

describe('candidate applicability at the shared protocol boundary', () => {
  it('keeps a changed indivisible group together and leaves out an ineligible suite', () => {
    expect(candidateTestUnits(snapshot()).map(unit => unit.file)).toEqual(['spec/a.ts', 'spec/b.ts']);
  });

  it('records no applicable checks when the final influencing fingerprints did not change', () => {
    const value = snapshot();
    value.candidate!.fingerprints = structuredClone(value.candidate!.baseFingerprints);
    expect(candidateTestUnits(value)).toEqual([]);
  });

  it.each(['baseFingerprints', 'fingerprints'] as const)('refuses duplicate %s rather than borrowing one result twice', field => {
    const value = snapshot();
    value.candidate![field].push(value.candidate![field][0]!);
    expect(() => candidateTestUnits(value)).toThrow('once');
  });

  it.each(['missing', 'extra'] as const)('refuses %s final canonical inventory', problem => {
    const value = snapshot();
    if (problem === 'missing') value.candidate!.fingerprints.pop();
    else value.candidate!.fingerprints.push({ suiteId: 'unit', file: 'spec/alien.ts', fingerprint: AFTER });
    expect(() => candidateTestUnits(value)).toThrow('canonical');
  });

  it('allows the separately named preparation fingerprint without selecting it as a test', () => {
    const value = snapshot();
    value.candidate!.fingerprints.push({ ...PREPARATION_UNIT, fingerprint: AFTER });
    expect(candidateTestUnits(value).map(unit => unit.file)).toEqual(['spec/a.ts', 'spec/b.ts']);
  });

  it('refuses a missing candidate or an unknown profile', () => {
    const value = snapshot();
    expect(() => candidateTestUnits({ ...value, candidate: undefined })).toThrow('pinned base');
    expect(() => candidateTestUnits({ ...value, profile: 'unknown' })).toThrow('known profile');
  });

  it('selects a changed mutation source only with a ready pure-function proof', () => {
    const value = snapshot(true);
    expect(() => candidateTestUnits(value)).toThrow('mutation applicability');
    value.candidate!.mutation = { delta: { baseCommit: BASE, commit: HEAD, changes: [{ path: 'src/pure.ts', ranges: [[1, 1]] }] }, selection: selection() };
    value.candidate!.fingerprints[2]!.fingerprint = AFTER;
    expect(candidateTestUnits(value).map(unit => unit.file)).toEqual(['spec/a.ts', 'spec/b.ts', 'src/pure.ts']);
    value.candidate!.mutation.selection.selected = [];
    expect(candidateTestUnits(value).map(unit => unit.file)).toEqual(['spec/a.ts', 'spec/b.ts']);
    value.candidate!.mutation.selection.status = 'blocked';
    expect(() => candidateTestUnits(value)).toThrow('mutation applicability');
  });
});

describe('one actual passing mutation result for every assigned source', () => {
  it('accepts an exact passing source result without modifying either selection', () => {
    const expected = selection(), actual = structuredClone(expected), before = structuredClone(expected);
    expect(mutationResultMatches(expected, { selection: actual, files: [{ file: 'src/pure.ts', status: 'passed' }] }, ['src/pure.ts'])).toBe(true);
    expect(expected).toEqual(before);
    expect(actual).toEqual(before);
  });

  it.each(['missing', 'duplicate', 'failed', 'foreign'] as const)('refuses a %s source outcome', problem => {
    const expected = selection(), files: { file: string; status: 'passed' | 'failed' }[] = [{ file: 'src/pure.ts', status: 'passed' }];
    if (problem === 'missing') files.length = 0;
    if (problem === 'duplicate') files.push(files[0]!);
    if (problem === 'failed') files[0]!.status = 'failed';
    if (problem === 'foreign') files[0]!.file = 'src/other.ts';
    expect(mutationResultMatches(expected, { selection: expected, files }, ['src/pure.ts'])).toBe(false);
  });

  it.each(['base', 'head', 'blocked', 'function', 'excluded'] as const)('refuses a different %s selection', problem => {
    const expected = selection(), actual = structuredClone(expected);
    if (problem === 'base') actual.baseCommit = HEAD;
    if (problem === 'head') actual.commit = BASE;
    if (problem === 'blocked') actual.status = 'blocked';
    if (problem === 'function') actual.selected[0]!.name = 'anotherFunction';
    if (problem === 'excluded') actual.excluded.push({ file: 'src/pure.ts', reason: 'purity_unproven' });
    expect(mutationSelectionMatches(expected, actual, ['src/pure.ts'])).toBe(false);
  });
});
