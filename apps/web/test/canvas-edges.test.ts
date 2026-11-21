import { describe, expect, it } from 'vitest';
import { FLOAT_GAP, SIDE_GAP, freeRoom, keptToEdges, scrollRange, type Edges, type View } from '../src/ui/canvas';
import { MAP_READABLE_K, PHONE_MAP_READABLE_K, mapView } from '../src/screens/Map';
import { rulesFor } from './css';

/* The Head of Design's rule for #1539 (19.11), for #1554: a canvas that does not fit opens readable and scrolls, and the
   hand stops it at each edge with its content clear of what floats over it. */
const view = (x: number, y: number, k = 1): View => ({ x, y, k, smooth: false });
/* A world 1000 by 600 in a room from 16 to 359 across and from 116 to 619 down, a phone's. */
const PHONE: Edges = { content: { x0: 0, y0: 0, x1: 1000, y1: 600 }, room: { x0: 16, y0: 116, x1: 359, y1: 619 } };

describe('scrollRange', () => {
  it('scrolls content larger than the room until each of its edges meets the room\'s', () => {
    const [lo, hi] = scrollRange(0, 1000, 1, 16, 359);
    expect(hi).toBe(16);
    expect(lo + 1000).toBe(359);
  });

  it('keeps content smaller than the room inside it', () => {
    expect(scrollRange(100, 300, 1, 16, 359)).toEqual([16 - 100, 359 - 300]);
  });
});

describe('keptToEdges', () => {
  it('lets a drag go as far as an edge and no further', () => {
    expect(keptToEdges(view(0, 116), view(500, 116), PHONE)).toEqual(view(16, 116));
    expect(keptToEdges(view(0, 116), view(-5000, 116), PHONE)).toEqual(view(359 - 1000, 116));
    expect(keptToEdges(view(0, 116), view(0, -5000), PHONE)).toEqual(view(0, 619 - 600));
    expect(keptToEdges(view(0, 116), view(-100, 100), PHONE)).toEqual(view(-100, 100));
  });

  it('never makes a view that stood beyond an edge jump, and lets the hand bring it back', () => {
    const beyond = view(200, 116);
    expect(keptToEdges(beyond, view(260, 116), PHONE)).toEqual(beyond);
    expect(keptToEdges(beyond, view(150, 116), PHONE)).toEqual(view(150, 116));
  });

  it('keeps the edges as the hand zooms', () => {
    const out = keptToEdges(view(16, 116), view(40, 116, 0.5), PHONE);
    expect(out.x).toBe(16);
    expect(out.y + 600 * 0.5).toBeLessThanOrEqual(619);
  });
});

describe('freeRoom', () => {
  const rect = (top: number, bottom: number, left = 0, right = 375) => ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const canvas = (top: number, height: number) => ({ clientHeight: height, getBoundingClientRect: () => rect(top, top + height) }) as unknown as HTMLElement;
  const bar = (top: number, bottom: number, left?: number, right?: number) => ({ getBoundingClientRect: () => rect(top, bottom, left, right) }) as unknown as Element;

  it('leaves the room between the bars along the top and the bottom, clear of each', () => {
    const room = freeRoom(canvas(0, 812), [bar(64, 108, 16, 224), bar(627, 671, 227, 359), bar(752, 796, 16, 359)], { left: 0, width: 375 });
    expect(room).toEqual({ x0: SIDE_GAP, x1: 375 - SIDE_GAP, y0: 108 + FLOAT_GAP, y1: 627 - FLOAT_GAP });
  });

  it('measures from the canvas, whose own top may stand under a bar, and keeps the least room asked for', () => {
    expect(freeRoom(canvas(116, 503), [bar(64, 108), bar(627, 796)], { left: 0, width: 375 })).toEqual({ x0: 16, x1: 359, y0: FLOAT_GAP, y1: 503 - FLOAT_GAP });
    expect(freeRoom(canvas(0, 900), [], { left: 432, width: 1008 }, { top: 76, bottom: 72, side: 32 })).toEqual({ x0: 464, x1: 1408, y0: 76, y1: 828 });
  });

  /* A phone's department canvas is cut FLOAT_GAP clear of the name above it and the dock below, so its content may use the
     whole cut: FLOAT_GAP from the bars once, not again from the canvas's own edges. */
  it('gives a canvas cut clear of its bars the whole cut', () => {
    expect(freeRoom(canvas(116, 503), [bar(64, 108), bar(627, 796)], { left: 0, width: 375 }, { edge: 0 })).toEqual({ x0: 16, x1: 359, y0: 0, y1: 503 });
    expect(freeRoom(canvas(116, 503), [], { left: 0, width: 375 }, { edge: 0, top: -40 })).toEqual({ x0: 16, x1: 359, y0: 0, y1: 503 });
  });
});

describe('mapView', () => {
  const room = { x0: 32, x1: 343, y0: 76, y1: 686 };
  const company = { x0: 100, y0: 200, x1: 1300, y1: 1000 };
  /* The hub's middle across: the company has more departments on one side of it than on the other. */
  const hub = 400;

  /* Design's decision 2 on #1596, for #1597: a map that does not fit opens with the hub itself in the middle across, not
     the middle of the whole layout. */
  it('opens a map too wide for a phone with its card names 11 px tall, centred across on the hub, and fits it with Show everything', () => {
    const opened = mapView(room, company, false, MAP_READABLE_K, hub);
    expect(opened.k).toBe(MAP_READABLE_K);
    expect(20 * opened.k).toBeCloseTo(11, 10);
    expect(opened.x + hub * opened.k).toBeCloseTo((room.x0 + room.x1) / 2, 10);
    expect(opened.y + company.y0 * opened.k).toBeCloseTo(room.y0 + (610 - 800 * opened.k) / 2, 10);
    const whole = mapView(room, company, true, MAP_READABLE_K, hub);
    expect(whole.k).toBeCloseTo(311 / 1200, 10);
    expect(whole.x + company.x0 * whole.k).toBeCloseTo(room.x0, 10);
  });

  /* Design's note on #1596, for #1597: on a phone the people chips' names open as readable as the cards' names must. */
  it('opens a phone\'s map with its people chip names 11 px tall and its card names larger, centred across on the hub', () => {
    const opened = mapView(room, company, false, PHONE_MAP_READABLE_K, hub);
    expect(Number(rulesFor('.chip b')[0]!.decls['font-size']!.replace('px', '')) * opened.k).toBe(11);
    expect(20 * opened.k).toBeGreaterThan(11);
    expect(opened.x + hub * opened.k).toBeCloseTo((room.x0 + room.x1) / 2, 10);
    expect(mapView(room, company, true, PHONE_MAP_READABLE_K, hub)).toEqual(mapView(room, company, true));
  });

  it('opens a map taller than the room at its top', () => {
    const tall = { ...company, y1: 1600 };
    const opened = mapView(room, tall, false);
    expect(opened.y + tall.y0 * opened.k).toBe(room.y0);
  });

  /* The head of Development's word on #1597, until Design says otherwise: a map that fits whole opens fitted, centred on the
     whole layout, wherever its hub stands. */
  it('opens a map that fits readable whole, as Show everything shows it', () => {
    const wide = { x0: 32, x1: 1408, y0: 76, y1: 828 };
    expect(mapView(wide, company, false, MAP_READABLE_K, hub)).toEqual(mapView(wide, company, true));
    expect(mapView(wide, company, false, MAP_READABLE_K, hub).k).toBeGreaterThan(MAP_READABLE_K);
  });

  /* Design on #1597: a map fits only at a size where its smallest name is 11 px tall or more. One that fits only smaller
     opens readable from the hub. */
  it('opens a map that fits only below the readable size from the hub, readable', () => {
    const mid = { x0: 0, y0: 0, x1: 500, y1: 400 }, at = 150;
    const wide = mapView(room, mid, false, MAP_READABLE_K, at);
    expect(wide).toEqual(mapView(room, mid, true));
    expect(wide.k).toBeCloseTo(311 / 500, 10);
    const phone = mapView(room, mid, false, PHONE_MAP_READABLE_K, at);
    expect(phone.k).toBe(PHONE_MAP_READABLE_K);
    expect(phone.x + at * phone.k).toBeCloseTo((room.x0 + room.x1) / 2, 10);
  });

  /* Design on #1597: a map that fits is never drawn larger than it is. */
  it('opens a small map and shows it whole at 100% at most', () => {
    const small = { x0: 0, y0: 0, x1: 200, y1: 150 };
    for (const whole of [false, true]) {
      const v = mapView(room, small, whole, PHONE_MAP_READABLE_K, 40);
      expect(v.k).toBe(1);
      expect(v.x + 100).toBeCloseTo((room.x0 + room.x1) / 2, 10);
    }
  });
});

describe('what scrolls out of the room on a phone', () => {
  it('goes out of sight on the map, while the world keeps its place', () => {
    const [room] = rulesFor('.map-room');
    expect(room!.decls).toMatchObject({ position: 'absolute', overflow: 'hidden', inset: 'var(--map-top, 0px) 0 var(--map-bottom, 0px)' });
    expect(rulesFor('.map-room > .world')[0]!.decls.top).toBe('calc(-1 * var(--map-top, 0px))');
  });

  /* A department's schema runs under the glass of its name and the dock instead (#1635): its canvas takes the whole window. */
  it('passes under the glass on a department\'s schema, whose canvas takes the whole window', () => {
    expect(rulesFor('.dcanvas').filter(r => r.media === '(max-width: 760px)' && Object.keys(r.decls).some(p => p.startsWith('inset')))).toEqual([]);
  });
});
