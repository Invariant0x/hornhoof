import { describe, expect, it } from 'vitest';
import { fitTable } from '../src/ui/fit-table';

function tableAt(hostWidth: number, scrollWidth: number): HTMLTableElement {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: hostWidth });
  const table = document.createElement('table');
  Object.defineProperty(table, 'scrollWidth', { value: scrollWidth });
  host.append(table);
  return table;
}

describe('fitTable', () => {
  it('does nothing without a measured host', () => {
    const table = tableAt(0, 500);
    table.dataset.fit = 'entries';
    fitTable(table);
    expect(table.dataset.fit).toBe('entries');
  });

  it('keeps a table that fits its host', () => {
    const table = tableAt(400, 399);
    fitTable(table);
    expect(table.dataset.fit).toBeUndefined();
  });

  it('turns overflowing content into entries', () => {
    const table = tableAt(400, 401);
    fitTable(table);
    expect(table.dataset.fit).toBe('entries');
  });

  it('removes entries when the table fits again', () => {
    const table = tableAt(400, 400);
    table.dataset.fit = 'entries';
    fitTable(table);
    expect(table.dataset.fit).toBeUndefined();
  });
});
