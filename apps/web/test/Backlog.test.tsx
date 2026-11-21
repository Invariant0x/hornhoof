import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Backlog } from '../src/ui/Backlog';
import { mockApi } from './api-mock';

const ITEMS = [{ id: 'i1', departmentId: 'd2', title: 'Price page', text: '', by: { id: 'p1', name: 'Ivan Korol' }, at: '2026-10-30T08:00:00.000Z' }];

afterEach(() => vi.unstubAllGlobals());

/* A frame of 806 px and a list that needs 824 by whole words. */
function widths(frame: number, table: number) {
  const sizes: [object, string, number][] = [[HTMLDivElement.prototype, 'clientWidth', frame], [HTMLTableElement.prototype, 'scrollWidth', table]];
  const restore = sizes.map(([proto, key, value]) => {
    const before = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, get: () => value });
    return () => (before ? Object.defineProperty(proto, key, before) : Reflect.deleteProperty(proto, key));
  });
  return () => restore.forEach(undo => undo());
}

/* The list keeps its words whole, as a sorting table does: where they do not fit its frame it stands as entries. */
it.each([[824, 'entries'], [806, 'a table']])('a list that needs %i px of a frame of 806 by whole words stands as %s', async (needs, look) => {
  mockApi({ 'GET /api/departments/d2/backlog': [200, { items: ITEMS }] });
  const undo = widths(806, needs);
  try {
    render(<LanguageProvider><Backlog departmentId="d2" /></LanguageProvider>);
    const table = await screen.findByRole('table', { name: 'Off-turn list' });
    if (look === 'entries') expect(table).toHaveAttribute('data-fit', 'entries');
    else expect(table).not.toHaveAttribute('data-fit');
  } finally {
    undo();
  }
});

it('confirms before deleting an item from the off-turn list and keeps failures in the dialog', async () => {
  const user = userEvent.setup();
  let fail = true;
  const calls = mockApi({
    'GET /api/departments/d2/backlog': [200, { items: ITEMS }],
    'DELETE /api/departments/d2/backlog/i1': () => (fail ? [500, { error: { code: 'internal', message: 'Cannot delete now.' } }] : [200, { items: [] }]),
  });
  render(<LanguageProvider><Backlog departmentId="d2" /></LanguageProvider>);
  const remove = await screen.findByRole('button', { name: 'Remove from the list: Price page' });
  await user.click(remove);
  expect(calls.filter(c => c.method === 'DELETE')).toEqual([]);
  const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to delete this item?' });
  expect(dialog).toHaveAccessibleDescription('Price page will be deleted from the off-turn list.');
  expect(dialog.querySelector('bdi')).toHaveTextContent('Price page');
  expect(dialog).toHaveTextContent('This cannot be undone.');
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(calls.filter(c => c.method === 'DELETE')).toEqual([]);

  await user.click(remove);
  const again = screen.getByRole('alertdialog');
  await user.click(within(again).getByRole('button', { name: 'Delete' }));
  expect(await within(again).findByRole('alert')).toHaveTextContent('Cannot delete now.');

  fail = false;
  await user.click(within(again).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Remove from the list: Price page' })).not.toBeInTheDocument();
});
