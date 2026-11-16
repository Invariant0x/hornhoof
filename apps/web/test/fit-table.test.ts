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

  /* A card open below a row spans every column and wraps to their width: what it holds does not decide the table's look,
     and it shows again once measured. */
  function withCard(hostWidth: number, columns: number, card: number): { table: HTMLTableElement; row: HTMLElement } {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: hostWidth });
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Machine</th></tr></thead><tbody><tr class="rm"><td>a-host</td></tr><tr class="det"><td>card</td></tr></tbody>';
    const row = table.querySelector<HTMLElement>('tr.det')!;
    Object.defineProperty(table, 'scrollWidth', { get: () => (row.style.display === 'none' ? columns : Math.max(columns, card)) });
    host.append(table);
    return { table, row };
  }

  it('keeps a table whose columns fit, whatever an open card below a row holds', () => {
    const { table, row } = withCard(1000, 900, 1600);
    fitTable(table);
    expect(table.dataset.fit).toBeUndefined();
    expect(row.style.display).toBe('');
  });

  it('turns a table whose own columns overflow into entries with a card open', () => {
    const { table, row } = withCard(1000, 1100, 1600);
    fitTable(table);
    expect(table.dataset.fit).toBe('entries');
    expect(row.style.display).toBe('');
  });
});
