import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TreeView } from '../src/screens/TreeView';
import { DEV_TREE, TREE_ORG } from './api-mock';

function view(tree = DEV_TREE) {
  return <LanguageProvider><TreeView tree={tree} department={TREE_ORG.departments.find(d => d.id === 'd2')!} onOpenTask={() => {}} /></LanguageProvider>;
}

function show() {
  render(view());
  return document.querySelector<HTMLElement>('.tv-in')!;
}

function position(world: HTMLElement) {
  const match = /translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/.exec(world.style.transform);
  if (!match) throw new Error('The tree has no canvas transform');
  return match.slice(1).map(Number) as [number, number, number];
}

describe('Tree navigation', () => {
  it('fits a long tree below the usual zoom floor and can return to that size', async () => {
    vi.stubGlobal('innerWidth', 375);
    const user = userEvent.setup();
    render(view({ ...DEV_TREE, now: '2026-10-31T09:00:00.000Z' }));
    const world = document.querySelector<HTMLElement>('.tv-in')!;
    const [x, , k] = position(world);
    expect(k).toBeLessThan(.3);
    const drawingWidth = Number(world.querySelector('svg[role="group"]')!.getAttribute('width')) + parseFloat(world.querySelector<HTMLElement>('.tv-labs')!.style.width);
    expect(x + drawingWidth * k).toBeLessThanOrEqual(331);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.wheel(screen.getByRole('region', { name: 'Work tree' }), { deltaY: 100_000 });
    expect(position(world)[2]).toBe(k);
  });

  it('keeps the chosen view through live updates and refits when the viewport changes', async () => {
    vi.stubGlobal('innerWidth', 375);
    const measurements: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(measure: () => void) { measurements.push(measure); }
      observe() {}
      disconnect() {}
    });
    const user = userEvent.setup(), { rerender } = render(view());
    const world = document.querySelector<HTMLElement>('.tv-in')!;
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    const chosen = position(world);
    rerender(view({ ...DEV_TREE, now: new Date(Date.parse(DEV_TREE.now) + 60_000).toISOString() }));
    expect(position(world)).toEqual(chosen);
    Object.defineProperty(document.querySelector('.tview'), 'clientWidth', { value: 600 });
    act(() => measurements.forEach(measure => measure()));
    expect(position(world)).not.toEqual(chosen);
  });

  it.each(['mouse', 'touch'] as const)('pans the read-only tree with %s without changing its drawing or opening a card', async pointer => {
    const user = userEvent.setup(), world = show();
    const viewport = screen.getByRole('region', { name: 'Work tree' });
    const paths = [...world.querySelectorAll('path')].map(p => p.getAttribute('d'));
    const [x, y, k] = position(world);
    const key = pointer === 'mouse' ? 'MouseLeft' : 'TouchA';
    await user.pointer([
      { keys: `[${key}>]`, target: viewport, coords: { clientX: 100, clientY: 100 } },
      { pointerName: pointer === 'mouse' ? 'mouse' : 'TouchA', target: viewport, coords: { clientX: 180, clientY: 140 } },
      { keys: `[/${key}]`, target: viewport },
    ]);
    expect(position(world)).toEqual([x + 80, y + 40, k]);
    expect([...world.querySelectorAll('path')].map(p => p.getAttribute('d'))).toEqual(paths);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('zooms at the wheel pointer and uses the map button step and limits', async () => {
    const user = userEvent.setup(), world = show();
    const viewport = screen.getByRole('region', { name: 'Work tree' });
    const [x, y, k] = position(world);
    fireEvent.wheel(viewport, { deltaY: -100, clientX: 200, clientY: 150 });
    const [wx, wy, wk] = position(world);
    expect(wk).toBeCloseTo(k * Math.exp(.15));
    expect((200 - wx) / wk).toBeCloseTo((200 - x) / k);
    expect((150 - wy) / wk).toBeCloseTo((150 - y) / k);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(position(world)[2]).toBeCloseTo(wk * 1.2);
    fireEvent.wheel(viewport, { deltaY: -100_000 });
    expect(position(world)[2]).toBe(2.5);
    fireEvent.wheel(viewport, { deltaY: 100_000 });
    expect(position(world)[2]).toBe(.3);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('fits the whole drawing again after dragging and zooming', async () => {
    const user = userEvent.setup(), world = show();
    const fitted = position(world);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(position(world)).not.toEqual(fitted);
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(position(world)).toEqual(fitted);
  });

  it('fits again after keyboard focus scrolls a clipped row into view', async () => {
    const user = userEvent.setup();
    show();
    const viewport = screen.getByRole('region', { name: 'Work tree' });
    viewport.scrollLeft = 180;
    viewport.scrollTop = 250;
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
  });

  it('does not open a branch after dragging it, and still opens it from the keyboard', async () => {
    const user = userEvent.setup(), world = show();
    const branch = world.querySelector<HTMLButtonElement>('.lchip')!;
    await user.pointer([
      { keys: '[MouseLeft>]', target: branch, coords: { clientX: 10, clientY: 10 } },
      { target: branch, coords: { clientX: 90, clientY: 50 } },
      { keys: '[/MouseLeft]', target: branch },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    branch.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'main' })).toBeInTheDocument();
  });
});
