import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Crumb, GraphNode } from '../src/tracker';
import type { GoalView } from '../src/types';
import { TrackerGraph } from '../src/ui/TrackerViews';

const goal = (id: string, title: string): GoalView => ({
  id, number: 1, title, why: '', department: null, parentId: null, responsible: null, target: null, current: null, unit: '', dueAt: null, status: 'active', progress: null, done: 0, total: 0, version: 0, mayEdit: true,
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
