import { describe, expect, it } from 'vitest';
import { APPROVAL_CHANNELS, ApprovalRule, approvalNeeded, defaultRule, kindKey, GOING_OUT_CHANNELS, ruleOf } from '../src/approval-policy.js';

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

  it('never asks in the mode of no approval, however much and however new', () => {
    expect(approvalNeeded({ mode: 'none' }, work({ amount: null, known: false }))).toBe(false);
    expect(approvalNeeded({ mode: 'none' }, work({ amount: 1_000_000, known: false }))).toBe(false);
  });
});

describe('ApprovalRule', () => {
  it('keeps the four modes, with a limit only in the mode of limits', () => {
    expect(ApprovalRule.parse({ mode: 'none' })).toEqual({ mode: 'none' });
    expect(ApprovalRule.parse({ mode: 'every' })).toEqual({ mode: 'every' });
    expect(ApprovalRule.parse({ mode: 'new_kinds' })).toEqual({ mode: 'new_kinds' });
    expect(ApprovalRule.parse({ mode: 'within_limits', limit: 5, unit: ' USD ' })).toEqual({ mode: 'within_limits', limit: 5, unit: 'USD' });
  });

  it('refuses a mode of limits without a limit, a limit below zero, and a limit on another mode', () => {
    expect(ApprovalRule.safeParse({ mode: 'within_limits' }).success).toBe(false);
    expect(ApprovalRule.safeParse({ mode: 'within_limits', limit: -1 }).success).toBe(false);
    expect(ApprovalRule.safeParse({ mode: 'every', limit: 5 }).success).toBe(false);
    expect(ApprovalRule.safeParse({ mode: 'none', limit: 5 }).success).toBe(false);
    expect(ApprovalRule.safeParse({ mode: 'anything' }).success).toBe(false);
  });
});

describe('ruleOf', () => {
  it('asks nothing for what goes out (messages, prices in them, publications) on a channel with no rule yet: a department that wants to approve its own sets a rule', () => {
    expect(GOING_OUT_CHANNELS).toEqual(['message', 'price', 'publication']);
    for (const channel of GOING_OUT_CHANNELS) {
      expect(defaultRule(channel)).toEqual({ mode: 'none' });
      expect(ruleOf(undefined, channel)).toEqual({ mode: 'none' });
    }
  });

  it('allows commits, spending and other new work with no rule yet', () => {
    for (const channel of ['commit', 'spend', 'other'] as const) {
      expect(approvalNeeded(ruleOf(undefined, channel), work())).toBe(false);
    }
  });

  it('reads what is stored, and never reads a stored mode of limits with no limit as no limit at all', () => {
    expect(ruleOf({ mode: 'none', limitAmount: null, limitUnit: null }, 'spend')).toEqual({ mode: 'none' });
    expect(ruleOf({ mode: 'every', limitAmount: null, limitUnit: null }, 'message')).toEqual({ mode: 'every' });
    expect(ruleOf({ mode: 'new_kinds', limitAmount: null, limitUnit: null }, 'message')).toEqual({ mode: 'new_kinds' });
    expect(ruleOf({ mode: 'within_limits', limitAmount: 7, limitUnit: 'USD' }, 'price')).toEqual({ mode: 'within_limits', limit: 7, unit: 'USD' });
    expect(ruleOf({ mode: 'within_limits', limitAmount: 7, limitUnit: null }, 'price')).toEqual({ mode: 'within_limits', limit: 7 });
    expect(ruleOf({ mode: 'within_limits', limitAmount: null, limitUnit: null }, 'message')).toEqual({ mode: 'every' });
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
