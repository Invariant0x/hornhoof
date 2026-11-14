import { describe, expect, it } from 'vitest';
import { heldJobs } from '../src/held-jobs.js';

describe('the turns a node says it holds', () => {
  it('names each asked turn it runs, was typed or ended unconfirmed, and none it does not hold', () => {
    expect(heldJobs(['a', 'b', 'c'], ['c', 'x', 'a'])).toEqual({ type: 'jobs.held', asked: ['a', 'b', 'c'], held: ['a', 'c'] });
  });

  it('holds nothing of what it was asked when it runs no turn', () => {
    expect(heldJobs(['a'], [])).toEqual({ type: 'jobs.held', asked: ['a'], held: [] });
  });
});
