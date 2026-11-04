import { describe, expect, it } from 'vitest';
import { waitingCycles } from '../src/modules/tasks/wait-graph.js';

describe('employee waiting cycles', () => {
  it('leaves empty and one-way chains alone', () => {
    expect(waitingCycles([])).toEqual([]);
    expect(waitingCycles([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])).toEqual([]);
  });

  it('keeps both reasons in a direct cycle and excludes a waiting bystander', () => {
    const ab = { from: 'A', to: 'B', reason: 'Acceptance' };
    const ba = { from: 'B', to: 'A', reason: 'Submission' };
    expect(waitingCycles([{ from: 'C', to: 'A', reason: 'Other work' }, ab, ba])).toEqual([[ab, ba]]);
  });

  it('finds a three-employee chain that closes', () => {
    const edges = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' }];
    expect(waitingCycles(edges)).toEqual([edges]);
  });

  it('reports one mutually waiting group for overlapping cycles', () => {
    const edges = [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }, { from: 'B', to: 'C' }, { from: 'C', to: 'B' }];
    expect(waitingCycles(edges)).toEqual([edges]);
  });

  it('separates independent cycles', () => {
    const ab = { from: 'A', to: 'B' }, ba = { from: 'B', to: 'A' };
    const cd = { from: 'C', to: 'D' }, dc = { from: 'D', to: 'C' };
    expect(waitingCycles([ab, ba, cd, dc])).toEqual(expect.arrayContaining([[ab, ba], [cd, dc]]));
    expect(waitingCycles([ab, ba, cd, dc])).toHaveLength(2);
  });

  it('preserves different task reasons on parallel employee edges', () => {
    const edges = [{ from: 'A', to: 'B', task: 1 }, { from: 'A', to: 'B', task: 2 }, { from: 'B', to: 'A', task: 3 }];
    expect(waitingCycles(edges)).toEqual([edges]);
  });

  it('can surface a legacy self dependency', () => {
    expect(waitingCycles([{ from: 'A', to: 'A' }])).toEqual([[{ from: 'A', to: 'A' }]]);
  });
});
