import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const drawingWidth = (world: HTMLElement) => Number(world.querySelector('svg[role="group"]')!.getAttribute('width')) + parseFloat(world.querySelector<HTMLElement>('.tv-labs')!.style.width);

function position(world: HTMLElement) {
  const match = /translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/.exec(world.style.transform);
  if (!match) throw new Error('The tree has no canvas transform');
  return match.slice(1).map(Number) as [number, number, number];
}

describe('Tree plates', () => {
  const agent = DEV_TREE.lines[0]!.agent.id;
  const rowHeight = (row: string) => Number(document.querySelector(`rect.rowhit[data-row="${row}"][x="0"]`)!.getAttribute('height'));
  afterEach(() => { delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight; });
  function plateHeights(height: (row: string) => number) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return height(this.dataset.row ?? ''); } });
  }

  it('gives a row the height its plate takes on the page', () => {
    plateHeights(row => row === agent ? 130 : 0);
    show();
    expect(rowHeight(agent)).toBe(142);
    expect(rowHeight('main')).toBe(40);
  });

  it('follows a plate that grows later, as a new text or font makes it', () => {
    const observers: { measure: () => void; seen: Element[]; gone: boolean }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      own = { measure: () => {}, seen: [] as Element[], gone: false };
      constructor(measure: () => void) { this.own.measure = measure; observers.push(this.own); }
      observe(el: Element) { this.own.seen.push(el); }
      disconnect() { this.own.gone = true; }
    });
    let plate = 90;
    plateHeights(row => row === agent ? plate : 0);
    const { unmount } = render(view());
    expect(rowHeight(agent)).toBe(102);
    const watching = observers.find(o => o.seen.some(el => el.classList.contains('lchip')))!;
    expect(watching.seen).toEqual([...document.querySelectorAll('.lchip')]);
    plate = 150;
    act(() => watching.measure());
    expect(rowHeight(agent)).toBe(162);
    unmount();
    expect(watching.gone).toBe(true);
  });

  it('watches a plate that appears with a new lane', () => {
    const watched: Element[] = [];
    vi.stubGlobal('ResizeObserver', class {
      observe(el: Element) { watched.push(el); }
      disconnect() {}
    });
    const { rerender } = render(view({ ...DEV_TREE, lines: DEV_TREE.lines.slice(0, 1) }));
    const added = DEV_TREE.lines[1]!.agent.id;
    expect(document.querySelector(`.lchip[data-row="${added}"]`)).toBeNull();
    rerender(view(DEV_TREE));
    expect(watched).toContain(document.querySelector(`.lchip[data-row="${added}"]`));
  });

  it('keeps a plate on its row and gives it its natural height at the least', () => {
    show();
    const main = document.querySelector<HTMLElement>('.lchip[data-row="main"]')!, turn = document.querySelector<HTMLElement>('.lchip[data-row="turn"]')!;
    const lane = document.querySelector<HTMLElement>(`.lchip[data-row="${agent}"]`)!;
    expect([main.style.top, main.style.minHeight]).toEqual(['36px', '32px']);
    expect([turn.style.top, turn.style.minHeight]).toEqual(['76px', '40px']);
    expect(lane.style.minHeight).toBe('84px');
    expect(parseFloat(lane.style.top)).toBe(32 + 40 + 48 + 6 + 96 * [...document.querySelectorAll('.lchip:not(.tk)')].indexOf(lane));
  });

  it('names the role beside the name, in the language of the screen, and only when it says something more', () => {
    const department = TREE_ORG.departments.find(d => d.id === 'd2')!;
    const employee = department.employees.find(e => e.id === agent)!;
    const named = (name: string) => ({ ...department, employees: department.employees.map(e => e.id === agent ? { ...e, name, title: { en: 'Developer', ru: 'Разработчик' } } : e) });
    const plate = (dept: typeof department, lang: 'en' | 'ru') => {
      localStorage.setItem('hh-lang', lang);
      const { unmount } = render(<LanguageProvider><TreeView tree={DEV_TREE} department={dept} onOpenTask={() => {}} /></LanguageProvider>);
      const text = document.querySelector(`.lchip[data-row="${agent}"] .tv-role`)?.textContent ?? null;
      unmount();
      return text;
    };
    expect(plate(named(employee.name), 'en')).toBe('Developer');
    expect(plate(named(employee.name), 'ru')).toBe('Разработчик');
    expect(plate(named('Developer'), 'en')).toBeNull();
    expect(plate({ ...department, employees: department.employees.filter(e => e.id !== agent) }, 'en')).toBeNull();
    localStorage.removeItem('hh-lang');
  });

  it('shows the task and its title on every screen', () => {
    vi.stubGlobal('innerWidth', 375);
    show();
    const line = DEV_TREE.lines[0]!;
    expect(document.querySelector(`.lchip[data-row="${agent}"] .r2`)).toHaveTextContent(`#${line.number} ${line.title}`);
  });

  it('draws what an agent waits for in one line, a phone too, and makes room for it', () => {
    vi.stubGlobal('innerWidth', 375);
    const world = show(), svg = world.querySelector('svg[role="group"]')!;
    const texts = [...svg.querySelectorAll('.bdg .bdg-t')];
    expect(texts.length).toBeGreaterThan(0);
    expect(svg.querySelector('foreignObject')).toBeNull();
    for (const text of texts) {
      const badge = text.closest('.bdg')!, x = Number(text.getAttribute('x'));
      const right = Math.max(...badge.querySelector('polygon')!.getAttribute('points')!.split(' ').map(point => Number(point.split(',')[0])));
      expect(right - x).toBeGreaterThan(text.textContent!.length * 6);
      expect(right + 12).toBeLessThanOrEqual(Number(svg.getAttribute('width')));
    }
  });
});

describe('Tree navigation', () => {
  it('opens at 100% from its root however long the tree is', () => {
    vi.stubGlobal('innerWidth', 375);
    render(view({ ...DEV_TREE, now: '2026-10-31T09:00:00.000Z' }));
    expect(position(document.querySelector<HTMLElement>('.tv-in')!)).toEqual([12, 12, 1]);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('keeps a short tree in the middle at 100%, as it keeps it for Show everything', async () => {
    const user = userEvent.setup();
    render(view());
    const world = document.querySelector<HTMLElement>('.tv-in')!;
    Object.defineProperty(document.querySelector('.tview'), 'clientWidth', { value: 4000, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(position(world)[0]).toBe(Math.max(12, (992 - drawingWidth(world) * position(world)[2]) / 2));
  });

  it('shows all of a long tree below the usual zoom floor on request and can return to that size', async () => {
    vi.stubGlobal('innerWidth', 375);
    const user = userEvent.setup();
    render(view({ ...DEV_TREE, now: '2026-10-31T09:00:00.000Z' }));
    const world = document.querySelector<HTMLElement>('.tv-in')!;
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
    const [x, , k] = position(world);
    expect(k).toBeLessThan(.3);
    expect(x + drawingWidth(world) * k).toBeLessThanOrEqual(331);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.wheel(screen.getByRole('region', { name: 'Work tree' }), { deltaY: 100_000 });
    expect(position(world)[2]).toBe(k);
  });

  it('reaches the size that shows everything with the wheel alone, from the opening', () => {
    vi.stubGlobal('innerWidth', 375);
    render(view({ ...DEV_TREE, now: '2026-10-31T09:00:00.000Z' }));
    const world = document.querySelector<HTMLElement>('.tv-in')!;
    fireEvent.wheel(screen.getByRole('region', { name: 'Work tree' }), { deltaY: 100_000 });
    const floor = position(world)[2];
    expect(floor).toBeLessThan(.3);
    expect(floor).toBe(Math.min(1, 319 / drawingWidth(world), 720 / Number(world.querySelector('svg[role="group"]')!.getAttribute('height'))));
  });

  it('keeps the chosen view through live updates and opens again at 100% when the viewport changes', async () => {
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
    expect(position(world)).toEqual([12, 12, 1]);
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
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
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

  it('opens from the root again after keyboard focus scrolled a row into view', () => {
    const measurements: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(measure: () => void) { measurements.push(measure); }
      observe() {}
      disconnect() {}
    });
    show();
    const viewport = screen.getByRole('region', { name: 'Work tree' });
    viewport.scrollLeft = 180;
    viewport.scrollTop = 250;
    Object.defineProperty(document.querySelector('.tview'), 'clientWidth', { value: 600 });
    act(() => measurements.forEach(measure => measure()));
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
