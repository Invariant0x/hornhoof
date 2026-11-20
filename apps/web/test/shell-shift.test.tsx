import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { underShell, useFitMove, worldTransition } from '../src/ui/canvas';

/* How the map and a department's schema move as they fit, and as a bar of the shell comes or goes (#1635, variant A). */
describe('the move of a fit', () => {
  const at = { x: 10, y: 20, k: 1 };

  it("glides as Fit does at first, and in the shell's time once a bar of the shell came or went since the last fit", () => {
    const { result, rerender } = renderHook(({ top }) => useFitMove(top), { initialProps: { top: null as number | null } });
    expect(result.current({ ...at, smooth: false }, { x: 30, y: 40, k: 1 })).toEqual({ x: 30, y: 40, k: 1, smooth: true });
    rerender({ top: 120 });
    expect(result.current({ x: 30, y: 40, k: 1, smooth: true }, { x: 30, y: 96, k: 1 })).toEqual({ x: 30, y: 96, k: 1, smooth: 'shift' });
    expect(result.current({ x: 30, y: 96, k: 1, smooth: 'shift' }, { x: 31, y: 97, k: 1 })).toEqual({ x: 31, y: 97, k: 1, smooth: true });
    rerender({ top: null });
    expect(result.current({ x: 31, y: 97, k: 1, smooth: true }, { x: 31, y: 41, k: 1 })?.smooth).toBe('shift');
  });

  it('leaves a view that already stands or glides where the fit would put it, so a second look keeps its move going', () => {
    const { result } = renderHook(() => useFitMove(null));
    expect(result.current({ ...at, smooth: 'shift' }, { x: 10.2, y: 19.8, k: 1 })).toBeNull();
    expect(result.current({ ...at, smooth: true }, { x: 10, y: 20, k: 1.5 })).not.toBeNull();
  });
});

describe("the world's transition", () => {
  it("moves at once while still or not asked to glide, in the shell's time, flying, or with Fit's glide", () => {
    const fly = 'transform 1.2s cubic-bezier(.55,0,.25,1)';
    expect(worldTransition(true, true, fly)).toBe('none');
    expect(worldTransition(false, false, fly)).toBe('none');
    expect(worldTransition('shift', false, fly)).toBe('transform var(--shell-shift) ease-out');
    expect(worldTransition('fly', false, fly)).toBe(fly);
    expect(worldTransition(true, false, fly)).toBe('transform .8s cubic-bezier(.3,.7,.2,1)');
    expect(worldTransition(true, false)).toBe('transform .8s cubic-bezier(.3,.7,.2,1)');
  });
});

describe('the room under the bars of the shell', () => {
  it('starts at least as far down as asked, and under the last bar while one stands lower', () => {
    expect(underShell(64, null)).toBe(64);
    expect(underShell(64, 40)).toBe(64);
    expect(underShell(64, 128)).toBe(128);
  });
});
