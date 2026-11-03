import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SortTable, type TableColumn } from '../src/ui/SortTable';

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
