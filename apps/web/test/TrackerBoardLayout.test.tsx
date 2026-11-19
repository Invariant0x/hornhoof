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

it('draws columns, pills and cards at the mockup sizes and lets their words wrap', () => {
  /* .bcol: the panel's surface in a line, 8px inside; its head a pill, the count and the role at the end. */
  expect.soft(decl('.tr-col', 'background')).toBe('var(--surface)');
  expect.soft(decl('.tr-col', 'border')).toBe('1px solid var(--line)');
  expect.soft(decl('.tr-col', 'padding')).toBe('8px');
  expect.soft(decl('.tr-col-head', 'gap')).toBe('8px');
  expect.soft(decl('.tr-col-head .tr-count', 'font')).toBe('13px var(--f-body)');
  expect.soft(decl('.tr-col-who', 'font-size')).toBe('11.5px');
  expect.soft(decl('.tr-col-who', 'margin-inline-start')).toBe('auto');
  expect.soft(decl('.tr-columns', 'gap')).toBe('10px');
  /* .bcard: a line around a cut card of the raised surface, 9px by 10px inside, 7px between its lines. */
  expect.soft(decl('.tr-card', 'padding')).toBe('1px');
  expect.soft(decl('.tr-card', 'background')).toBe('var(--line)');
  expect.soft(decl('.tr-card', '--cut')).toBe('calc(8px * var(--cut-k))');
  expect.soft(decl('.tr-card-body', 'background')).toBe('var(--surface2)');
  expect.soft(decl('.tr-card-body', 'padding')).toBe('9px 10px');
  expect.soft(decl('.tr-card-body', 'gap')).toBe('7px');
  expect.soft(decl('.tr-card-title', 'font')).toBe('600 13.5px/1.3 var(--f-body)');
  expect.soft(decl('.tr-card-meta', 'font-size')).toBe('12px');
  expect.soft(decl('.tr-card-meta', 'gap')).toBe('10px');
  expect.soft(decl('.tr-card-meta', 'flex-wrap')).toBe('wrap');
  expect.soft(decl('.tr-card .tr-wait.person', 'color')).toBe('var(--pink-ink)');
  expect.soft(decl('.tr-card', 'overflow-wrap')).toBe('break-word');
  expect.soft(decl('.tr-card .tstate', 'font-size')).toBe('11px');
  expect.soft(decl('.tr-card-body > .entry-actions > .act', 'font-size')).toBe('12px');
});

it.each([['status', null], ['pipeline', pipeline]] as const)('opens the card from its title and its question on the %s board', (_board, route) => {
  const task: TaskLine = {
    ...TASK_DETAIL, parentId: null, status: 'waiting', pipelineId: pipeline.id, pipelineStageId: 'Build',
  };
  const onOpenTask = vi.fn();
  render(<LanguageProvider><TrackerBoard tasks={[task]} all={[task]} pipeline={route} cancelled={false}
    rows={{ selected: null, onOpenTask, asksYou: () => true }} /></LanguageProvider>);
  const card = within(screen.getByRole('article', { name: `#${task.number} ${task.title}` }));
  const title = card.getByRole('button', { name: task.title });
  /* The mockup's card names the task by its title; its number is in the card's name for screen readers. */
  expect(card.queryByText(`#${task.number}`)).toBeNull();
  fireEvent.click(title);
  fireEvent.click(card.getByRole('button', { name: 'Open question' }));
  expect(onOpenTask.mock.calls).toEqual([[task.id], [task.id]]);
});
