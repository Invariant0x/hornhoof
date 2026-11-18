import { act, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Pipeline } from '../src/types';
import { TrackerBoard } from '../src/ui/TrackerViews';

const rows = { selected: null, onOpenTask: vi.fn() };
const pipeline = {
  id: 'route',
  stages: ['Build', 'Check', 'Ship'].map((name, position) => ({ id: name, name, parentId: null, position })),
} as Pipeline;

afterEach(() => vi.unstubAllGlobals());

it.each([
  [null, ['Not started', 'In work', 'Review', 'Waits for a person', 'Failures', 'Done']],
  [pipeline, ['Not started', 'Build', 'Check', 'Ship', 'Done']],
] as const)('keeps all columns in one row or stacks them in the same order', (route, headings) => {
  let resize!: (width: number) => void;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resize = width => callback([{ contentRect: { width } }] as ResizeObserverEntry[], this as ResizeObserver);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  render(<LanguageProvider><TrackerBoard tasks={[]} all={[]} pipeline={route} cancelled={false} rows={rows} /></LanguageProvider>);
  const board = screen.getByRole('region', { name: 'Board' });
  const columns = within(board).getAllByRole('region');
  const group = columns[0]!.parentElement;
  expect(group).toHaveAttribute('data-layout', 'stack');
  expect(columns.every(column => column.parentElement === group && !column.classList.contains('stage'))).toBe(true);
  expect(columns.map(column => column.getAttribute('aria-label'))).toEqual(headings);
  expect(columns.map(column => within(column).getByRole('heading').textContent)).toEqual(headings.map(name => `${name} 0`));

  act(() => resize(1200));
  expect(group).toHaveAttribute('data-layout', 'row');
  expect(group).toHaveStyle(`--tr-column-count: ${headings.length}`);
  act(() => resize(810));
  expect(group).toHaveAttribute('data-layout', 'stack');
  expect(within(board).getAllByRole('region')).toEqual(columns);
});
