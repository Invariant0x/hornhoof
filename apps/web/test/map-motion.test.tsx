import { act, render } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { enterLight, leaveLight } from '../src/guard';
import { chooseSkin, initSkins } from '../src/skins/store';
import {
  dashSegments,
  FrameBreathe,
  framePolygonPoints,
  gapsAlongPath,
  MapPulse,
  MapWayOverlay,
  pauseMapAnimations,
  pulseKeyframes,
  pulseTiming,
} from '../src/ui/map-motion';
import type { Point } from '../src/ui/wires';

describe('map-motion geometry', () => {
  it('locates and merges bridge gaps in either travel direction along orthogonal polylines', () => {
    const path: Point[] = [[110, 574], [96, 574], [96, 200], [70, 200]];
    const gaps = [
      { personId: 'strip', pts: [[96, 406], [96, 394]] as Point[] },
      { personId: 'strip', pts: [[96, 398], [96, 386]] as Point[] },
    ];
    expect(gapsAlongPath(path, gaps)).toEqual([{ start: 182, end: 202 }]);
    expect(gapsAlongPath([...path].reverse(), gaps)).toEqual([{ start: 212, end: 232 }]);
    expect(gapsAlongPath([[0, 0]], gaps)).toEqual([]);
  });

  it('builds composited translate keyframes and hides dots across bridge gaps', () => {
    expect(pulseKeyframes([])).toEqual([]);
    expect(pulseKeyframes([[10, 20]])).toEqual([
      { transform: 'translate(10px, 20px)', offset: 0 },
      { transform: 'translate(10px, 20px)', offset: 1 },
    ]);

    const simple = pulseKeyframes([[0, 0], [0, 0], [30, 0], [30, 40]]);
    expect(simple).toEqual([
      { transform: 'translate(0px, 0px)', offset: 0 },
      { transform: 'translate(30px, 0px)', offset: 30 / 70 },
      { transform: 'translate(30px, 40px)', offset: 1 },
    ]);

    const gapped = pulseKeyframes(
      [[0, 0], [100, 0]],
      [{ personId: 'p1', pts: [[44, 0], [56, 0]] }],
    );
    expect(gapped[0]).toMatchObject({ transform: 'translate(0px, 0px)', opacity: 1, offset: 0 });
    expect(gapped.some(f => f.opacity === 0 && f.offset === 0.44)).toBe(true);
    expect(gapped.some(f => f.opacity === 0 && f.offset === 0.56)).toBe(true);
    expect(gapped.at(-1)).toMatchObject({ transform: 'translate(100px, 0px)', opacity: 1, offset: 1 });
  });

  it('splits straight dash strips around bridge gaps while keeping cumulative dash offsets', () => {
    expect(dashSegments([[10, 10]])).toEqual([]);
    const segs = dashSegments(
      [[0, 0], [100, 0], [100, 50]],
      [{ personId: 'p1', pts: [[44, 0], [56, 0]] }],
    );
    expect(segs).toEqual([
      { x: 0, y: 0, len: 44, deg: 0, offset: 0 },
      { x: 56, y: 0, len: 44, deg: 0, offset: 56 },
      { x: 100, y: 0, len: 50, deg: 90, offset: 100 },
    ]);
  });

  it('matches square, bevel and pixel-stepped .edge borders with optional top-left corner clearance', () => {
    expect(framePolygonPoints(100, 50, 12, 0, 'bevel', false)).toBe('0.5,0.5 99.5,0.5 99.5,49.5 0.5,49.5');
    expect(framePolygonPoints(100, 50, 12, 1, 'bevel', true)).toContain('22,0.5');
    expect(framePolygonPoints(100, 50, 12, 1, 'bevel', true)).toMatch(/0\.5,22$/);
    const steps = framePolygonPoints(100, 50, 12, 1, 'steps', false).split(' ');
    expect(steps).toHaveLength(12);
    expect(pulseTiming(4, true, false, 0)).toMatchObject({ duration: 2000, iterations: Infinity, direction: 'alternate', fill: 'none' });
    expect(pulseTiming(3, false, true, 0.5)).toMatchObject({ duration: 3000, iterations: 1, direction: 'normal', fill: 'forwards', delay: -1500 });
  });
});

describe('map-motion components', () => {
  it('switches FrameBreathe between bevel, square, stepped and light-guard states', () => {
    initSkins();
    onTestFinished(() => {
      chooseSkin('cyberpunk');
      leaveLight();
    });
    const { container, rerender } = render(<FrameBreathe w={250} h={148} cut={12} corner />);
    expect(container.querySelector('svg.frame-breathe > polyline')).toBeInTheDocument();

    act(() => { chooseSkin('matrix'); });
    expect(container.querySelector('polyline')!.getAttribute('points')).toBe('22,0.5 249.5,0.5 249.5,147.5 0.5,147.5 0.5,22');

    act(() => { chooseSkin('pixel'); });
    rerender(<FrameBreathe w={180} h={52} cut={8} />);
    expect(container.querySelector('polygon')!.getAttribute('points')!.split(' ')).toHaveLength(12);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => { enterLight('frames', 'map'); });
    warn.mockRestore();
    expect(container.querySelector('.frame-breathe')).toBeNull();
  });

  it('updates MapPulse playbackRate without recreating its Web Animation and pauses on inert maps', () => {
    let created = 0;
    let cancelled = 0;
    let rate = 1;
    let state: AnimationPlayState = 'running';
    const proto = Element.prototype as Element & { animate?: typeof Element.prototype.animate; getAnimations?: typeof Element.prototype.getAnimations };
    const prevAnimate = proto.animate;
    const prevGetAnims = proto.getAnimations;
    const fakeAnim = {
      get playState() { return state; },
      get playbackRate() { return rate; },
      set playbackRate(v: number) { rate = v; },
      updatePlaybackRate(v: number) { rate = v; },
      pause() { state = 'paused'; },
      play() { state = 'running'; },
      cancel() { cancelled++; },
    } as unknown as Animation;
    proto.animate = function () {
      created++;
      state = 'running';
      return fakeAnim;
    };
    proto.getAnimations = () => [fakeAnim];
    onTestFinished(() => {
      proto.animate = prevAnimate;
      proto.getAnimations = prevGetAnims;
      leaveLight();
    });

    const pts: Point[] = [[0, 0], [200, 0]];
    const { container, rerender, unmount } = render(
      <div inert>
        <MapPulse pts={pts} speed={100} phase={0.5} />
      </div>,
    );
    expect(created).toBe(1);
    expect(state).toBe('paused');

    const resume = pauseMapAnimations(container.firstElementChild as HTMLElement);
    resume();
    expect(state).toBe('running');

    rerender(
      <div>
        <MapPulse pts={pts} speed={25} phase={0.5} />
      </div>,
    );
    expect(created).toBe(1);
    expect(rate).toBe(0.25);

    unmount();
    expect(cancelled).toBe(1);
  });

  it('renders composited dash strips only when not reduced and not in light mode', () => {
    onTestFinished(() => leaveLight());
    const pts: Point[] = [[0, 0], [120, 0]];
    const { container, rerender } = render(<MapWayOverlay pts={pts} speed={100} tone="c" still={false} k={1} />);
    expect(container.querySelectorAll('.way-seg')).toHaveLength(1);
    expect(container.querySelectorAll('.pt-box')).toHaveLength(2);

    rerender(<MapWayOverlay pts={pts} speed={100} tone="c" still k={1} />);
    expect(container.querySelectorAll('.way-seg')).toHaveLength(0);
    expect(container.querySelectorAll('.pt-box')).toHaveLength(2);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => { enterLight('frames', 'map'); });
    warn.mockRestore();
    expect(container.querySelectorAll('.pt-box')).toHaveLength(0);
  });
});
