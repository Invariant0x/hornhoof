import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HeldTable, SortTable, type TableColumn } from '../src/ui/SortTable';
import { decl } from './css';

type Row = { id: string; name: string; load: number | null };
const rows: Row[] = [{ id: 'a', name: 'Alpha', load: 2 }, { id: 'b', name: 'Beta', load: 8 }, { id: 'c', name: 'Offline', load: null }];
const columns: TableColumn<Row>[] = [
  { key: 'name', label: 'Machine', direction: 1, value: r => r.name, cell: r => r.name },
  { key: 'load', label: 'Load', direction: -1, value: r => r.load, cell: r => r.load ?? 'unknown' },
];
const table = (items = rows) => <SortTable rows={items} columns={columns} name={r => r.name} initialSort={{ key: 'load', direction: -1 }} card={r => <article aria-label={r.name}><input type="checkbox" /><button>Disconnect</button></article>} />;
const names = () => screen.getAllByRole('row').filter(r => r.classList.contains('rm')).map(r => r.getAttribute('aria-label'));

it('toggles once from cells, name buttons and the keyboard, leaves card controls open, and ignores selected text', async () => {
  const user = userEvent.setup();
  render(table());
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  await user.click(within(screen.getByRole('row', { name: 'Alpha' })).getByText('2'));
  const button = screen.getByRole('button', { name: 'Open the card of Alpha' });
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('article', { name: 'Alpha' }).closest('tr')?.previousElementSibling).toBe(button.closest('tr'));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(button).toHaveAttribute('aria-expanded', 'true');
  await user.click(screen.getByRole('button', { name: 'Open the card of Beta' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  await user.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'false');
  button.focus();
  await user.keyboard('{Enter}');
  expect(button).toHaveAttribute('aria-expanded', 'true');
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(within(screen.getByRole('row', { name: 'Offline' })).getByText('unknown'));
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.click(screen.getByRole('row', { name: 'Offline' }));
  expect(screen.getByRole('button', { name: 'Open the card of Offline' })).toHaveAttribute('aria-expanded', 'false');
  selection.removeAllRanges();
});

it('holds order through refreshed values, appends and drops rows, sorts on a header and when the last card closes', async () => {
  const user = userEvent.setup();
  const view = render(table());
  expect(names()).toEqual(['Beta', 'Alpha', 'Offline']);
  await user.click(screen.getByRole('button', { name: 'Open the card of Alpha' }));
  const changed = [{ ...rows[0]!, load: 20 }, rows[1]!, { id: 'd', name: 'Delta', load: 100 }];
  view.rerender(table(changed));
  expect(names()).toEqual(['Beta', 'Alpha', 'Delta']);
  expect(within(screen.getByRole('button', { name: 'Open the card of Alpha' }).closest('tr')!).getByText('20')).toBeInTheDocument();
  const header = within(screen.getByRole('columnheader', { name: 'Load' })).getByRole('button');
  await user.click(header);
  expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending');
  expect(names()).toEqual(['Beta', 'Alpha', 'Delta']);
  await user.click(header);
  expect(names()).toEqual(['Delta', 'Alpha', 'Beta']);
  view.rerender(table([{ ...rows[0]!, load: 1 }, rows[1]!, changed[2]!]));
  expect(names()).toEqual(['Delta', 'Alpha', 'Beta']);
  await user.click(screen.getByRole('button', { name: 'Open the card of Alpha' }));
  expect(names()).toEqual(['Delta', 'Beta', 'Alpha']);
});

it('keeps unknown loads last both ways and gives mobile sorting the same state and direction', async () => {
  const user = userEvent.setup();
  render(table());
  const bar = screen.getByRole('group', { name: 'Sort by' });
  const load = within(bar).getByRole('button', { name: 'Load, descending' });
  expect(load).toHaveAttribute('aria-pressed', 'true');
  await user.click(load);
  expect(names()).toEqual(['Alpha', 'Beta', 'Offline']);
  expect(load).toHaveAccessibleName('Load, ascending');
  expect(screen.getByRole('columnheader', { name: 'Load' })).toHaveAttribute('aria-sort', 'ascending');
});

it('keeps the controlled selection visible through search and filters, then closes the previous routed card', async () => {
  const user = userEvent.setup();
  const filteredTable = (selectedId: string | null) => <SortTable rows={rows} columns={columns} name={r => r.name} initialSort={{ key: 'name', direction: 1 }} card={r => <article aria-label={r.name} />} selectedId={selectedId}
    search={{ placeholder: 'Find machine', text: r => r.name, count: n => `${n} machines` }}
    filters={[{ key: 'state', label: 'State', values: r => [r.load === null ? 'Offline' : 'Online'], text: value => value }]} />;
  const view = render(filteredTable('a'));
  expect(screen.getByRole('article', { name: 'Alpha' })).toBeInTheDocument();
  await user.type(screen.getByRole('searchbox'), '  OFFLINE  ');
  await user.click(within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'Online2' }));
  expect(names()).toEqual(['Alpha']);
  view.rerender(filteredTable('b'));
  expect(names()).toEqual(['Beta']);
  expect(screen.queryByRole('article', { name: 'Alpha' })).not.toBeInTheDocument();
  expect(screen.getByRole('article', { name: 'Beta' })).toBeInTheDocument();
  view.rerender(filteredTable(null));
  expect(screen.getByText('Nothing matches. Change the search or clear the filters.')).toBeInTheDocument();
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(names()).toEqual(['Alpha', 'Beta', 'Offline']);
});

it('keeps the name the cell that opens the card when a narrow column stands before it', async () => {
  const lead: TableColumn<Row>[] = [{ key: 'place', label: 'Priority', direction: 1, className: 'k-prio', lead: true, value: r => r.load, cell: r => r.load ?? 'none' }, ...columns];
  render(<SortTable rows={rows} columns={lead} name={r => r.name} initialSort={{ key: 'place', direction: 1 }} card={r => <article aria-label={r.name} />} />);
  const cells = [...screen.getByRole('row', { name: 'Alpha' }).querySelectorAll('td')];
  expect(cells.map(cell => [cell.className, cell.getAttribute('data-label')])).toEqual([['k-prio', 'Priority'], ['k-name', null], ['', 'Load']]);
  /* The button that opens the card is in the name's cell, and the first header sorts as any other. */
  expect(within(cells[1]!).getByRole('button', { name: 'Open the card of Alpha' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Priority' })).toHaveAttribute('aria-sort', 'ascending');
  expect(names()).toEqual(['Alpha', 'Beta', 'Offline']);
  await userEvent.setup().click(cells[0]!);
  expect(screen.getByRole('article', { name: 'Alpha' })).toBeInTheDocument();
});

/* A frame of 806 px and a table that needs 824 by whole words: wider than a phone, it still stands as entries. */
function widths(frame: number, table: number) {
  const sizes: [object, string, number][] = [[HTMLDivElement.prototype, 'clientWidth', frame], [HTMLTableElement.prototype, 'scrollWidth', table]];
  const restore = sizes.map(([proto, key, value]) => {
    const before = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, get: () => value });
    return () => (before ? Object.defineProperty(proto, key, before) : Reflect.deleteProperty(proto, key));
  });
  return () => restore.forEach(undo => undo());
}

it('stands as entries where the table does not fit its frame by whole words, and as a table where it does', () => {
  let undo = widths(806, 824);
  try {
    const { unmount } = render(table());
    expect(screen.getByRole('table')).toHaveAttribute('data-fit', 'entries');
    unmount();
  } finally {
    undo();
  }
  undo = widths(806, 806);
  try {
    render(table());
    expect(screen.getByRole('table')).not.toHaveAttribute('data-fit');
  } finally {
    undo();
  }
  expect(decl('.dt[data-fit="entries"] > thead', 'display')).toBe('none');
  expect(decl('.tbl:has(> .dt[data-fit="entries"]) > .sortbar', 'display')).toBe('flex');
  expect(decl('.dt[data-fit="entries"] > tbody > tr.rm', 'display')).toBe('grid');
  expect(decl('.dt[data-fit="entries"] td[data-label]::before', 'content')).toBe('attr(data-label)');
});

it('gives sort headers and row name buttons 44px touch targets, compact row padding, logical RTL sides and an unclipped focus ring', () => {
  expect(decl('.dt > thead > tr > th', 'text-align')).toBe('start');
  expect(decl('.dt > thead > tr > th', 'padding-inline')).toBe('10px');
  expect(decl('.dt > thead > tr > th:has(> .sorth)', 'padding')).toBe('0');
  expect(decl('.sorth', 'min-block-size')).toBe('44px');
  expect(decl('.sorth', 'min-inline-size')).toBe('max(44px, 100%)');
  expect(decl('.sorth', 'text-align')).toBe('start');
  expect(decl('.sorth', 'overflow-wrap')).toBe('normal');
  expect(decl('.sorth', 'word-break')).toBe('normal');

  expect(decl('.sortb', 'min-block-size')).toBe('44px');
  expect(decl('.sortb', 'min-inline-size')).toBe('44px');
  expect(decl('.sortb', 'block-size')).toBe('auto');
  expect(decl('.sortb', 'text-align')).toBe('start');

  expect(decl('.rowbtn', 'min-block-size')).toBe('44px');
  expect(decl('.rowbtn', 'min-inline-size')).toBe('44px');
  expect(decl('.rowbtn', 'padding-inline-start')).toBe('20px');
  expect(decl('.rowbtn', 'text-align')).toBe('start');
  expect(decl('.rowbtn', 'padding')).toBeUndefined();
  expect(decl('.rowbtn .chev', 'inset-inline-start')).toBe('0');
  expect(decl('.rowbtn .chev', 'left')).toBeUndefined();
  expect(decl('[dir="rtl"] .rowbtn .chev', 'transform')).toBe('scaleX(-1)');
  expect(decl('[dir="rtl"] .rowbtn[aria-expanded="true"] .chev', 'transform')).toBe('scaleX(-1) rotate(90deg)');

  /* Height belongs to the button rather than double-padding the name cell. */
  expect(decl('.dt > tbody > tr.rm > td.k-name', 'padding-block')).toBe('0');

  /* The 2px ring at 2px offset is not clipped by the chamfered table frame. */
  for (const button of ['.sorth:focus-visible', '.sortb:focus-visible', '.rowbtn:focus-visible']) {
    expect(decl(button, 'outline')).toBe('2px solid var(--cyan-ink)');
    expect(decl(button, 'outline-offset')).toBe('2px');
  }
  expect(decl('.tbl-frame:has(:focus-visible)', 'clip-path')).toBe('none');
  expect(decl('.tbl-frame:has(:focus-visible) > .edge-in', 'clip-path')).toBe('none');
});

afterEach(() => sessionStorage.clear());

/* Design #1667 (style book 1.7, "last known size"): a list whose filter buttons showed holds their size on its next load in the
   same tab; a list never shown, or one with no room name, holds none. */
it('holds the size its filter buttons took last in this tab while the list comes again, and none before they showed', () => {
  const search = { placeholder: 'Find machine', text: (r: Row) => r.name, count: (n: number) => `${n} machines`, room: 'boxes' };
  const loading = { phase: 'loading' as const, ring: true, failure: null, asked: 1, retry: () => {} };
  const held = () => render(<HeldTable load={loading} columns={columns} search={search} rows={2} />);
  const room = (view: ReturnType<typeof render>) => (view.container.querySelector('.tools-r2') as HTMLElement).style.getPropertyValue('--tools-room');
  const first = held();
  expect(room(first)).toBe('0px');
  first.unmount();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 44 } as DOMRect);
  const shown = render(<SortTable rows={rows} columns={columns} name={r => r.name} initialSort={{ key: 'name', direction: 1 }} card={() => null} search={search}
    filters={[{ key: 'state', label: 'State', values: r => [r.load === null ? 'Offline' : 'Online'], text: value => value }]} />);
  shown.unmount();
  vi.restoreAllMocks();
  const next = held();
  expect(room(next)).toBe('44px');
  next.unmount();
  const unnamed = render(<HeldTable load={loading} columns={columns} search={{ ...search, room: undefined }} rows={2} />);
  expect(room(unnamed)).toBe('');
});
