import type { TestEnvironmentV1, TestUnit } from '@hornhoof/protocol';
import { PREPARATION_UNIT } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { chooseRunMode, decideReuse, fullRunDue, partFileResults, reuseLines } from '../src/modules/testruns/reuse.js';

describe('when the full run is due', () => {
  it.each([
    { turn: 5, everyTurns: 5, lastFullTurn: null, due: true, why: 'on a multiple of the interval' },
    { turn: 10, everyTurns: 5, lastFullTurn: 5, due: true, why: 'on the next multiple' },
    { turn: 4, everyTurns: 5, lastFullTurn: null, due: false, why: 'not before the first multiple' },
    { turn: 6, everyTurns: 5, lastFullTurn: 5, due: false, why: 'not the turn after one' },
    { turn: 5, everyTurns: 5, lastFullTurn: 5, due: false, why: 'not twice in one turn' },
    { turn: 7, everyTurns: 5, lastFullTurn: 2, due: true, why: 'when a multiple went by without one' },
    { turn: 3, everyTurns: 3, lastFullTurn: null, due: true, why: 'at another interval' },
    { turn: null, everyTurns: 5, lastFullTurn: null, due: false, why: 'not without a turn' },
  ])('$why: turn $turn', ({ due, ...input }) => {
    expect(fullRunDue(input)).toBe(due);
  });
});

const fullRun = { everyTurns: 5, replaces: 'final', profile: 'full' };
const manifest = (full?: object) => ({ defaultProfile: 'fast', execution: { version: 2, ...(full ? { fullRun: full } : {}) } }) as unknown as TestEnvironmentV1;

describe('how a run chooses', () => {
  it('keeps to itself where the manifest declares no full run: nothing is reused without one', () => {
    expect(chooseRunMode(manifest(), {}, true, true)).toBeNull();
    expect(chooseRunMode({ defaultProfile: 'fast' } as unknown as TestEnvironmentV1, {}, true, true)).toBeNull();
  });

  it('takes the full profile for the profile it replaces on a due turn', () => {
    expect(chooseRunMode(manifest(fullRun), { profile: 'final' }, true, true)).toEqual({ mode: 'full', profile: 'full' });
  });

  it('stays cached before that turn, for other profiles and for one suite', () => {
    expect(chooseRunMode(manifest(fullRun), { profile: 'final' }, false, true)).toEqual({ mode: 'cached', profile: 'final' });
    expect(chooseRunMode(manifest(fullRun), {}, true, true)).toEqual({ mode: 'cached', profile: 'fast' });
    expect(chooseRunMode(manifest(fullRun), { profile: 'final', suite: 'unit' }, true, true)).toEqual({ mode: 'cached', profile: 'final' });
  });

  it('reuses nothing when asked for the full profile by name', () => {
    expect(chooseRunMode(manifest(fullRun), { profile: 'full' }, false, true)).toEqual({ mode: 'full', profile: 'full' });
  });

  it('turns off without fingerprints, and a due full run stays a full run', () => {
    expect(chooseRunMode(manifest(fullRun), { profile: 'final' }, false, false)).toEqual({ mode: 'off', profile: 'final' });
    expect(chooseRunMode(manifest(fullRun), { profile: 'final' }, true, false)).toEqual({ mode: 'full', profile: 'full' });
  });
});

const unit = (suiteId: string, file: string, selectionUnit = file): TestUnit => ({ suiteId, file, selectionUnit });
const units = [unit('a', 'a/1.ts'), unit('a', 'a/2.ts'), unit('b', 'b/1.ts')];
const prints = (entries: [string, string, string][]) => entries.map(([suiteId, file, fingerprint]) => ({ suiteId, file, fingerprint }));
const allPrints = prints([['a', 'a/1.ts', 'p1'], ['a', 'a/2.ts', 'p2'], ['b', 'b/1.ts', 'p3']]);
const green = (entries: [string, string, string][]) => new Set(entries.map(([suiteId, file, fingerprint]) => `${suiteId}\0${file}\0${fingerprint}`));
const allGreen = green([['a', 'a/1.ts', 'p1'], ['a', 'a/2.ts', 'p2'], ['b', 'b/1.ts', 'p3']]);

describe('what a run reuses', () => {
  it('a file with a green result at its fingerprint', () => {
    expect([...decideReuse({ units, prints: allPrints, green: allGreen, once: [] }).reused].sort()).toEqual(['a\0a/1.ts', 'a\0a/2.ts', 'b\0b/1.ts']);
  });

  it('nothing at another fingerprint, whatever the file was before', () => {
    const decision = decideReuse({ units, prints: allPrints, green: green([['a', 'a/1.ts', 'old'], ['a', 'a/2.ts', 'p2']]), once: [] });
    expect([...decision.reused]).toEqual(['a\0a/2.ts']);
  });

  it('nothing for a file without a fingerprint', () => {
    expect([...decideReuse({ units, prints: allPrints.slice(1), green: allGreen, once: [] }).reused].sort()).toEqual(['a\0a/2.ts', 'b\0b/1.ts']);
  });

  it('a group that cannot be split only when every file of it is green', () => {
    const whole = [unit('a', 'a/1.ts', 'a'), unit('a', 'a/2.ts', 'a'), unit('b', 'b/1.ts')];
    expect([...decideReuse({ units: whole, prints: allPrints, green: green([['a', 'a/1.ts', 'p1'], ['b', 'b/1.ts', 'p3']]), once: [] }).reused]).toEqual(['b\0b/1.ts']);
    expect(decideReuse({ units: whole, prints: allPrints, green: allGreen, once: [] }).reused.size).toBe(3);
  });

  it('the preparation with its suites, only when it and all of them are green', () => {
    const withPreparation = [...allPrints, { ...PREPARATION_UNIT, fingerprint: 'prep' }];
    const preparationGreen = new Set([...allGreen, `${PREPARATION_UNIT.suiteId}\0${PREPARATION_UNIT.file}\0prep`]);
    expect(decideReuse({ units, prints: withPreparation, green: preparationGreen, once: ['a'] })).toMatchObject({ preparation: true });
    expect(decideReuse({ units, prints: withPreparation, green: preparationGreen, once: ['a'] }).reused.has('a\0a/1.ts')).toBe(true);
    const changed = decideReuse({ units, prints: withPreparation, green: allGreen, once: ['a'] });
    expect(changed.preparation).toBe(false);
    expect([...changed.reused]).toEqual(['b\0b/1.ts']);
    const partly = decideReuse({ units, prints: withPreparation, green: new Set([...preparationGreen].filter(key => !key.startsWith('a\0a/1.ts'))), once: ['a'] });
    expect(partly.preparation).toBe(false);
  });
});

describe('what a part leaves', () => {
  const snapshot = { description: { inventory: units, manifest: { execution: { oncePreparation: { suiteIds: ['a'] } } } } } as never;
  const batch = { kind: 'batch', version: 2, expectedCommitSha: 'a'.repeat(40), selections: [{ kind: 'suite', suiteId: 'a', files: ['a/1.ts', 'a/2.ts'], shard: { index: 1, count: 1 } }] } as never;
  const prepare = { kind: 'prepare', version: 2, expectedCommitSha: 'a'.repeat(40) } as never;

  it('that passed: all its files are green', () => {
    expect(partFileResults(snapshot, batch, true, undefined)).toEqual({ green: [{ suiteId: 'a', file: 'a/1.ts' }, { suiteId: 'a', file: 'a/2.ts' }], failed: [] });
  });

  it('that failed without saying which file: nothing is known', () => {
    expect(partFileResults(snapshot, batch, false, undefined)).toEqual({ green: [], failed: [] });
  });

  it('that failed and said: its passing files are green and the others named', () => {
    const files = [{ suiteId: 'a', file: 'a/1.ts', status: 'passed', ms: 5 }, { suiteId: 'a', file: 'a/2.ts', status: 'failed' }] as never;
    expect(partFileResults(snapshot, batch, false, files)).toEqual({ green: [{ suiteId: 'a', file: 'a/1.ts', ms: 5 }], failed: [{ suiteId: 'a', file: 'a/2.ts' }] });
  });

  it('never makes green what it was not given', () => {
    const files = [{ suiteId: 'b', file: 'b/1.ts', status: 'passed' }, { suiteId: 'a', file: 'a/1.ts', status: 'failed' }] as never;
    expect(partFileResults(snapshot, batch, false, files)).toEqual({ green: [], failed: [{ suiteId: 'a', file: 'a/1.ts' }] });
    expect(partFileResults(snapshot, batch, true, files).green).toEqual([{ suiteId: 'a', file: 'a/2.ts' }]);
  });

  it('that prepared: its suites and the preparation itself are green only when it passed', () => {
    expect(partFileResults(snapshot, prepare, true, undefined).green).toEqual([PREPARATION_UNIT, { suiteId: 'a', file: 'a/1.ts' }, { suiteId: 'a', file: 'a/2.ts' }]);
    const files = [{ suiteId: 'a', file: 'a/1.ts', status: 'passed' }] as never;
    expect(partFileResults(snapshot, prepare, false, files).green).toEqual([{ suiteId: 'a', file: 'a/1.ts' }]);
  });
});

describe('what the result says', () => {
  const cache = (over: object) => ({ mode: 'cached', turn: 3, fingerprints: [], reused: 0, preparationReused: false, wouldSkip: [], mismatches: [], ...over }) as never;
  const part = (failedFiles: object[] | null = null) => ({ failedFiles }) as never;

  it('nothing for a run without reuse', () => {
    expect(reuseLines(null, [part()])).toEqual([]);
  });

  it('how much was reused, and that nothing ran when nothing had to', () => {
    expect(reuseLines(cache({ reused: 540 }), [part()])).toEqual(['540 test files kept their fingerprint and a green result, so they did not run again.']);
    expect(reuseLines(cache({ reused: 559 }), [])).toEqual(['559 test files kept their fingerprint and a green result, so nothing had to run.']);
    expect(reuseLines(cache({ reused: 0 }), [part()])).toEqual([]);
  });

  it('that it was the full run', () => {
    expect(reuseLines(cache({ mode: 'full', turn: 5 }), [part()])).toEqual(['This was the full run of turn 5: nothing was reused.']);
    expect(reuseLines(cache({ mode: 'full', turn: null }), [part()])).toEqual(['This was a full run: nothing was reused.']);
  });

  it('why nothing was reused', () => {
    expect(reuseLines(cache({ mode: 'off' }), [part()])).toEqual(['Nothing was reused: the machine that described this commit sent no fingerprints.']);
  });

  it('what failed by name, and what the cache called green', () => {
    const lines = reuseLines(cache({ mode: 'full', turn: 5, mismatches: [{ suiteId: 'a', file: 'a/1.ts' }] }), [part([{ suiteId: 'a', file: 'a/1.ts' }, { suiteId: 'a', file: 'a/2.ts' }])]);
    expect(lines).toContain('Failed test files: a/1.ts, a/2.ts.');
    expect(lines).toContain('Mismatch with the kept results: a/1.ts was green at this same fingerprint and failed now. Either it depends on something its fingerprint does not see, or it is flaky.');
  });
});
