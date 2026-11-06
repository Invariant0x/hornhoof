import { describe, expect, it } from 'vitest';
import type { CheckBinding } from '../src/modules/model-checks/contract.js';
import { afterChange, afterRun, bindingDigest, isOn, weeklyRun, type BindingPart, type CheckState } from '../src/modules/model-checks/lifecycle.js';
import type { Decision } from '../src/modules/model-checks/score.js';
import { binding, hashOf } from './model-check-fixture.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const WEEK_MS = 7 * 24 * 3_600_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const PASSED: Decision = { status: 'passed', problems: [] };
const MISSED: Decision = { status: 'failed', problems: ['must_block_missed'] };
const NO_MODEL: Decision = { status: 'incomplete', problems: ['no_result'] };
const off = (digest: string | null = null): CheckState => ({ status: 'off', bindingDigest: digest, validUntil: null });
const on = (digest: string, validUntil = later(WEEK_MS)): CheckState => ({ status: 'on', bindingDigest: digest, validUntil });

describe('the digest of a check', () => {
  it('does not depend on the order of keys', () => {
    const given = binding();
    const reordered = Object.fromEntries(Object.entries(given).reverse()) as CheckBinding;
    expect(bindingDigest(reordered)).toBe(bindingDigest(given));
    expect(bindingDigest(given)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with a nested value', () => {
    const given = binding();
    expect(bindingDigest({ ...given, model: { ...given.model, revisionId: 'rev-2' } })).not.toBe(bindingDigest(given));
  });
});

describe('a change of the check', () => {
  const base = binding();
  const changes: [BindingPart, Partial<CheckBinding>][] = [
    ['code', { checkerCodeHash: hashOf('other') }],
    ['prompt', { promptHash: hashOf('other') }],
    ['output_schema', { outputSchemaHash: hashOf('other') }],
    ['list', { sourceListHash: hashOf('other') }],
    ['taxonomy', { taxonomyHash: hashOf('other') }],
    ['model', { model: { ...base.model, modelId: 'model-c' } }],
    ['dataset', { datasetVersion: '11111111-1111-4111-8111-111111111111' }],
    ['dataset', { datasetHash: hashOf('other') }],
    ['thresholds', { thresholdsHash: hashOf('other') }],
    ['scope', { departmentId: '22222222-2222-4222-8222-222222222222' }],
  ];

  it.each(changes)('in its %s turns it off and starts a run', (part, change) => {
    const next = { ...base, ...change };
    const done = afterChange(base, next, NOW)!;
    expect(done.state).toEqual({ status: 'off', bindingDigest: bindingDigest(next), validUntil: null });
    expect(done.run).toMatchObject({ bindingDigest: bindingDigest(next), trigger: 'change', parts: [part] });
  });

  it('names every part that changed', () => {
    expect(afterChange(base, { ...base, promptHash: hashOf('other'), sourceListHash: hashOf('other') }, NOW)!.run.parts).toEqual(['prompt', 'list']);
  });

  it('starts nothing when nothing changed', () => {
    expect(afterChange(base, { ...base }, NOW)).toBeNull();
  });

  it('starts the first run of a new check, and it stays off', () => {
    expect(afterChange(null, base, NOW)).toMatchObject({ state: { status: 'off' }, run: { trigger: 'change', parts: ['code', 'prompt', 'output_schema', 'list', 'taxonomy', 'model', 'dataset', 'thresholds', 'scope'] } });
  });

  it('gives a change back to an earlier value a run of its own', () => {
    const next = { ...base, thresholdsHash: hashOf('other') };
    const first = afterChange(base, next, NOW)!;
    const again = afterChange(base, next, later(2))!;
    expect(again.run.bindingDigest).toBe(first.run.bindingDigest);
    expect(again.run.dedupKey).not.toBe(first.run.dedupKey);
  });
});

describe('the end of a run', () => {
  const digest = bindingDigest(binding());
  const ran = { bindingDigest: digest };

  it('turns a passed check on for the coming week', () => {
    const done = afterRun(off(digest), ran, PASSED, NOW);
    expect(done).toEqual({ state: { status: 'on', bindingDigest: digest, validUntil: later(WEEK_MS) }, signal: null });
    expect(isOn(done.state, later(WEEK_MS - 1))).toBe(true);
  });

  it('turns a check off on a must-block miss, and sends a signal', () => {
    const done = afterRun(on(digest), ran, MISSED, NOW);
    expect(done.state).toEqual({ status: 'off', bindingDigest: digest, validUntil: null });
    expect(done.signal).toEqual({ dedupKey: `${digest}:must_block_missed`, problems: ['must_block_missed'] });
    expect(isOn(done.state, NOW)).toBe(false);
  });

  it('does not turn a check on after a run with no model, and says so', () => {
    const done = afterRun(off(digest), ran, NO_MODEL, NOW);
    expect(done.state.status).toBe('off');
    expect(done.signal!.problems).toEqual(['no_result']);
  });

  it('turns a check off when its weekly run has no answer', () => {
    expect(afterRun(on(digest), ran, NO_MODEL, NOW).state.status).toBe('off');
  });

  it('sends the same signal for the same failure, so a repeat of it is one signal', () => {
    expect(afterRun(off(digest), ran, MISSED, NOW).signal).toEqual(afterRun(off(digest), ran, MISSED, later(WEEK_MS)).signal);
  });

  it('sends a new signal for another failure', () => {
    expect(afterRun(off(digest), ran, MISSED, NOW).signal!.dedupKey).not.toBe(afterRun(off(digest), ran, NO_MODEL, NOW).signal!.dedupKey);
  });

  it.each<[string, Decision]>([['pass', PASSED], ['failure', MISSED]])('takes no %s of a run for what has changed since it began', (_name, decision) => {
    const state = off(hashOf('newer'));
    expect(afterRun(state, ran, decision, NOW)).toEqual({ state, signal: null });
  });
});

describe('whether a check is on', () => {
  const digest = bindingDigest(binding());

  it('ends with its week, without any run', () => {
    const state = on(digest, later(WEEK_MS));
    expect(isOn(state, later(WEEK_MS - 1))).toBe(true);
    expect(isOn(state, later(WEEK_MS))).toBe(false);
  });

  it('is never on when off, or with no end set', () => {
    expect(isOn(off(digest), NOW)).toBe(false);
    expect(isOn({ status: 'on', bindingDigest: digest, validUntil: null }, NOW)).toBe(false);
  });
});

describe('the weekly run', () => {
  const digest = bindingDigest(binding());
  const state = on(digest);
  const weekAgo = later(-WEEK_MS);

  it('is due after a week while the department has work', () => {
    expect(weeklyRun(state, weekAgo, true, NOW)).toMatchObject({ bindingDigest: digest, trigger: 'weekly', parts: [], dedupKey: `weekly:${digest}:2026-W45` });
  });

  it('is not due in a department with no work', () => {
    expect(weeklyRun(state, weekAgo, false, NOW)).toBeNull();
  });

  it('is not due before a week has passed', () => {
    expect(weeklyRun(state, later(1 - WEEK_MS), true, NOW)).toBeNull();
  });

  it('is due for a check that never ran, once there is work', () => {
    expect(weeklyRun(off(digest), null, true, NOW)?.trigger).toBe('weekly');
    expect(weeklyRun(off(digest), null, false, NOW)).toBeNull();
  });

  it('is due when work comes back after a quiet time, as the check expired', () => {
    const quiet = later(30 * 24 * 3_600_000);
    expect(isOn(state, quiet)).toBe(false);
    expect(weeklyRun(state, weekAgo, false, quiet)).toBeNull();
    expect(weeklyRun(state, weekAgo, true, quiet)?.trigger).toBe('weekly');
  });

  it('cannot run for a check nothing was ever bound to', () => {
    expect(weeklyRun(off(), null, true, NOW)).toBeNull();
  });

  it('keeps one key through a week and takes a new one the next', () => {
    const friday = weeklyRun(state, weekAgo, true, new Date('2026-11-06T12:00:00.000Z'))!;
    const sunday = weeklyRun(state, weekAgo, true, new Date('2026-11-08T23:59:59.000Z'))!;
    const monday = weeklyRun(state, weekAgo, true, new Date('2026-11-09T00:00:00.000Z'))!;
    expect(sunday.dedupKey).toBe(friday.dedupKey);
    expect(monday.dedupKey).not.toBe(friday.dedupKey);
  });

  it('counts the first days of January in the week they belong to', () => {
    expect(weeklyRun(state, weekAgo, true, new Date('2027-01-01T12:00:00.000Z'))!.dedupKey).toBe(`weekly:${digest}:2026-W53`);
  });
});
