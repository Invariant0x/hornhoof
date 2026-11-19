import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { NODE, type Crumb, type GraphNode } from '../src/tracker';
import type { GoalView, TaskLine } from '../src/types';
import { decl } from './css';
import { taskRoute } from './task-route';
import { TrackerGraph } from '../src/ui/TrackerViews';

const goal = (id: string, title: string): GoalView => ({
  id, number: 1, title, why: '', department: null, parentId: null, responsible: { id: 'p1', name: 'Ivan' }, target: null, current: null, unit: '', dueAt: null, status: 'active', progress: null, done: 0, total: 0, version: 0, mayEdit: true,
});
const node = (id: string, title: string, children: GraphNode[] = []): GraphNode => ({ kind: 'goal', id, goal: goal(id, title), children });
const rows = { selected: null, onOpenTask: () => {} };
const graph = (forest: GraphNode[], crumbs: Crumb[], top = 'All goals') => (
  <LanguageProvider><TrackerGraph forest={forest} crumbs={crumbs} top={top} onCrumb={() => {}} rows={rows} onOpenGoal={() => {}} /></LanguageProvider>
);
const at = (id: string, title: string): Crumb => ({ kind: 'goal', id, number: 1, title });
const transform = (container: HTMLElement) => container.querySelector<HTMLElement>('.world')!.style.transform;

describe('the graph canvas', () => {
  it('places a new root again after the person moved the canvas, and keeps the place while the same tree changes', () => {
    const first = [node('g1', 'First root')];
    const { container, rerender } = render(graph(first, [at('g1', 'First root')]));
    const placed = transform(container);
    fireEvent.wheel(container.querySelector('.tr-map')!, { deltaY: 10000, clientX: 5000, clientY: 5000 });
    const moved = transform(container);
    expect(moved).not.toBe(placed);
    /* New work on the same tree: the canvas stays where the person put it. */
    rerender(graph([node('g1', 'First root', [node('g3', 'New under it')])], [at('g1', 'First root')]));
    expect(transform(container)).toBe(moved);
    /* Graph from another root: it opens placed, not where the last tree was moved to. */
    rerender(graph([node('g2', 'Second root')], [at('g2', 'Second root')]));
    expect(transform(container)).toBe(placed);
  });

  it('places the tree again when the place it draws changes', () => {
    const { container, rerender } = render(graph([node('g1', 'First root')], [], 'Development'));
    const placed = transform(container);
    fireEvent.wheel(container.querySelector('.tr-map')!, { deltaY: 10000, clientX: 5000, clientY: 5000 });
    rerender(graph([node('g2', 'Second root')], [], 'Sales'));
    expect(transform(container)).toBe(placed);
  });
});

const since = '2026-11-14T12:00:00.000Z';
const task = (id: string, number: number, title: string, over: Partial<TaskLine> = {}): TaskLine => ({
  id, number, title, brief: '', status: 'working', department: null, product: null, executor: { id: 'lr', name: 'Lead Researcher', kind: 'worker', role: null },
  assignee: null, turn: null, parentId: null, waitsFor: [], echelons: taskRoute(), goal: null, responsible: null,
  createdAt: since, updatedAt: since, dueAt: null, time: { inStatusSince: since, workSeconds: 0, waitsOn: [] }, ...over,
});
const taskNode = (t: TaskLine, children: GraphNode[] = []): GraphNode => ({ kind: 'task', id: t.id, task: t, children });

describe('the graph as the mockup draws it', () => {
  it('draws a goal with its mark, progress and bar, and a task with its number, status and who does it', () => {
    const target = { ...goal('g1', '500 subscribers'), target: 500, current: 212, unit: 'subscribers', dueAt: '2026-12-31T00:00:00.000Z' };
    const work = task('t1', 412, 'Find 3D artists');
    render(graph([{ kind: 'goal', id: 'g1', goal: target, children: [taskNode(work)] }], []));
    const goalNode = screen.getByRole('button', { name: /500 subscribers/ });
    expect(goalNode).toHaveClass('tr-node', 'goal', 'working');
    expect(goalNode.querySelector('.tr-node-mark')).toHaveTextContent('◎');
    expect(goalNode.querySelector('.tr-node-mark')).toHaveAttribute('aria-hidden', 'true');
    expect(within(goalNode).getByText(/^212 of 500 subscribers · until 31 Dec/)).toHaveClass('tr-node-meta');
    expect(goalNode.querySelector<HTMLElement>('.tr-node-bar > i')!.style.inlineSize).toBe('42.4%');
    const taskButton = screen.getByRole('button', { name: /Find 3D artists/ });
    expect(within(taskButton).getByText('#412')).toHaveClass('tr-node-no');
    expect(within(taskButton).getByText('In work · Lead Researcher')).toHaveClass('tr-node-meta');
  });

  it('routes a wait as a dashed line out to the side with an arrow and its word, and explains the lines under the canvas', () => {
    const first = task('t1', 412, 'Find 3D artists');
    const second = task('t2', 419, 'First wave', { waitsFor: [412] });
    const { container } = render(graph([node('g1', 'Mailing', [taskNode(first), taskNode(second)])], []));
    const wait = container.querySelector('.tr-wires .wait')!;
    expect(wait.querySelector('path')).toHaveAttribute('marker-end', expect.stringMatching(/^url\(#/));
    expect(wait.querySelector('path')!.getAttribute('d')).toMatch(/^M\d+ \d+H\d+V\d+H\d+$/);
    expect(wait.querySelector('text')).toHaveTextContent('waits for →');
    const legend = screen.getByRole('list', { name: 'What the lines mean' });
    expect(within(legend).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'solid line: what it is made of (goal → tasks → subtasks)', 'dashed: waits for or needed for', 'strip at the start: status',
    ]);
    expect(within(legend).getAllByRole('listitem')[1]).toHaveClass('wait');
  });

  it('says where the graph grows from and leads back up to the whole goal', async () => {
    const user = userEvent.setup();
    const onCrumb = vi.fn();
    render(<LanguageProvider><TrackerGraph forest={[node('g2', 'Mailing')]} crumbs={[at('g1', '500 subscribers'), at('g2', 'Mailing')]} top="All goals" onCrumb={onCrumb} rows={rows} onOpenGoal={() => {}} /></LanguageProvider>);
    const crumbs = screen.getByRole('navigation', { name: 'Graph from' });
    expect(crumbs).toHaveTextContent(/^Graph from:/);
    await user.click(screen.getByRole('button', { name: '↑ Whole goal' }));
    expect(onCrumb).toHaveBeenCalledWith(at('g1', '500 subscribers'));
  });

  it('sizes nodes, words and lines as the mockup', () => {
    expect.soft(NODE).toMatchObject({ w: 290, h: 52, dx: 330, dy: 62 });
    expect.soft(decl('.tr-node', 'padding')).toBe('7px 12px 8px');
    expect.soft(decl('.tr-node', 'border')).toBe('1px solid var(--line)');
    expect.soft(decl('.tr-node.goal', 'border')).toBe('1px dashed var(--cyan)');
    expect.soft(decl('.tr-node.goal', 'background')).toBe('var(--surface2)');
    expect.soft(decl('.tr-node-title', 'font-size')).toBe('12.5px');
    expect.soft(decl('.tr-node.goal .tr-node-title', 'font')).toBe('600 13.5px/1.3 var(--f-display)');
    expect.soft(decl('.tr-node-meta', 'font-size')).toBe('11.5px');
    expect.soft(decl('.tr-node-bar', 'block-size')).toBe('3px');
    expect.soft(decl('.tr-wires .wait path', 'stroke-dasharray')).toBe('5 4');
    expect.soft(decl('.tr-crumbs', 'font')).toBe('600 13.5px var(--f-display)');
    expect(decl('.tr-legend', 'font-size')).toBe('12px');
  });
});
