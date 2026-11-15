import { render, screen } from '@testing-library/react';
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
