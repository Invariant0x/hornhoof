import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shellTopOf, useMeasuredShellTop } from '../src/ui/shellBars';
import { decl, rulesFor } from './css';

/* #1639: on the map the header and the bars of the shell float over the canvas and an open department, which start what
   they show under the last bar. */
const placed = (el: Element, top: number, bottom: number) => {
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 375, width: 375, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
};

function page(...bars: [string, number, number][]) {
  const main = document.createElement('main');
  placed(main, 0, 812);
  for (const [kind, top, bottom] of bars) {
    const bar = document.createElement('div');
    bar.className = kind;
    bar.style.marginBlockEnd = '8px';
    placed(bar, top, bottom);
    main.append(bar);
  }
  document.body.append(main);
  return main;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('shellTopOf', () => {
  it('starts the room under the last bar of the shell and the gap after it', () => {
    expect(shellTopOf(page(['update-banner glass', 68, 112.4]))).toBe(121);
    expect(shellTopOf(page(['update-banner glass', 68, 112], ['alert', 120, 160]))).toBe(168);
    expect(shellTopOf(page(['guard-stop', 68, 128]))).toBe(136);
  });

  it('has no room of its own while no bar of the shell stands', () => {
    expect(shellTopOf(page())).toBeNull();
    /* A stopped window floats on its own over the page, and a bar with nothing in it takes no row. */
    expect(shellTopOf(page(['guard-stop float', 600, 700], ['alert', 68, 68]))).toBeNull();
  });
});

describe('useMeasuredShellTop', () => {
  function Probe({ seen }: { seen: (top: number | null) => void }) {
    const main = useRef<HTMLElement>(null);
    seen(useMeasuredShellTop(main));
    return <main ref={main} />;
  }

  it('measures again as a bar comes and goes', async () => {
    let top: number | null | undefined;
    const view = render(<Probe seen={t => { top = t; }} />);
    const main = view.container.querySelector('main')!;
    placed(main, 0, 812);
    expect(top).toBeNull();
    const bar = document.createElement('div');
    bar.className = 'update-banner';
    bar.style.marginBlockEnd = '8px';
    placed(bar, 68, 112);
    await act(async () => { main.append(bar); });
    expect(top).toBe(120);
    await act(async () => { bar.remove(); });
    expect(top).toBeNull();
  });
});

describe('the map and an open department under the bars of the shell', () => {
  it('no longer moves them down into a row under the bars: they fill the window from its top', () => {
    expect(rulesFor('.body:not(.page):has(> :is(.update-banner, .alert, .guard-stop))')).toEqual([]);
    expect(decl('.map', 'inset')).toBe('0');
    expect(decl('.dview', 'inset')).toBe('0');
  });

  /* Design on #1639: a window or a card opens 8 px under the last element at the top: under the bar while one stands, as
     the room under the bars starts, else under the header. An open department's name plate is one too, as tall as its
     name wraps: the shell gives its height and the 8 px under it as --plate-room. The plate starts where the room under
     the bars does, or beside the logo on a wide screen without a bar. With no department open a phone's card keeps its
     place, where the name would stand, and a phone's window covers the page under the top bar. */
  it("opens the windows and the cards under the bars, and under an open department's name as tall as it is", () => {
    const under = 'max(var(--shell-top, 68px), calc(var(--shell-top, 12px) + var(--plate-room, 0px)))';
    expect(decl('.orch', 'top')).toBe(under);
    expect(decl('.agent-strips', 'top')).toBe(under);
    expect(decl('.acard', 'top')).toBe(under);
    expect(decl('.orch', 'top', '(max-width: 760px)')).toBe('var(--shell-top, 56px)');
    expect(decl('.acard', 'top', '(max-width: 760px)')).toBe('calc(var(--shell-top, 64px) + var(--plate-room, 52px))');
  });

  it("starts the department's name under the bars while one stands, beside the logo or under the top bar while none does", () => {
    expect(decl('.crumbs', 'top')).toBe('var(--shell-top, 12px)');
    expect(decl('.crumbs', 'top', '(max-width: 760px)')).toBe('var(--shell-top, 64px)');
  });
});
