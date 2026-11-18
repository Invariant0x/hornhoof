import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Pipeline, TaskLine } from '../src/types';
import { TrackerBoard } from '../src/ui/TrackerViews';
import { TASK_DETAIL } from './api-mock';
import { decl } from './css';

const rows = { selected: null, onOpenTask: vi.fn() };
const pipeline = {
  id: 'route',
  stages: ['Build', 'Check', 'Ship'].map((name, position) => ({ id: name, name, parentId: null, position })),
} as Pipeline;

afterEach(() => vi.unstubAllGlobals());

it.each([
  [null, ['Not started', 'In work', 'Review', 'Waits for a person', 'Done']],
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

  act(() => resize(850));
  expect(group).toHaveAttribute('data-layout', 'row');
  expect(group).toHaveStyle(`--tr-column-count: ${headings.length}`);
  act(() => resize(810));
  expect(group).toHaveAttribute('data-layout', 'stack');
  expect(within(board).getAllByRole('region')).toEqual(columns);
});

it('uses compact type and allows text to wrap inside board cards', () => {
  expect.soft(decl('.tr-card', 'line-height')).toBe('1.4');
  expect.soft(decl('.tr-card', 'overflow-wrap')).toBe('break-word');
  expect.soft(decl('.tr-card-title', 'font-family')).toBe('var(--f-body)');
  expect.soft(decl('.tr-card-title', 'font-size')).toBe('13px');
  expect.soft(decl('.tr-card-title', 'font-weight')).toBe('500');
  expect.soft(decl('.tr-card-title .linkish', 'min-block-size')).toBe('44px');
  expect.soft(decl('.tr-card-title .tr-no', 'font-weight')).toBe('400');
  expect.soft(decl('.tr-no', 'font-size')).toBe('12px');
  expect.soft(decl('.tr-card-facts', 'font-size')).toBe('12px');
  expect.soft(decl('.tr-card .tr-wait', 'font-size')).toBe('inherit');
  expect.soft(decl('.tr-card .tstate', 'font-size')).toBe('11px');
  expect.soft(decl('.tr-card .tstate', 'padding')).toBe('2px 6px');
  expect.soft(decl('.tr-card > .entry-actions > .act', 'font-size')).toBe('12px');
  expect.soft(decl('.tr-card > .entry-actions > .act', 'padding')).toBe('4px 6px');
  expect.soft(decl('.tr-card > .entry-actions > .act', 'inline-size')).toBe('max-content');
});

it.each([['status', null], ['pipeline', pipeline]] as const)('shares the title button with the task number on the %s board', (_board, route) => {
  const task: TaskLine = {
    ...TASK_DETAIL, parentId: null, status: 'waiting', pipelineId: pipeline.id, pipelineStageId: 'Build',
  };
  const onOpenTask = vi.fn();
  render(<LanguageProvider><TrackerBoard tasks={[task]} all={[task]} pipeline={route} cancelled={false}
    rows={{ selected: null, onOpenTask, asksYou: () => true }} /></LanguageProvider>);
  const card = within(screen.getByRole('article', { name: `#${task.number} ${task.title}` }));
  const title = card.getByRole('button', { name: task.title });
  const number = card.getByText(`#${task.number}`);
  expect(title).toContainElement(number);
  fireEvent.click(number);
  fireEvent.click(card.getByRole('button', { name: 'Open question' }));
  expect(onOpenTask.mock.calls).toEqual([[task.id], [task.id]]);
});
