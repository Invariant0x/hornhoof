import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { framedPanel, SidePanelRow, usePanelsCover, useSidePanels, type SidePanel } from '../src/ui/SidePanels';

const NOTE: SidePanel = framedPanel('note', 'Note', 'M0 0', <label>Text<textarea aria-label="Note text" /></label>);
const OTHER: SidePanel = framedPanel('other', 'Other', 'M0 0', 'What the other says');

function Window({ panels, active = true, onEscape }: { panels: SidePanel[]; active?: boolean; onEscape?(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const stack = useSidePanels(panels, box, active);
  return (
    <div onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) onEscape?.(); }}>
      <button type="button">Outside</button>
      <div ref={box} tabIndex={-1} aria-label="Window" role="group">
        {panels.map(p => (
          <button key={p.id} type="button" aria-expanded={stack.isOpen(p.id)} onClick={e => stack.toggle(p.id, e.currentTarget)}>
            Toggle {p.id}
          </button>
        ))}
        <p role="status">{stack.shown.map(p => p.id).join(',')}</p>
        <SidePanelRow stack={stack} id="row" />
      </div>
    </div>
  );
}

function show(panels: SidePanel[], props: { active?: boolean; onEscape?(): void } = {}) {
  return render(
    <LanguageProvider>
      <Window panels={panels} {...props} />
    </LanguageProvider>,
  );
}

const toggle = (id: string) => screen.getByRole('button', { name: `Toggle ${id}` });

/* A window that says whether its open panels cover what stands under them. theme.css does the placing, so the test sets where
   each part ends up. */
function CoveringWindow({ open }: { open: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  const under = useRef<HTMLDivElement>(null);
  const covered = usePanelsCover(row, under, open);
  return (
    <>
      <div ref={row} data-testid="row" />
      <div ref={under} data-testid="under" />
      <p role="status">{covered ? 'covered' : 'in sight'}</p>
    </>
  );
}

function placeAt(places: { row: number; left: number; width: number }) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const right = (this as HTMLElement).dataset.testid === 'row' ? places.row : places.left + places.width;
    return { left: places.left, right, width: places.width } as DOMRect;
  });
}

class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  watched: Element[] = [];
  gone = false;
  constructor(private tell: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element) {
    this.watched.push(el);
  }
  disconnect() {
    this.gone = true;
  }
  resized() {
    act(() => this.tell());
  }
}

describe('what open panels cover', () => {
  const status = () => screen.getByRole('status').textContent;

  afterEach(() => {
    vi.restoreAllMocks();
    FakeResizeObserver.all = [];
  });

  it('is nothing while the row ends where what is under it begins, or left of that', () => {
    placeAt({ row: 100, left: 100, width: 500 });
    render(<CoveringWindow open />);
    expect(status()).toBe('in sight');
  });

  it('is what is under the row once the row reaches over it', () => {
    placeAt({ row: 101, left: 100, width: 500 });
    render(<CoveringWindow open />);
    expect(status()).toBe('covered');
  });

  it('is what has made way for the panels, wherever the row ends', () => {
    placeAt({ row: 0, left: 100, width: 0 });
    render(<CoveringWindow open />);
    expect(status()).toBe('covered');
  });

  it('is nothing with no panel open, wherever things stand, and asks the page nothing', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    placeAt({ row: 900, left: 100, width: 500 });
    render(<CoveringWindow open={false} />);
    expect(status()).toBe('in sight');
    expect(FakeResizeObserver.all).toEqual([]);
  });

  it('follows the row and what is under it as they change size, and the screen', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const places = { row: 100, left: 100, width: 500 };
    placeAt(places);
    const { unmount } = render(<CoveringWindow open />);
    const [watch] = FakeResizeObserver.all;
    expect(watch!.watched).toEqual([screen.getByTestId('row'), screen.getByTestId('under')]);
    expect(status()).toBe('in sight');
    places.row = 400;
    watch!.resized();
    expect(status()).toBe('covered');
    places.row = 100;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(status()).toBe('in sight');
    unmount();
    expect(watch!.gone).toBe(true);
    places.row = 400;
    expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
  });
});

describe('side panels', () => {
  it('opens a panel with one line in a list, in the usual frame with its name and a close button', async () => {
    const user = userEvent.setup();
    show([OTHER]);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(toggle('other')).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle('other'));
    const panel = screen.getByRole('complementary', { name: 'Other' });
    expect(panel).toHaveTextContent('What the other says');
    expect(within(panel).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(toggle('other')).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes with its button and gives the focus back to what opened it', async () => {
    const user = userEvent.setup();
    show([OTHER]);
    await user.click(toggle('other'));
    await user.click(within(screen.getByRole('complementary', { name: 'Other' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Other' })).not.toBeInTheDocument();
    expect(toggle('other')).toHaveFocus();
  });

  it('closes when it is toggled again', async () => {
    const user = userEvent.setup();
    show([OTHER]);
    await user.click(toggle('other'));
    await user.click(toggle('other'));
    expect(screen.queryByRole('complementary', { name: 'Other' })).not.toBeInTheDocument();
    expect(toggle('other')).toHaveFocus();
  });

  it('keeps the panels in the order they were opened', async () => {
    const user = userEvent.setup();
    show([NOTE, OTHER]);
    await user.click(toggle('other'));
    await user.click(toggle('note'));
    expect(screen.getByRole('status')).toHaveTextContent('other,note');
    expect(screen.getAllByRole('complementary').map(p => p.getAttribute('aria-label'))).toEqual(['Other', 'Note']);
  });

  it('tells the stack how many panels stand in it', async () => {
    const user = userEvent.setup();
    const { container } = show([NOTE, OTHER]);
    const row = container.querySelector<HTMLElement>('#row')!;
    await user.click(toggle('note'));
    expect(row.style.getPropertyValue('--panels')).toBe('1');
    await user.click(toggle('other'));
    expect(row.style.getPropertyValue('--panels')).toBe('2');
  });

  it('closes the newest panel on Escape, one at a time, with the focus back on what opened it', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    show([NOTE, OTHER], { onEscape });
    await user.click(toggle('note'));
    await user.click(toggle('other'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toHaveTextContent('note');
    expect(toggle('other')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(toggle('note')).toHaveFocus();
    expect(onEscape).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone while the window is hidden', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const { rerender } = show([OTHER], { onEscape });
    await user.click(toggle('other'));
    rerender(
      <LanguageProvider>
        <Window panels={[OTHER]} active={false} onEscape={onEscape} />
      </LanguageProvider>,
    );
    await user.keyboard('{Escape}');
    expect(screen.getByRole('complementary', { name: 'Other' })).toBeInTheDocument();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('takes an Escape from elsewhere on the page that nothing else took', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    show([OTHER], { onEscape });
    await user.click(toggle('other'));
    screen.getByRole('button', { name: 'Outside' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Other' })).not.toBeInTheDocument();
  });

  it('leaves to an overlay outside the window the Escape it takes first', async () => {
    const user = userEvent.setup();
    show([OTHER]);
    await user.click(toggle('other'));
    const overlay = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', overlay, true);
    try {
      screen.getByRole('button', { name: 'Outside' }).focus();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('complementary', { name: 'Other' })).toBeInTheDocument();
    } finally {
      document.removeEventListener('keydown', overlay, true);
    }
  });

  it('leaves a field with text on the first Escape, so what is being written is not lost, and closes on the next', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    show([NOTE], { onEscape });
    await user.click(toggle('note'));
    const field = screen.getByRole('textbox', { name: 'Note text' });
    await user.type(field, 'A draft');
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('A draft');
    expect(field).not.toHaveFocus();
    expect(onEscape).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Note' })).not.toBeInTheDocument();
  });

  it('closes on Escape from an empty field', async () => {
    const user = userEvent.setup();
    show([NOTE]);
    await user.click(toggle('note'));
    await user.click(screen.getByRole('textbox', { name: 'Note text' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Note' })).not.toBeInTheDocument();
  });

  it('gives the focus to the window when what opened the panel is gone', async () => {
    const user = userEvent.setup();
    const { rerender } = show([NOTE, OTHER]);
    await user.click(toggle('other'));
    rerender(
      <LanguageProvider>
        <Window panels={[NOTE, OTHER]} />
      </LanguageProvider>,
    );
    toggle('other').remove();
    await user.click(within(screen.getByRole('complementary', { name: 'Other' })).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('group', { name: 'Window' })).toHaveFocus();
  });

  it('forgets a panel that is dropped without moving the focus', async () => {
    const user = userEvent.setup();
    const { rerender } = show([NOTE, OTHER]);
    await user.click(toggle('note'));
    rerender(
      <LanguageProvider>
        <Window panels={[OTHER]} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole('complementary', { name: 'Note' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Toggle other' })).toBeInTheDocument();
  });
});
