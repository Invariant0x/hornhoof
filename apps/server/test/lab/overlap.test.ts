import { describe, expect, it } from 'vitest';
import { lateConfirms, type Confirmed } from './overlap.js';

const write = (id: string, at: number, number: number, machine: string, split = false): Confirmed => ({ id, at, machine: `m-${machine}`, term: { number, machine, split } });

describe('what the lab reads from the terms of confirmed writes', () => {
  it('finds a write an older leader confirmed after a newer one', () => {
    const [newer, older] = [write('n', 100, 8, 'b'), write('o', 200, 7, 'a')];
    expect(lateConfirms([older, newer])).toEqual([[newer, older]]);
  });

  it('finds none when the older leader wrote first, or one leader wrote both', () => {
    expect(lateConfirms([write('o', 100, 7, 'a'), write('n', 200, 8, 'b')])).toEqual([]);
    expect(lateConfirms([write('x', 100, 7, 'a'), write('y', 200, 7, 'a')])).toEqual([]);
    expect(lateConfirms([write('x', 100, 8, 'b'), write('y', 100, 7, 'a')])).toEqual([]);
    expect(lateConfirms([])).toEqual([]);
  });

  it('counts no split term either way', () => {
    expect(lateConfirms([write('n', 100, 8, 'b', true), write('o', 200, 7, 'a')])).toEqual([]);
    expect(lateConfirms([write('n', 100, 8, 'b'), write('o', 200, 7, 'a', true)])).toEqual([]);
  });

  it('tells two leaders of one number apart by their machines', () => {
    const [higher, lower] = [write('h', 100, 8, 'b'), write('l', 200, 8, 'a')];
    expect(lateConfirms([higher, lower])).toEqual([[higher, lower]]);
    expect(lateConfirms([write('l', 100, 8, 'a'), write('h', 200, 8, 'b')])).toEqual([]);
  });

  it('gives every such pair', () => {
    const ws = [write('1', 100, 9, 'c'), write('2', 200, 8, 'b'), write('3', 300, 7, 'a')];
    expect(lateConfirms(ws).map(([a, b]) => `${a.id}>${b.id}`)).toEqual(['1>2', '1>3', '2>3']);
  });
});
