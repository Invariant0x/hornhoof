import { describe, expect, it } from 'vitest';
import { turnEffort } from '../src/modules/conversation/turn-effort.js';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const relook = { why: 'review', again: true };
const merge = { why: 'merge' };

describe('how hard a turn thinks', () => {
  /* Plans, first looks, security and work that needs thought: nothing in their wake says less is enough. */
  it.each(['assigned', 'review', 'turn_review', 'changes', 'reminder', 'go_on', 'comment', 'answered', 'updated', 'unblocked', 'subtasks', 'message'])('keeps the base for a %s turn', why => {
    expect(turnEffort('xhigh', LEVELS, [{ why }])).toBe('xhigh');
  });

  it('takes medium for a look again at the fixes for a finding', () => {
    expect(turnEffort('xhigh', LEVELS, [relook])).toBe('medium');
  });

  it('takes medium for merging what already passed its gates', () => {
    expect(turnEffort('high', LEVELS, [merge])).toBe('medium');
  });

  it('holds a level from the card as the base of a first look and takes medium for the look again', () => {
    expect(turnEffort('max', LEVELS, [{ why: 'review' }])).toBe('max');
    expect(turnEffort('max', LEVELS, [relook])).toBe('medium');
  });

  it('takes "again" only from a review', () => {
    expect(turnEffort('xhigh', LEVELS, [{ why: 'assigned', again: true }])).toBe('xhigh');
    expect(turnEffort('xhigh', LEVELS, [{ why: 'review', again: false }])).toBe('xhigh');
  });

  it('never raises a base below medium', () => {
    expect(turnEffort('low', LEVELS, [relook])).toBe('low');
    expect(turnEffort('medium', LEVELS, [relook])).toBe('medium');
  });

  it('keeps the base when the turn also brings anything else', () => {
    expect(turnEffort('xhigh', LEVELS, [relook, { why: 'comment' }])).toBe('xhigh');
    expect(turnEffort('xhigh', LEVELS, [relook, null])).toBe('xhigh');
    expect(turnEffort('xhigh', LEVELS, [relook, merge])).toBe('medium');
  });

  it('keeps the base of a turn that says nothing of why', () => {
    expect(turnEffort('xhigh', LEVELS, [])).toBe('xhigh');
    expect(turnEffort('xhigh', LEVELS, [null])).toBe('xhigh');
  });

  describe('on a model that does not take medium', () => {
    it('claims no level for a model with no known levels', () => {
      expect(turnEffort('max', [], [relook])).toBe('max');
      expect(turnEffort(null, [], [relook])).toBeNull();
    });

    it('takes the nearest level above medium, never one below it', () => {
      expect(turnEffort('max', ['low', 'high', 'max'], [relook])).toBe('high');
      expect(turnEffort('high', ['low', 'high'], [relook])).toBe('high');
    });

    it('keeps the base when the model has nothing from medium up', () => {
      expect(turnEffort('low', ['low'], [relook])).toBe('low');
      expect(turnEffort(null, ['low'], [relook])).toBeNull();
    });

    it('keeps a base it cannot compare', () => {
      expect(turnEffort('minimal', LEVELS, [relook])).toBe('minimal');
    });

    it('lowers a level above max as well', () => {
      expect(turnEffort('ultra', ['medium', 'ultra'], [relook])).toBe('medium');
    });
  });

  it('asks for medium where the program would choose by itself, when the model takes it', () => {
    expect(turnEffort(null, LEVELS, [relook])).toBe('medium');
    expect(turnEffort(null, LEVELS, [{ why: 'review' }])).toBeNull();
  });
});
