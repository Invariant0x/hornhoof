import { describe, expect, it } from 'vitest';
import { APPROVAL_CHANNELS, ApprovalRule, approvalNeeded, DEFAULT_APPROVAL_RULE, kindKey, ruleOf } from '../src/approval-policy.js';

const work = (extra: { amount?: number | null; known?: boolean } = {}) => ({ amount: null, known: false, ...extra });

describe('approvalNeeded', () => {
  it('asks every time in the mode that wants each one, whatever was approved before and however small', () => {
    expect(approvalNeeded({ mode: 'every' }, work({ known: true, amount: 0 }))).toBe(true);
  });

  it('asks only for a kind nobody approved yet in the mode of new kinds', () => {
    expect(approvalNeeded({ mode: 'new_kinds' }, work({ known: false }))).toBe(true);
    expect(approvalNeeded({ mode: 'new_kinds' }, work({ known: true }))).toBe(false);
  });

  it('passes up to the limit and asks above it, in the mode of limits', () => {
    const rule = { mode: 'within_limits', limit: 100 } as const;
    expect(approvalNeeded(rule, work({ amount: 99.5 }))).toBe(false);
    expect(approvalNeeded(rule, work({ amount: 100 }))).toBe(false);
    expect(approvalNeeded(rule, work({ amount: 100.01 }))).toBe(true);
  });

  it('asks in the mode of limits when the work does not say how much, so nothing passes unmeasured', () => {
    expect(approvalNeeded({ mode: 'within_limits', limit: 100 }, work({ amount: null, known: true }))).toBe(true);
  });
});

describe('ApprovalRule', () => {
  it('keeps the three modes, with a limit only in the mode of limits', () => {
    expect(ApprovalRule.parse({ mode: 'every' })).toEqual({ mode: 'every' });
    expect(ApprovalRule.parse({ mode: 'new_kinds' })).toEqual({ mode: 'new_kinds' });
    expect(ApprovalRule.parse({ mode: 'within_limits', limit: 5, unit: ' USD ' })).toEqual({ mode: 'within_limits', limit: 5, unit: 'USD' });
  });

  it('refuses a mode of limits without a limit, a limit below zero, and a limit on another mode', () => {
    expect(ApprovalRule.safeParse({ mode: 'within_limits' }).success).toBe(false);
    expect(ApprovalRule.safeParse({ mode: 'within_limits', limit: -1 }).success).toBe(false);
    expect(ApprovalRule.safeParse({ mode: 'every', limit: 5 }).success).toBe(false);
    expect(ApprovalRule.safeParse({ mode: 'anything' }).success).toBe(false);
  });
});

describe('ruleOf', () => {
  it('asks for new kinds by default, so an approved kind does not ask each time', () => {
    expect(DEFAULT_APPROVAL_RULE).toEqual({ mode: 'new_kinds' });
    expect(approvalNeeded(ruleOf(undefined), work({ known: false }))).toBe(true);
    expect(approvalNeeded(ruleOf(undefined), work({ known: true }))).toBe(false);
  });

  it('reads what is stored, and never reads a stored mode of limits with no limit as no limit at all', () => {
    expect(ruleOf({ mode: 'every', limitAmount: null, limitUnit: null })).toEqual({ mode: 'every' });
    expect(ruleOf({ mode: 'new_kinds', limitAmount: null, limitUnit: null })).toEqual({ mode: 'new_kinds' });
    expect(ruleOf({ mode: 'within_limits', limitAmount: 7, limitUnit: 'USD' })).toEqual({ mode: 'within_limits', limit: 7, unit: 'USD' });
    expect(ruleOf({ mode: 'within_limits', limitAmount: 7, limitUnit: null })).toEqual({ mode: 'within_limits', limit: 7 });
    expect(ruleOf({ mode: 'within_limits', limitAmount: null, limitUnit: null })).toEqual({ mode: 'every' });
  });
});

describe('the channels and kinds', () => {
  it('names what the company asked for, and a channel for all the rest', () => {
    expect(APPROVAL_CHANNELS).toEqual(['message', 'price', 'publication', 'commit', 'spend', 'other']);
  });

  it('counts a kind as the same however it is typed', () => {
    expect(kindKey('  Welcome   Email ')).toBe('welcome email');
    expect(kindKey('WELCOME EMAIL')).toBe(kindKey('welcome email'));
  });
});
