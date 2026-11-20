import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FLOAT_GAP } from '../src/ui/canvas';
import { cornerLift, MapVersion } from '../src/ui/VersionMark';
import { mockApi } from './api-mock';

/* A box from its left to its right and its top to its bottom, on the screen. */
const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

/* The version stands in the bottom end corner of the map's room; it rises over a bar of the map only where one stands in its
   column, FLOAT_GAP clear of it (#1590). The version here: 100 px wide, 16 px tall, its bottom 4 px over a window 900 px tall. */
describe('cornerLift', () => {
  const mark = rect(1328, 880, 1428, 896);

  it('leaves the version where it stands when no bar stands in its column', () => {
    expect(cornerLift(mark, 0, [])).toBe(0);
    /* The zoom at the start and the orchestrator's line in the middle of a wide screen left to right. */
    expect(cornerLift(mark, 0, [rect(16, 838, 203, 884), rect(559, 838, 881, 884)])).toBe(0);
  });

  it('leaves it where it stands over bars it is already FLOAT_GAP clear of, as over the dock of a phone', () => {
    /* A phone: the room ends FLOAT_GAP over the orchestrator's line, and the version 4 px over the end of the room. */
    expect(cornerLift(rect(263, 666, 363, 682), 0, [rect(27, 694, 349, 740), rect(16, 750, 202, 796)])).toBe(0);
  });

  it('rises FLOAT_GAP over the zoom when the zoom stands in its corner, as on a wide screen right to left', () => {
    const zoom = rect(16, 838, 203, 884);
    expect(cornerLift(rect(12, 880, 112, 896), 0, [zoom])).toBe(896 - (838 - FLOAT_GAP));
  });

  it('rises over every bar stacked in its column, Put back over the zoom', () => {
    const zoom = rect(16, 838, 203, 884), putBack = rect(16, 780, 140, 824);
    expect(cornerLift(rect(12, 880, 112, 896), 0, [putBack, zoom])).toBe(896 - (780 - FLOAT_GAP));
  });

  it('measures from where the room puts it, so it comes back down once the bar goes, and stays up while it stands', () => {
    const zoom = rect(16, 838, 203, 884), lift = 896 - (838 - FLOAT_GAP);
    const lifted = rect(12, 880 - lift, 112, 896 - lift);
    expect(cornerLift(lifted, lift, [zoom])).toBe(lift);
    expect(cornerLift(lifted, lift, [])).toBe(0);
  });

  it('takes no account of a bar that is not drawn', () => {
    expect(cornerLift(rect(12, 880, 112, 896), 0, [rect(0, 0, 0, 0), rect(16, 838, 16, 884)])).toBe(0);
  });
});

/* The version over a map with its zoom in the end corner, as on a wide screen right to left: what it measures, it stands on. */
describe('MapVersion', () => {
  it('stands on the bar in its corner as it measures it, and comes back down to its place once the bar goes', async () => {
    let resized: ResizeObserverCallback = () => {};
    const watched: Element[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resized = callback; }
      observe(element: Element) { watched.push(element); }
      disconnect() { watched.length = 0; }
    });
    mockApi({ 'GET /api/version': [200, { version: '0.39.1', commit: 'a276aa6c0ffee' }] });
    const { container } = render(<div className="map"><div className="zoom" /><MapVersion bars=":scope > .zoom" shown="zoom" /></div>);
    const zoom = container.querySelector('.zoom')!, mark = container.querySelector<HTMLElement>('.map-version')!;
    await waitFor(() => expect(mark).toHaveTextContent('0.39.1 (a276aa6)'));
    expect(watched).toEqual([container.querySelector('.map'), mark, zoom]);
    /* Where the room puts it, risen by what it says now. */
    const lifted = () => parseFloat(mark.style.getPropertyValue('--lift') || '0');
    mark.getBoundingClientRect = () => new DOMRect(12, 880 - lifted(), 100, 16);
    zoom.getBoundingClientRect = () => new DOMRect(16, 838, 187, 46);
    act(() => resized([], {} as ResizeObserver));
    expect(mark.style.getPropertyValue('--lift')).toBe(`${896 - (838 - FLOAT_GAP)}px`);
    act(() => resized([], {} as ResizeObserver));
    expect(lifted()).toBe(896 - (838 - FLOAT_GAP));
    zoom.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    act(() => resized([], {} as ResizeObserver));
    expect(mark.style.getPropertyValue('--lift')).toBe('');
  });
});
