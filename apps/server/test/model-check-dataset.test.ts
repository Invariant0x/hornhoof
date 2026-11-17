import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Case } from '@hornhoof/protocol';
import { parseDataset, withLiveMiss, type Dataset } from '../src/modules/model-checks/dataset.js';
import { AUTHOR, CLASS_RULES, LABELLER, RULES, TAXONOMY, asJsonl, classCase, holdout, mustBlock, reviewCase } from './model-check-fixture.js';

const parsed = (raw: Buffer, rules = RULES): Dataset => {
  const result = parseDataset(raw, rules);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.dataset;
};
const problemsOf = (raw: Buffer, rules = RULES) => {
  const result = parseDataset(raw, rules);
  return result.ok ? [] : result.problems;
};
const withExtra = (row: Case, extra: Record<string, unknown>) => ({ ...row, ...extra });

describe('a set of examples', () => {
  it('reads each line, hashes the very bytes, and counts what a run needs', () => {
    const raw = asJsonl([reviewCase(), holdout(), mustBlock()]);
    const dataset = parsed(raw);
    expect(dataset.cases).toHaveLength(3);
    expect(dataset.hash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(dataset.holdout).toBe(1);
    expect(dataset.mustBlock).toBe(1);
  });

  it('takes a file with no last line break, as another version with its own hash', () => {
    const raw = asJsonl([reviewCase()]);
    const without = raw.subarray(0, raw.length - 1);
    expect(parsed(without).cases).toHaveLength(1);
    expect(parsed(without).hash).not.toBe(parsed(raw).hash);
  });

  describe('refuses the whole set, and names the line', () => {
    it.each<[string, () => unknown, string]>([
      ['a field nobody knows', () => withExtra(reviewCase(), { tuned: true }), 'invalid_case'],
      ['a case with no label', () => withExtra(reviewCase(), { labelledBy: undefined }), 'invalid_case'],
      ['a time that is no time', () => withExtra(reviewCase(), { labelledAt: 'yesterday' }), 'invalid_case'],
      ['a split nobody knows', () => withExtra(reviewCase(), { split: 'train' }), 'invalid_case'],
      ['an example of another kind of check', () => reviewCase({ kind: 'support_reply_review' }), 'wrong_kind'],
      ['an input of another kind', () => reviewCase({ input: classCase().input }), 'input_kind'],
      ['a class expected of a review', () => reviewCase({ expected: { classId: 'howto', requiresHuman: false } }), 'expected_form'],
      ['must block that expects allow', () => reviewCase({ mustBlock: true }), 'must_block_expected'],
      ['an example labelled by the author of the check', () => reviewCase({ labelledBy: AUTHOR }), 'self_labelled'],
    ])('%s', (_name, row, code) => {
      expect(problemsOf(asJsonl([reviewCase(), row()]))).toEqual([{ line: 2, code }]);
    });

    it.each<[string, Partial<Case>, string]>([
      ['a decision expected of a classification', { expected: { decision: 'allow' } }, 'expected_form'],
      ['must block that needs no person', { mustBlock: true }, 'must_block_expected'],
      ['a class outside its list', { expected: { classId: 'nope', requiresHuman: false } }, 'class_unknown'],
      ['a class that weakens its list by needing no person', { expected: { classId: 'refund', requiresHuman: false } }, 'expected_weaker'],
    ])('%s', (_name, more, code) => {
      expect(problemsOf(asJsonl([classCase(more)]), CLASS_RULES)).toEqual([{ line: 1, code }]);
    });

    it('two examples with one id', () => {
      const row = reviewCase();
      expect(problemsOf(asJsonl([row, reviewCase(), row]))).toEqual([{ line: 3, code: 'duplicate_id' }]);
    });

    it('a line that is not JSON', () => {
      expect(problemsOf(Buffer.from('{not json}\n'))).toEqual([{ line: 1, code: 'not_json' }]);
    });

    it('an empty line between examples', () => {
      const raw = Buffer.concat([asJsonl([reviewCase()]), Buffer.from('\n'), asJsonl([reviewCase()])]);
      expect(problemsOf(raw)).toEqual([{ line: 2, code: 'empty_line' }]);
    });

    it('bytes that are not UTF-8', () => {
      expect(problemsOf(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).toEqual([{ line: 0, code: 'not_utf8' }]);
    });

    it.each([['nothing', ''], ['only a line break', '\n']])('%s', (_name, text) => {
      expect(problemsOf(Buffer.from(text))).toEqual([{ line: 0, code: 'empty' }]);
    });

    it('every bad line at once', () => {
      expect(problemsOf(asJsonl([reviewCase({ labelledBy: AUTHOR }), reviewCase(), reviewCase({ mustBlock: true })]))).toEqual([{ line: 1, code: 'self_labelled' }, { line: 3, code: 'must_block_expected' }]);
    });
  });

  it('does not take a person for an agent who has the same id', () => {
    const sameId = { kind: 'person' as const, id: AUTHOR.id };
    expect(problemsOf(asJsonl([reviewCase({ labelledBy: sameId })]))).toEqual([]);
  });

  it('takes a classification that asks for a person where its list does not', () => {
    expect(parsed(asJsonl([classCase({ expected: { classId: 'howto', requiresHuman: true }, mustBlock: true })]), CLASS_RULES).mustBlock).toBe(1);
  });

  it('keeps the whole list of classes for a classification', () => {
    const [row] = parsed(asJsonl([classCase()]), CLASS_RULES).cases;
    expect(row!.input).toMatchObject({ taxonomy: TAXONOMY });
  });

  describe('a miss found in real work', () => {
    const miss = (more: Partial<Case> = {}) => mustBlock({ sourceIncidentId: randomUUID(), labelledBy: LABELLER, ...more });
    const missOf = (raw: Buffer, row: Case) => {
      const result = withLiveMiss(raw, row, RULES);
      if (!result.ok) throw new Error(JSON.stringify(result.problems));
      return result;
    };

    it('becomes one more line, and every earlier byte stays', () => {
      const raw = asJsonl([reviewCase(), holdout()]);
      const row = miss();
      const added = missOf(raw, row);
      expect(added.raw.subarray(0, raw.length).equals(raw)).toBe(true);
      expect(added.dataset.cases.at(-1)!.id).toBe(row.id);
      expect(added.dataset.hash).not.toBe(parsed(raw).hash);
    });

    it('adds to a file whose last line has no line break', () => {
      const raw = asJsonl([reviewCase()]);
      expect(missOf(raw.subarray(0, raw.length - 1), miss()).dataset.cases).toHaveLength(2);
    });

    it('needs the incident it came from', () => {
      expect(withLiveMiss(asJsonl([reviewCase()]), miss({ sourceIncidentId: null }), RULES)).toEqual({ ok: false, problems: [{ line: 2, code: 'no_incident' }] });
    });

    it('cannot be labelled by the author of the check', () => {
      expect(withLiveMiss(asJsonl([reviewCase()]), miss({ labelledBy: AUTHOR }), RULES)).toEqual({ ok: false, problems: [{ line: 2, code: 'self_labelled' }] });
    });

    it('cannot repeat an example', () => {
      const row = reviewCase();
      expect(withLiveMiss(asJsonl([row]), miss({ id: row.id }), RULES)).toEqual({ ok: false, problems: [{ line: 2, code: 'duplicate_id' }] });
    });
  });
});
