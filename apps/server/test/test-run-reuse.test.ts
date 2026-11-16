import type { TestUnit } from '@hornhoof/protocol';
import { PREPARATION_UNIT } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { decideReuse, partFileResults, reuseLines } from '../src/modules/testruns/reuse.js';

describe('what a result came to', () => {
  it('stays with the green file and is shown with the run', () => {
    const snapshot = {} as never, batch = { kind: 'suite', suiteId: 'a', files: ['a/1.ts'] } as never;
    expect(partFileResults(snapshot, batch, true, [{ suiteId: 'a', file: 'a/1.ts', status: 'passed', note: '2 killed, 7 survived' }]).green).toEqual([{ suiteId: 'a', file: 'a/1.ts', note: '2 killed, 7 survived' }]);
    expect(reuseLines({ mode: 'cached', release: 'turn-1', fingerprints: [], reused: 0, preparationReused: false, wouldSkip: [], compared: 0, mismatches: [], notes: [{ file: 'a/1.ts', note: '2 killed, 7 survived' }, { file: 'a/2.ts', note: 'all killed' }] }, [])).toEqual(['Notes on test files: a/1.ts: 2 killed, 7 survived; a/2.ts: all killed.']);
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

  it('that names a file twice, as two projects of a suite may run it: one failure is a failure', () => {
    for (const files of [[{ suiteId: 'a', file: 'a/1.ts', status: 'failed' }, { suiteId: 'a', file: 'a/1.ts', status: 'passed' }], [{ suiteId: 'a', file: 'a/1.ts', status: 'passed' }, { suiteId: 'a', file: 'a/1.ts', status: 'failed' }]]) {
      expect(partFileResults(snapshot, batch, false, files as never)).toEqual({ green: [], failed: [{ suiteId: 'a', file: 'a/1.ts' }] });
      expect(partFileResults(snapshot, batch, true, files as never).green).toEqual([{ suiteId: 'a', file: 'a/2.ts' }]);
    }
  });

  it('that prepared: its suites and the preparation itself are green only when it passed', () => {
    expect(partFileResults(snapshot, prepare, true, undefined).green).toEqual([PREPARATION_UNIT, { suiteId: 'a', file: 'a/1.ts' }, { suiteId: 'a', file: 'a/2.ts' }]);
    const files = [{ suiteId: 'a', file: 'a/1.ts', status: 'passed' }] as never;
    expect(partFileResults(snapshot, prepare, false, files).green).toEqual([{ suiteId: 'a', file: 'a/1.ts' }]);
  });
});

describe('what the result says', () => {
  const cache = (over: object) => ({ mode: 'cached', release: 'turn-3', fingerprints: [], reused: 0, preparationReused: false, wouldSkip: [], compared: 0, mismatches: [], notes: [], ...over }) as never;
  const part = (failedFiles: object[] | null = null) => ({ failedFiles }) as never;

  it('nothing for a run without reuse', () => {
    expect(reuseLines(null, [part()])).toEqual([]);
  });

  it('how much was reused, and that nothing ran when nothing had to', () => {
    expect(reuseLines(cache({ reused: 540 }), [part()])).toEqual(['540 test files kept their fingerprint and a green result, so they did not run again.']);
    expect(reuseLines(cache({ reused: 559 }), [])).toEqual(['559 test files kept their fingerprint and a green result, so nothing had to run.']);
    expect(reuseLines(cache({ reused: 0 }), [part()])).toEqual([]);
  });

  it('that it was the first run of its release, or a full run from before releases were kept', () => {
    expect(reuseLines(cache({ mode: 'full', release: 'turn-5' }), [part()])).toEqual(['This was the first run of release turn-5: every test file ran, nothing was reused.']);
    expect(reuseLines(cache({ mode: 'full', release: undefined }), [part()])).toEqual(['This was a full run: nothing was reused.']);
  });

  it('why nothing was reused', () => {
    expect(reuseLines(cache({ mode: 'off' }), [part()])).toEqual(['Nothing was reused: the machine that described this commit sent no fingerprints.']);
  });

  it('what failed by name, and what the cache called green', () => {
    const lines = reuseLines(cache({ mode: 'full', release: 'turn-5', mismatches: [{ suiteId: 'a', file: 'a/1.ts' }] }), [part([{ suiteId: 'a', file: 'a/1.ts' }, { suiteId: 'a', file: 'a/2.ts' }])]);
    expect(lines).toContain('Failed test files: a/1.ts, a/2.ts.');
    expect(lines).toContain('Mismatch with the kept results: a/1.ts was green at this same fingerprint and failed now. Either it depends on something its fingerprint does not see, or it is flaky.');
  });
});
