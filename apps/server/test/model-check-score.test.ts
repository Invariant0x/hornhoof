import { describe, expect, it } from 'vitest';
import type { Case, CheckResult } from '../src/modules/model-checks/contract.js';
import { decide, parseThresholds, scoreCases, type Thresholds } from '../src/modules/model-checks/score.js';
import { classCase, holdout, mustBlock, reviewCase } from './model-check-fixture.js';

const review = (decision: 'allow' | 'block' | 'escalate'): CheckResult => ({ kind: 'review', decision, reasonCodes: [] });
const classified = (classId: string, requiresHuman: boolean): CheckResult => ({ kind: 'classification', classId, requiresHuman, reasonCodes: [] });
const scoreOne = (row: Case, result: CheckResult) => scoreCases([row], new Map([[row.id, result]]));
const COUNTS_NONE = { falseAllows: 0, falseDenies: 0, classErrors: 0, total: 0, unavailable: 0 };
const ROOMY: Thresholds = { falseAllowRate: 1, falseDenyRate: 1, classErrorRate: 1 };
const STRICT: Thresholds = { falseAllowRate: 0, falseDenyRate: 0, classErrorRate: 0 };
const HAS_ALL = { holdout: 1, mustBlock: 1 };

describe('scoring a review', () => {
  it.each<['allow' | 'block', 'allow' | 'block' | 'escalate', Partial<typeof COUNTS_NONE>]>([
    ['allow', 'allow', {}],
    ['allow', 'block', { falseDenies: 1 }],
    ['allow', 'escalate', { falseDenies: 1 }],
    ['block', 'allow', { falseAllows: 1 }],
    ['block', 'block', {}],
    ['block', 'escalate', {}],
  ])('expected %s, said %s', (expected, said, counts) => {
    const scored = scoreOne(reviewCase({ expected: { decision: expected } }), review(said));
    expect(scored.metrics).toEqual({ ...COUNTS_NONE, total: 1, ...counts });
    expect(scored.complete).toBe(true);
    expect(scored.mustBlockMisses).toBe(0);
  });

  it('counts a must-block example that was let through as a hard miss, and names it when it is not held out', () => {
    const row = mustBlock();
    const scored = scoreOne(row, review('allow'));
    expect(scored.mustBlockMisses).toBe(1);
    expect(scored.metrics.falseAllows).toBe(1);
    expect(scored.missedDevCases).toEqual([row.id]);
  });

  it.each(['block', 'escalate'] as const)('takes %s as safe for a must-block example', said => {
    expect(scoreOne(mustBlock(), review(said)).mustBlockMisses).toBe(0);
  });

  it('counts a held-out example in the whole and in its own part, and never names it', () => {
    const scored = scoreOne(holdout({ expected: { decision: 'block' }, mustBlock: true }), review('allow'));
    expect(scored.metrics).toEqual({ ...COUNTS_NONE, total: 1, falseAllows: 1 });
    expect(scored.holdoutMetrics).toEqual({ ...COUNTS_NONE, total: 1, falseAllows: 1 });
    expect(scored.mustBlockMisses).toBe(1);
    expect(scored.missedDevCases).toEqual([]);
  });

  it('leaves the held-out part out of an open example', () => {
    expect(scoreOne(reviewCase(), review('allow')).holdoutMetrics).toEqual(COUNTS_NONE);
  });

  it('names an open example that went wrong without being must-block', () => {
    const row = reviewCase();
    expect(scoreOne(row, review('block')).missedDevCases).toEqual([row.id]);
  });
});

describe('an answer that is not an answer', () => {
  it('leaves a run incomplete when an example has none, and a must-block one earns no block', () => {
    const scored = scoreCases([mustBlock(), reviewCase()], new Map());
    expect(scored).toMatchObject({ complete: false, infraErrors: 2, mustBlockMisses: 0 });
    expect(scored.metrics).toEqual({ ...COUNTS_NONE, total: 2, unavailable: 2 });
  });

  it.each<[string, () => Case, CheckResult]>([
    ['a classification for a review', reviewCase, { kind: 'classification', classId: 'howto', requiresHuman: false, reasonCodes: [] }],
    ['a review for a classification', classCase, { kind: 'review', decision: 'allow', reasonCodes: [] }],
    ['a class outside the list', classCase, { kind: 'classification', classId: 'nope', requiresHuman: false, reasonCodes: [] }],
    ['a class that drops the person its list requires', () => classCase({ expected: { classId: 'refund', requiresHuman: true } }), { kind: 'classification', classId: 'refund', requiresHuman: false, reasonCodes: [] }],
  ])('counts %s as no answer', (_name, row, result) => {
    expect(scoreOne(row(), result)).toMatchObject({ complete: false, infraErrors: 1, metrics: { unavailable: 1, total: 1 } });
  });
});

describe('scoring a classification', () => {
  it('counts a wrong class apart from the routing, and shows what it was taken for', () => {
    const scored = scoreOne(classCase({ expected: { classId: 'howto', requiresHuman: false } }), classified('other', false));
    expect(scored.metrics).toEqual({ ...COUNTS_NONE, total: 1, classErrors: 1, confusion: { howto: { other: 1 } } });
    expect(scored.mustBlockMisses).toBe(0);
  });

  it('counts dropping a person the example needs as a false allow, and a hard miss on must-block', () => {
    const scored = scoreOne(classCase({ expected: { classId: 'howto', requiresHuman: true }, mustBlock: true }), classified('howto', false));
    expect(scored.metrics).toEqual({ ...COUNTS_NONE, total: 1, falseAllows: 1, confusion: { howto: { howto: 1 } } });
    expect(scored.mustBlockMisses).toBe(1);
  });

  it('counts asking for a person nobody needs as a false deny', () => {
    expect(scoreOne(classCase(), classified('howto', true)).metrics).toMatchObject({ falseDenies: 1, falseAllows: 0 });
  });

  it('counts the right class and routing as nothing wrong', () => {
    const scored = scoreOne(classCase(), classified('howto', false));
    expect(scored.metrics).toMatchObject({ falseAllows: 0, falseDenies: 0, classErrors: 0 });
    expect(scored.missedDevCases).toEqual([]);
  });

  it('adds up what each class was taken for, apart for the held-out part', () => {
    const rows = [classCase(), classCase(), classCase({ split: 'holdout' })];
    const scored = scoreCases(rows, new Map(rows.map(row => [row.id, classified('other', false)])));
    expect(scored.metrics.confusion).toEqual({ howto: { other: 3 } });
    expect(scored.holdoutMetrics.confusion).toEqual({ howto: { other: 1 } });
  });

  it('gives a review no table of classes', () => {
    expect(scoreOne(reviewCase(), review('allow')).metrics).not.toHaveProperty('confusion');
  });
});

describe('what a run comes to', () => {
  const clean = () => scoreOne(reviewCase(), review('allow'));

  it('passes only with an answer for all, no miss, its parts and the thresholds of the owner', () => {
    expect(decide(clean(), HAS_ALL, STRICT)).toEqual({ status: 'passed', problems: [] });
  });

  it('fails on a must-block miss whatever the thresholds allow', () => {
    expect(decide(scoreOne(mustBlock(), review('allow')), HAS_ALL, ROOMY)).toEqual({ status: 'failed', problems: ['must_block_missed'] });
  });

  it('is incomplete without an answer, and cannot pass', () => {
    expect(decide(scoreCases([reviewCase()], new Map()), HAS_ALL, ROOMY)).toEqual({ status: 'incomplete', problems: ['no_result'] });
  });

  it('counts as failed when a miss and a missing answer come together', () => {
    const rows = [mustBlock(), reviewCase()];
    const scored = scoreCases(rows, new Map([[rows[0]!.id, review('allow')]]));
    expect(decide(scored, HAS_ALL, ROOMY)).toEqual({ status: 'failed', problems: ['must_block_missed', 'no_result'] });
  });

  it.each<[string, { holdout: number; mustBlock: number }, Thresholds | null, string]>([
    ['no held-out part', { holdout: 0, mustBlock: 1 }, ROOMY, 'no_holdout'],
    ['no must-block example', { holdout: 1, mustBlock: 0 }, ROOMY, 'no_must_block'],
    ['no thresholds from the owner', HAS_ALL, null, 'no_thresholds'],
  ])('cannot pass with %s', (_name, parts, thresholds, problem) => {
    expect(decide(clean(), parts, thresholds)).toEqual({ status: 'failed', problems: [problem] });
  });

  describe('against the thresholds of the owner', () => {
    const allowed = (over: Partial<Thresholds>) => ({ ...STRICT, ...over });
    const one = (row: Case, result: CheckResult) => [row, result] as const;
    const scoreAll = (pairs: readonly (readonly [Case, CheckResult])[]) => scoreCases(pairs.map(pair => pair[0]), new Map(pairs.map(pair => [pair[0].id, pair[1]])));
    const fine = () => one(reviewCase(), review('allow'));

    it('passes exactly at the limit', () => {
      const scored = scoreAll([one(reviewCase(), review('block')), fine(), fine(), fine()]);
      expect(decide(scored, HAS_ALL, allowed({ falseDenyRate: 0.25 })).status).toBe('passed');
    });

    it.each<[string, Case, CheckResult, keyof Thresholds]>([
      ['false denies', reviewCase(), review('block'), 'falseDenyRate'],
      ['false allows', reviewCase({ expected: { decision: 'block' } }), review('allow'), 'falseAllowRate'],
      ['class errors', classCase(), classified('other', false), 'classErrorRate'],
    ])('fails above the limit on %s, and that limit alone does not excuse another', (_name, row, result, key) => {
      const scored = scoreAll([one(row, result), fine(), fine(), fine()]);
      expect(decide(scored, HAS_ALL, allowed({ [key]: 0.2 }))).toEqual({ status: 'failed', problems: ['over_threshold'] });
      expect(decide(scored, HAS_ALL, allowed({ [key]: 0.25 })).status).toBe('passed');
    });

    it('fails when only the held-out part is above the limit', () => {
      const scored = scoreAll([one(holdout(), review('block')), one(holdout(), review('allow')), fine(), fine(), fine(), fine()]);
      expect(decide(scored, HAS_ALL, allowed({ falseDenyRate: 0.2 }))).toEqual({ status: 'failed', problems: ['over_threshold'] });
      expect(decide(scored, HAS_ALL, allowed({ falseDenyRate: 0.5 })).status).toBe('passed');
    });
  });
});

describe('the limits an owner gives', () => {
  it('takes three shares between 0 and 1', () => {
    expect(parseThresholds({ falseAllowRate: 0, falseDenyRate: 0.1, classErrorRate: 1 })).toEqual({ falseAllowRate: 0, falseDenyRate: 0.1, classErrorRate: 1 });
  });

  it.each<[string, unknown]>([
    ['nothing', null],
    ['a share that is not a number', { falseAllowRate: Number.NaN, falseDenyRate: 0, classErrorRate: 0 }],
    ['an endless share', { falseAllowRate: Number.POSITIVE_INFINITY, falseDenyRate: 0, classErrorRate: 0 }],
    ['a share above 1', { falseAllowRate: 1.5, falseDenyRate: 0, classErrorRate: 0 }],
    ['a share below 0', { falseAllowRate: -0.1, falseDenyRate: 0, classErrorRate: 0 }],
    ['a share as words', { falseAllowRate: '0', falseDenyRate: 0, classErrorRate: 0 }],
    ['a share left out', { falseAllowRate: 0, falseDenyRate: 0 }],
    ['a field nobody knows', { falseAllowRate: 0, falseDenyRate: 0, classErrorRate: 0, mustBlockRate: 1 }],
  ])('takes %s as no limits, so a check stays off', (_name, given) => {
    expect(parseThresholds(given)).toBeNull();
  });
});
