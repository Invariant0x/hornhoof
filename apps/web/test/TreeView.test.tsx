import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindowContext } from '../src/screens/AgentWindowContext';
import { DepartmentView } from '../src/screens/Department';
import { TreeView } from '../src/screens/TreeView';
import { DEV_TREE, ME, REVIEW_TREE, TREE_ORG } from './api-mock';
import { taskRoute } from './task-route';

function view(tree = DEV_TREE, department = TREE_ORG.departments.find(d => d.id === 'd2')!) {
  return <LanguageProvider><TreeView tree={tree} department={department} onOpenTask={() => {}} /></LanguageProvider>;
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
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses the department Chip with the same text and at least its size for every lane', () => {
    const department = TREE_ORG.departments.find(d => d.id === 'd2')!;
    render(<LanguageProvider><DepartmentView me={ME} department={department} deputies={[]} selected={null} panel={null} onBack={() => {}} onHire={() => {}} onOpen={() => {}} onOpenTask={() => {}} /></LanguageProvider>);
    const expected = document.querySelector('.schip')!.textContent;
    show();
    const chips = [...document.querySelectorAll<HTMLElement>('.tv-labs .dept-chip')];
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect([chip.style.width, chip.style.height, chip.style.minHeight]).toEqual(['240px', '', '84px']);
      expect(rowHeight(chip.dataset.row!)).toBe(96);
    }
    expect(document.querySelector(`.dept-chip[data-row="${agent}"] .schip`)!.textContent).toBe(expected);
    expect(document.querySelector(`.dept-chip[data-row="${agent}"] .r2`)).toHaveTextContent('Claude Sonnet 5.5');
  });

  it('grows a lane with a plate whose long task title takes more lines, and moves the lanes under it down', () => {
    const { rerender } = render(view());
    const plates = () => [...document.querySelectorAll<HTMLElement>('.tv-labs .dept-chip')];
    const tops = plates().map(chip => parseFloat(chip.style.top));
    expect(tops.length).toBeGreaterThan(1);
    const long = 'Move the checkout to the new payment_provider_and_keep_every_old_receipt_readable in both languages for years';
    /* jsdom lays nothing out: the plate with the long title measures 130 px and the rest nothing, so they keep their size. */
    const tall = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('dept-chip') && this.textContent!.includes(long) ? 130 : 0;
    });
    const department = TREE_ORG.departments.find(d => d.id === 'd2')!;
    const task = { id: 't-long', number: 77, title: long, echelons: taskRoute() };
    rerender(view(DEV_TREE, { ...department, employees: department.employees.map(e => (e.id === agent ? { ...e, task } : e)) }));
    expect(document.querySelector(`.dept-chip[data-row="${agent}"] .r3`)).toHaveTextContent(`#77 ${long}`);
    expect(rowHeight(agent)).toBe(130 + 12);
    expect(plates().map(chip => parseFloat(chip.style.top))).toEqual(tops.map((top, i) => (i ? top + 130 - 84 : top)));
    expect(plates().map(chip => [chip.style.width, chip.style.minHeight])).toEqual(plates().map(() => ['240px', '84px']));
    tall.mockRestore();
  });

  it('puts the lane role, task and current state into TreeCard on click', async () => {
    const user = userEvent.setup(), openAgent = vi.fn();
    render(<AgentWindowContext.Provider value={openAgent}><LanguageProvider><TreeView tree={DEV_TREE} department={TREE_ORG.departments.find(d => d.id === 'd2')!} onOpenTask={() => {}} /></LanguageProvider></AgentWindowContext.Provider>);
    await user.click(document.querySelector(`.dept-chip[data-row="${agent}"] .schip`)!);
    const card = screen.getByRole('dialog');
    const line = DEV_TREE.lines[0]!;
    expect(card).toHaveTextContent('Backend engineer');
    expect(card).toHaveTextContent(`#${line.number} ${line.title}`);
    expect(openAgent).not.toHaveBeenCalled();
    await user.click(within(card).getByRole('button', { name: /Bruno/ }));
    expect(openAgent).toHaveBeenCalledWith(agent);
  });

  it('keeps the current task workflow and findings beside its owner lane', async () => {
    const user = userEvent.setup(), line = REVIEW_TREE.lines.find(line => line.echelons.stage === 'review')!;
    render(view(REVIEW_TREE));
    await user.click(document.querySelector(`.dept-chip[data-row="${line.agent.id}"] .schip`)!);
    const card = screen.getByRole('dialog');
    expect(card).toHaveTextContent(`#${line.number} ${line.title}`);
    expect(within(card).getByRole('list', { name: 'Task workflow' })).toHaveTextContent('Review In progressOwner: Vera');
    expect(within(card).getByRole('region', { name: 'Findings by stage' })).toHaveTextContent('Unique findings: 2');
  });

  it('lets a row be clicked as far as the drawing goes, past a long badge too', () => {
    vi.stubGlobal('innerWidth', 375);
    const world = show(), svg = world.querySelector('svg[role="group"]')!;
    const rows = [...svg.querySelectorAll('rect.rowhit[x="0"]')];
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(row.getAttribute('width')).toBe(svg.getAttribute('width'));
    const parts = [...svg.querySelectorAll('rect.rowhit:not([x="0"])')], marks = [...svg.querySelectorAll('circle.hit')];
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) expect(Number(part.getAttribute('x')) + Number(part.getAttribute('width'))).toBeLessThanOrEqual(Number(svg.getAttribute('width')));
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.getAttribute('r')).toBe('10');
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

  it('turns the scroll of keyboard focus into a move, so zoom keeps its anchor', () => {
    const world = show(), viewport = screen.getByRole('region', { name: 'Work tree' });
    const [x, y, k] = position(world);
    viewport.scrollLeft = 180;
    viewport.scrollTop = 250;
    fireEvent.scroll(viewport);
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
    expect(position(world)).toEqual([x - 180, y - 250, k]);
    fireEvent.scroll(viewport);
    expect(position(world)).toEqual([x - 180, y - 250, k]);
    fireEvent.wheel(viewport, { deltaY: -100, clientX: 200, clientY: 150 });
    const [wx, wy, wk] = position(world);
    expect((200 - wx) / wk).toBeCloseTo((200 - (x - 180)) / k);
    expect((150 - wy) / wk).toBeCloseTo((150 - (y - 250)) / k);
  });

  it('keeps the chosen view when only the height of the viewport changes', async () => {
    const measurements: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(measure: () => void) { measurements.push(measure); }
      observe() {}
      disconnect() {}
    });
    const user = userEvent.setup(), world = show();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    const chosen = position(world);
    Object.defineProperty(document.querySelector('.tview'), 'clientHeight', { value: 300 });
    act(() => measurements.forEach(measure => measure()));
    expect(position(world)).toEqual(chosen);
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(position(world)[2]).toBeCloseTo(276 / Number(world.querySelector('svg[role="group"]')!.getAttribute('height')));
  });

  it('never zooms in on Zoom out when a smaller tree arrives while far zoomed out', async () => {
    vi.stubGlobal('innerWidth', 375);
    const user = userEvent.setup(), long = { ...DEV_TREE, now: '2026-10-31T09:00:00.000Z' }, { rerender } = render(view(long));
    const world = document.querySelector<HTMLElement>('.tv-in')!;
    await user.click(screen.getByRole('button', { name: 'Show everything' }));
    const far = position(world)[2];
    expect(far).toBeLessThan(.3);
    rerender(view({ ...DEV_TREE, lines: DEV_TREE.lines.slice(0, 1), idle: [], waiting: [], activity: [] }));
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(position(world)[2]).toBeLessThanOrEqual(far);
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
