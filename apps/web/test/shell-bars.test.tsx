import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardBoundary } from '../src/ui/GuardBoundary';
import { ShellBarsHost, shellTopOf, useMeasuredShellTop } from '../src/ui/shellBars';
import { decl, RULES, rulesFor } from './css';

/* #1639: on the map the header and the bars of the shell float over the canvas and an open department, which start what
   they show under the last bar. */
const placed = (el: Element, top: number, bottom: number) => {
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 375, width: 375, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
};

function page(...bars: [string, number, number][]) {
  return pageApart('8px', ...bars);
}

/* apart: the gap the bars stand apart, as their margin under them. */
function pageApart(apart: string, ...bars: [string, number, number][]) {
  const main = document.createElement('main');
  placed(main, 0, 812);
  const stack = document.createElement('div');
  stack.className = 'shell-bars';
  for (const [kind, top, bottom] of bars) {
    const bar = document.createElement('div');
    bar.className = kind;
    bar.style.marginBlockEnd = apart;
    placed(bar, top, bottom);
    stack.append(bar);
  }
  main.append(stack);
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

  /* On a phone the blocks of the menu and the bars stand 6 px apart, and what the page shows still starts 8 px under the last
     (Design's rule on #1635). */
  it('starts the room 8 px under the last bar however far apart the bars stand', () => {
    expect(shellTopOf(pageApart('6px', ['update-banner glass', 62, 110], ['alert', 116, 160]))).toBe(168);
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

  it('measures again as a bar comes and goes inside .shell-bars', async () => {
    let top: number | null | undefined;
    const view = render(<Probe seen={t => { top = t; }} />);
    const main = view.container.querySelector('main')!;
    const stack = document.createElement('div');
    stack.className = 'shell-bars';
    main.append(stack);
    placed(main, 0, 812);
    expect(top).toBeNull();
    const bar = document.createElement('div');
    bar.className = 'update-banner';
    bar.style.marginBlockEnd = '8px';
    placed(bar, 68, 112);
    await act(async () => { stack.append(bar); });
    expect(top).toBe(120);
    await act(async () => { bar.remove(); });
    expect(top).toBeNull();
  });

  it('portals a non-floating GuardBoundary stop plate into ShellBarsHost while floating boundaries render inline', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never { throw new Error('boom'); }
    const host = document.createElement('div');
    host.className = 'shell-bars';
    document.body.append(host);
    const { container } = render(
      <ShellBarsHost value={host}>
        <GuardBoundary block="department"><Broken /></GuardBoundary>
        <GuardBoundary block="window" float><Broken /></GuardBoundary>
      </ShellBarsHost>,
    );
    expect(host.querySelector('.guard-stop:not(.float)')).not.toBeNull();
    expect(container.querySelector('.guard-stop.float')).not.toBeNull();
  });
});

describe('the map and an open department under the bars of the shell', () => {
  it('lays shell bars over the full-viewport world in a dedicated HUD stack with pass-through pointer events (#1874)', () => {
    expect(rulesFor('.body:not(.page):has(> :is(.update-banner, .alert, .guard-stop))')).toEqual([]);
    expect(decl('.body:not(.page)', 'overflow')).toBe('hidden');
    expect(decl('.body:not(.page)::before', 'content')).toBe('none');
    expect(decl('.body:not(.page) > .shell-bars', 'position')).toBe('absolute');
    expect(decl('.body:not(.page) > .shell-bars', 'inset-block-start')).toBe('var(--header-room)');
    expect(decl('.body:not(.page) > .shell-bars', 'inset-inline')).toBe('var(--bar-edge)');
    expect(decl('.body:not(.page) > .shell-bars', 'gap')).toBe('var(--bar-gap)');
    expect(decl('.body:not(.page) > .shell-bars', 'pointer-events')).toBe('none');
    expect(decl('.body:not(.page) > .shell-bars > :is(.update-banner, .alert, .guard-stop)', 'pointer-events')).toBe('auto');
    expect(decl('.map', 'inset')).toBe('0');
    expect(decl('.dview', 'inset')).toBe('0');
  });

  it('never shrinks the world container for a narrow-screen agent strip; only scrollable pages leave 44 px (#1874)', () => {
    const narrow = '(max-width: 760px)';
    expect(rulesFor('.shell:has(.agent-strip) .body')).toEqual([]);
    expect(decl('.shell:has(.agent-strip) .body.page', 'bottom', narrow)).toBe('44px');
  });

  /* Design on #1639: a window or a card opens 8 px under the last element at the top: under the bar while one stands, as
     the room under the bars starts, else under the header. An open department's name plate is one too, as tall as its
     name wraps: the shell gives its height and the 8 px under it as --plate-room. The plate starts where the room under
     the bars does, or 8 px under the menu without a bar, on every screen (#1635), and so do the windows without one
     (Design's decision on #1635), a phone's too, which covers the page under that. With no department open a phone's card
     keeps its place, where the name would stand. */
  it("opens the windows and the cards under the bars, and under an open department's name as tall as it is", () => {
    const under = 'calc(var(--shell-top, var(--under-menu)) + var(--plate-room, 0px))';
    expect(decl('.orch', 'top')).toBe(under);
    expect(decl('.agent-strips', 'top')).toBe(under);
    expect(decl('.acard', 'top')).toBe(under);
    expect(decl('.orch', 'top', '(max-width: 760px)')).toBe('var(--shell-top, var(--under-menu))');
    expect(decl('.acard', 'top', '(max-width: 760px)')).toBe('calc(var(--shell-top, var(--under-menu)) + var(--plate-room, 52px))');
  });

  /* A page keeps its own opaque header room (#1635 is for the map and the department): its windows and cards open under it
     as before, or under a bar of the shell while one stands. */
  it('opens the windows and the cards of a page under its header room, as before', () => {
    expect(decl('.body.page ~ :is(.orch:not(.fullscreen), .dv-drawer, .acard, .agent-strips)', 'top', '(min-width: 761px)')).toBe('var(--shell-top, 68px)');
    expect(decl('.body.page ~ .orch:not(.fullscreen)', 'top', '(max-width: 760px)')).toBe('var(--shell-top, 56px)');
  });

  /* A window in full screen covers the whole screen on a page too, as before #1635: a page's rule for where its windows
     open stands one class above the full-screen one, so it must not name a window in full screen. */
  it('leaves a window in full screen over the whole screen of a page, its header room too', () => {
    expect(decl('.orch.fullscreen', 'inset')).toBe('0 var(--inset) 0 0');
    const where = RULES.filter(r => 'top' in r.decls).flatMap(r => r.selectors).filter(s => s.startsWith('.body.page ~') && /\.orch\b/.test(s));
    expect(where).toHaveLength(2);
    for (const selector of where) expect(selector).toContain('.orch:not(.fullscreen)');
  });

  it("starts the department's name under the bars while one stands, and 8 px under the menu while none does, on every screen", () => {
    expect(decl('.crumbs', 'transform')).toBe('translateY(var(--shell-top, var(--under-menu)))');
    expect(decl('.crumbs', 'inset-inline-start')).toBe('var(--bar-edge)');
    expect(decl('.crumbs', 'top', '(max-width: 760px)')).toBeUndefined();
    expect(decl('.crumbs', 'inset-inline-start', '(max-width: 760px)')).toBeUndefined();
  });
});
