import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Case, CheckBinding, CheckInput, CheckReceipt } from '@hornhoof/protocol';
import { parseDataset } from '../src/modules/model-checks/dataset.js';
import { afterRun, bindingDigest } from '../src/modules/model-checks/lifecycle.js';
import { evaluateCheck, NO_MODEL_YET, reportText, type RunModelCheck } from '../src/modules/model-checks/run.js';
import type { Thresholds } from '../src/modules/model-checks/score.js';
import { RULES, asJsonl, binding, holdout, mustBlock, reviewCase } from './model-check-fixture.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const ids = { reportId: randomUUID(), now: NOW };
const THRESHOLDS: Thresholds = { falseAllowRate: 0, falseDenyRate: 0, classErrorRate: 0 };
const datasetOf = (rows: Case[]) => {
  const result = parseDataset(asJsonl(rows), RULES);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.dataset;
};
const subjectOf = (input: CheckInput) => input.subject.contentDigest;
const receipt = (given: CheckBinding, input: CheckInput, decision: 'allow' | 'block' | 'escalate', more: Partial<CheckReceipt> = {}): CheckReceipt => ({
  schemaVersion: 1, checkId: given.checkId, bindingDigest: bindingDigest(given), subjectDigest: subjectOf(input), reviewer: given.model, result: { kind: 'review', decision, reasonCodes: ['uncertain'] }, ...more,
});
const expectedDecision = (row: Case) => ('decision' in row.expected ? row.expected.decision : 'allow');

/* A model that answers each example the way the labeller did, except for the examples named as wrong. */
function modelFor(rows: Case[], wrong: Record<string, 'allow' | 'block' | 'escalate'> = {}): RunModelCheck {
  const byDigest = new Map(rows.map(row => [row.input.subject.id, row]));
  return async (given, input) => {
    const row = byDigest.get(input.subject.id)!;
    return receipt(given, input, wrong[row.id] ?? expectedDecision(row));
  };
}
const SET = () => [reviewCase(), mustBlock(), holdout(), holdout({ expected: { decision: 'block' }, mustBlock: true })];

describe('a run of a set of examples', () => {
  it('asks the model once for each example with its binding, and passes when all come out right', async () => {
    const rows = SET();
    const given = binding();
    const call = vi.fn(modelFor(rows));
    const done = await evaluateCheck(given, datasetOf(rows), THRESHOLDS, call, ids);
    expect(call).toHaveBeenCalledTimes(4);
    expect(call.mock.calls.map(args => args[0])).toEqual([given, given, given, given]);
    expect(call.mock.calls.map(args => args[1])).toEqual(rows.map(row => row.input));
    expect(done.decision).toEqual({ status: 'passed', problems: [] });
    expect(done.evaluation).toMatchObject({ bindingDigest: bindingDigest(given), reportId: ids.reportId, datasetHash: datasetOf(rows).hash, complete: true, infraErrors: 0, mustBlockMisses: 0, evaluatedAt: NOW.toISOString() });
  });

  it('is incomplete with no model port, and no check can turn on from it', async () => {
    const given = binding();
    const done = await evaluateCheck(given, datasetOf(SET()), THRESHOLDS, NO_MODEL_YET, ids);
    expect(done.decision).toEqual({ status: 'incomplete', problems: ['no_result'] });
    expect(done.evaluation).toMatchObject({ complete: false, infraErrors: 4 });
    const after = afterRun({ status: 'off', bindingDigest: bindingDigest(given), validUntil: null }, done.evaluation, done.decision, NOW);
    expect(after.state.status).toBe('off');
    expect(after.signal).not.toBeNull();
  });

  it('turns a check off and signals when a must-block example was let through', async () => {
    const rows = SET();
    const given = binding();
    const done = await evaluateCheck(given, datasetOf(rows), THRESHOLDS, modelFor(rows, { [rows[1]!.id]: 'allow' }), ids);
    expect(done.decision.status).toBe('failed');
    const after = afterRun({ status: 'on', bindingDigest: bindingDigest(given), validUntil: new Date(NOW.getTime() + 1) }, done.evaluation, done.decision, NOW);
    expect(after.state.status).toBe('off');
    expect(after.signal!.problems).toContain('must_block_missed');
  });

  it('takes a model that throws as no answer, and goes on with the rest', async () => {
    const rows = SET();
    const model = modelFor(rows);
    const call: RunModelCheck = async (given, input) => {
      if (input.subject.id === rows[0]!.input.subject.id) throw new Error('secret-looking text from a provider');
      return model(given, input);
    };
    const done = await evaluateCheck(binding(), datasetOf(rows), THRESHOLDS, call, ids);
    expect(done.evaluation).toMatchObject({ complete: false, infraErrors: 1 });
    expect(JSON.stringify(done)).not.toContain('secret-looking');
  });

  it.each<[string, (given: CheckBinding, input: CheckInput) => unknown]>([
    ['another binding', (given, input) => receipt(given, input, 'block', { bindingDigest: 'a'.repeat(64) })],
    ['another example', (given, input) => receipt(given, input, 'block', { subjectDigest: 'a'.repeat(64) })],
    ['another check', (given, input) => receipt(given, input, 'block', { checkId: randomUUID() })],
    ['a field nobody knows', (given, input) => ({ ...receipt(given, input, 'block'), extra: true })],
    ['nothing useful', () => ({ decision: 'block' })],
    ['a reviewer other than the bound model', (given, input) => receipt(given, input, 'block', { reviewer: { ...given.model, modelId: 'other' } })],
    ['no result of its kind', (given, input) => receipt(given, input, 'block', { result: { kind: 'classification', classId: 'x', requiresHuman: true, reasonCodes: [] } })],
    ['the code of a refusal', () => ({ kind: 'unavailable', code: 'vendor_conflict' })],
  ])('takes an answer about %s as no answer, so a claim of a block earns nothing', async (_name, answer) => {
    const rows = [mustBlock()];
    const call = (async (given: CheckBinding, input: CheckInput) => answer(given, input)) as RunModelCheck;
    const done = await evaluateCheck(binding(), datasetOf(rows), THRESHOLDS, call, ids);
    expect(done.evaluation).toMatchObject({ complete: false, infraErrors: 1, mustBlockMisses: 0 });
    expect(done.decision.status).toBe('incomplete');
  });
});

describe('the report of a run', () => {
  const failing = async () => {
    const open = reviewCase();
    const denied = reviewCase();
    const hidden = holdout({ expected: { decision: 'block' }, mustBlock: true, input: { ...reviewCase().input, message: { subject: null, body: 'held out words' } } as CheckInput });
    const rows = [open, denied, hidden, mustBlock({ split: 'holdout' })];
    const done = await evaluateCheck(binding(), datasetOf(rows), THRESHOLDS, modelFor(rows, { [denied.id]: 'block', [hidden.id]: 'allow' }), ids);
    return { ...done, denied, hidden };
  };

  it('shows false yes and false no apart, and the held-out part on its own', async () => {
    const { report } = await failing();
    expect(report.all).toEqual({ falseAllows: 1, falseDenies: 1, classErrors: 0, total: 4, unavailable: 0 });
    expect(report.holdout).toEqual({ falseAllows: 1, falseDenies: 0, classErrors: 0, total: 2, unavailable: 0 });
    expect(report).toMatchObject({ status: 'failed', mustBlockMisses: 1, infraErrors: 0 });
  });

  it('names an open example that went wrong, and tells nothing of what is held out but its counts', async () => {
    const { report, denied, hidden } = await failing();
    expect(report.missedDevCases).toEqual([denied.id]);
    const text = JSON.stringify(report);
    expect(text).not.toContain(hidden.id);
    expect(text).not.toContain('held out words');
  });

  it('keeps the words of the examples out of the record of the run', async () => {
    const { evaluation } = await failing();
    expect(JSON.stringify(evaluation)).not.toContain('Words only a test holds');
    expect(JSON.stringify(evaluation)).not.toContain('missedDevCases');
  });

  it('says it in plain words with both counts of each part, and no words of an example', async () => {
    const { report } = await failing();
    const text = reportText(report);
    expect(text).toContain('Must-block examples let through: 1');
    expect(text).toContain('All 4 examples: 1 false yes, 1 false no, 0 wrong classes, 0 without an answer');
    expect(text).toContain('Held-out 2 examples: 1 false yes, 0 false no, 0 wrong classes, 0 without an answer');
    expect(text).not.toContain('Words only a test holds');
  });
});
