import { describe, expect, it } from 'vitest';
import { nextSort, orderRows, sortRows, type SortColumn } from '../src/ui/sort';

type Row = { id: string; name: string; amount: number | null };
const columns: SortColumn<Row>[] = [
  { key: 'name', direction: 1, value: r => r.name },
  { key: 'amount', direction: -1, value: r => r.amount },
];
const rows: Row[] = [{ id: 'a', name: 'Alpha', amount: 1 }, { id: 'b', name: 'Beta', amount: 9 }, { id: 'c', name: 'Gamma', amount: null }];
const ids = (items: Row[]) => items.map(r => r.id);
const name = (r: Row) => r.name;

describe('table sorting', () => {
  it('starts names ascending and amounts descending, and reverses the active column', () => {
    const byName = nextSort({ key: 'amount', direction: -1 }, columns[0]!);
    expect(byName).toEqual({ key: 'name', direction: 1 });
    expect(nextSort(byName, columns[0]!)).toEqual({ key: 'name', direction: -1 });
    expect(nextSort(byName, columns[1]!)).toEqual({ key: 'amount', direction: -1 });
  });

  it('keeps empty values last in both directions and compares ties by name in the page language', () => {
    for (const direction of [1, -1] as const) {
      const ordered = sortRows(rows, columns[1]!, direction, name, 'en');
      expect(ordered.at(-1)!.id).toBe('c');
      expect(ids(ordered).slice(0, 2)).toEqual(direction === 1 ? ['a', 'b'] : ['b', 'a']);
    }
    const ties = ['Яна', 'Борис', 'Анна'].map((name, id) => ({ id: String(id), name, amount: 2 }));
    expect(sortRows(ties, columns[1]!, -1, name, 'ru').map(r => r.name)).toEqual(['Анна', 'Борис', 'Яна']);
    const many = [{ ...rows[0]!, amount: 200 }, { ...rows[1]!, amount: 200 }];
    const compound: SortColumn<Row> = { key: 'agents', direction: -1, value: r => [r.amount!, r.id === 'a' ? 1 : 3] };
    expect(ids(sortRows(many, compound, -1, name, 'en'))).toEqual(['b', 'a']);
  });

  it('holds the order while cards are open, appends new rows, removes gone rows, then sorts when the last closes', () => {
    const changed = [{ ...rows[0]!, amount: 20 }, rows[1]!, { id: 'd', name: 'Delta', amount: 100 }];
    const sorted = sortRows(changed, columns[1]!, -1, name, 'en');
    expect(ids(orderRows(sorted, ['b', 'a', 'c'], true))).toEqual(['b', 'a', 'd']);
    expect(ids(orderRows(sorted, ['b', 'a', 'c'], false))).toEqual(['d', 'a', 'b']);
  });
});
