import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { layoutTree, NODE, type Crumb, type GraphNode } from '../src/tracker';
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

  describe('when a font arrives after the nodes are drawn', () => {
    const own = Object.getOwnPropertyDescriptor(document, 'fonts');
    const measured = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
    afterEach(() => {
      if (own) Object.defineProperty(document, 'fonts', own);
      else delete (document as { fonts?: unknown }).fonts;
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', measured);
    });

    it('measures its nodes again, so the tree is laid out with their words in the font they show in', () => {
      const fonts = new EventTarget();
      Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
      /* A node's words take more room in the fallback font than in its own. */
      let height = 140;
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return (this as HTMLElement).dataset.node ? height : 0; } });
      const { container } = render(graph([node('g1', 'First root', [node('g2', 'Under it')])], []));
      const tall = container.querySelector('.tr-wires')!.getAttribute('height');
      height = 120;
      act(() => { fonts.dispatchEvent(new Event('loadingdone')); });
      expect(Number(container.querySelector('.tr-wires')!.getAttribute('height'))).toBeLessThan(Number(tall));
    });
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

/* Right to left the graph is drawn as a mirror of itself: its root at the right, each level further to the left, the lines
   and the lanes of the waits mirrored with it, while the words in its nodes and labels read in their own direction (#1670). */
describe('the graph right to left', () => {
  const page = document.documentElement;
  /* The canvas's size, which the page has no layout to give, is set on HTMLElement for a test and taken off after it. */
  const own = { clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'), clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight') };
  afterEach(() => {
    page.removeAttribute('dir');
    for (const [name, was] of Object.entries(own)) {
      if (was) Object.defineProperty(HTMLElement.prototype, name, was);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });
  /* A goal with two tasks, the second waiting for the first. */
  const tree = () => [node('g1', 'Mailing', [taskNode(task('t1', 412, 'Find 3D artists')), taskNode(task('t2', 419, 'First wave', { waitsFor: [412] }))])];
  const place = (container: HTMLElement, id: string) => {
    const el = container.querySelector<HTMLElement>(`[data-node="${id}"]`)!;
    return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
  };
  const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

  it('grows from a root at the right, each line leaving a node from the side that faces what is under it', () => {
    page.dir = 'rtl';
    const { container } = render(graph(tree(), []));
    const [root, first, second] = ['g1', 't1', 't2'].map(id => place(container, id));
    expect(root!.x).toBeGreaterThan(first!.x + NODE.w);
    expect(first!.x).toBe(second!.x);
    const parts = [...container.querySelectorAll('.tr-wires .part')].map(p => numbers(p.getAttribute('d')!));
    expect(parts).toHaveLength(2);
    for (const [d, child] of [[parts[0]!, first!], [parts[1]!, second!]] as const) {
      expect(d[0], 'from the root\'s left side').toBe(root!.x);
      expect(d.at(-2), 'to the right side of the task').toBe(child.x + NODE.w);
    }
  });

  it('routes a wait out to a lane left of the tree, back into the node it waits for, and words it next to the waiting node', () => {
    page.dir = 'rtl';
    const { container } = render(graph(tree(), []));
    const [root, first, second] = ['g1', 't1', 't2'].map(id => place(container, id));
    const wait = container.querySelector('.tr-wires .wait')!;
    const d = wait.querySelector('path')!.getAttribute('d')!;
    expect(d).toMatch(/^M\d+ \d+H\d+V\d+H\d+$/);
    const [x1, , lane, , x2] = numbers(d);
    expect(x1, 'from the left side of the waiting task').toBe(second!.x);
    expect(lane, 'its lane left of every node').toBeLessThan(Math.min(root!.x, first!.x, second!.x));
    expect(x2, 'its arrow at the left side of the task it waits for').toBe(first!.x - 2);
    const word = wait.querySelector('text')!;
    expect(word).toHaveTextContent('← waits for');
    expect(word).toHaveAttribute('text-anchor', 'end');
    expect(word).toHaveAttribute('direction', 'ltr');
    expect(Number(word.getAttribute('x'))).toBe(second!.x - 6);
  });

  it('draws the tree again mirrored when the page turns right to left after the tree is drawn', async () => {
    const { container } = render(graph(tree(), []));
    expect(place(container, 'g1').x).toBeLessThan(place(container, 't1').x);
    await act(async () => { page.dir = 'rtl'; });
    expect(place(container, 'g1').x).toBeGreaterThan(place(container, 't1').x + NODE.w);
  });

  it('opens a tree wider than the canvas with its root at the start edge: the right, as the mirror of left to right', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('tr-map') ? 300 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).classList.contains('tr-map') ? 600 : 0; } });
    const view = (container: HTMLElement) => {
      const [x, y, k] = numbers(transform(container));
      return { x: x!, y: y!, k: k! };
    };
    const ltr = render(graph(tree(), []));
    const before = view(ltr.container);
    ltr.unmount();
    page.dir = 'rtl';
    const rtl = render(graph(tree(), []));
    const after = view(rtl.container);
    const [l, r] = [layoutTree(tree()), layoutTree(tree(), undefined, 'rtl')];
    expect(l.width * before.k, 'wider than the canvas').toBeGreaterThan(300);
    expect([after.k, after.y]).toEqual([before.k, before.y]);
    /* The tree's box stands as far from the canvas's right as left to right it stands from its left. */
    expect(300 - (after.x + (r.left + r.width) * after.k)).toBeCloseTo(before.x + l.left * before.k, 6);
  });
});
