import { describe, expect, it } from 'vitest';
import type { WindSpec } from '../src/world/manifest';
import { sampleWind } from '../src/world/wind';

const SWAY = { amplitude: 1, frequency: 0.4, flutter: 1 } as const;
const BREEZE: WindSpec = { directionDeg: 0, baseStrength: 0.35, gustStrength: 0.6, gustSpeed: 4, gustScale: 14 };

function series(wind: WindSpec, x: number, y: number, phase: number, seconds: number, step = 1 / 30): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += step) out.push(sampleWind(wind, SWAY, x, y, t, phase).lean);
  return out;
}

function mean(a: readonly number[]): number {
  return a.reduce((s, v) => s + v, 0) / a.length;
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

describe('wind field for plants', () => {
  it('gives the same sway for the same place, time and phase', () => {
    expect(sampleWind(BREEZE, SWAY, 31.4, 77.2, 12.5, 1.3)).toEqual(sampleWind(BREEZE, SWAY, 31.4, 77.2, 12.5, 1.3));
  });

  it('keeps every plant moving: no frozen plants and no wild swings', () => {
    const lean = series(BREEZE, 20, 40, 0.7, 60);
    expect(Math.max(...lean) - Math.min(...lean)).toBeGreaterThan(0.05);
    expect(Math.max(...lean.map(Math.abs))).toBeLessThan(0.6);
  });

  it('does not move plants in unison: neighbours at one instant differ and far plants are uncorrelated', () => {
    const now = [];
    for (let i = 0; i < 200; i++) now.push(sampleWind(BREEZE, SWAY, 10 + (i % 20) * 3.1, 10 + Math.floor(i / 20) * 3.7, 5, ((i * 2654435761) % 1000) / 159).lean);
    const m = mean(now);
    const sd = Math.sqrt(mean(now.map(v => (v - m) ** 2)));
    expect(sd).toBeGreaterThan(0.02);

    const a = series(BREEZE, 20, 20, 0.2, 90);
    const b = series(BREEZE, 70, 55, 2.9, 90);
    expect(Math.abs(correlation(a, b))).toBeLessThan(0.6);
  });

  it('moves smoothly from one frame to the next', () => {
    const lean = series(BREEZE, 33, 12, 1.1, 30, 1 / 60);
    let worst = 0;
    for (let i = 1; i < lean.length; i++) worst = Math.max(worst, Math.abs(lean[i]! - lean[i - 1]!));
    expect(worst).toBeLessThan(0.02);
  });

  it('adds light gusts on top of the steady breeze', () => {
    const calm = { ...BREEZE, gustStrength: 0 };
    const gusty = series(BREEZE, 40, 40, 0, 120);
    const steady = series(calm, 40, 40, 0, 120);
    expect(Math.max(...gusty)).toBeGreaterThan(Math.max(...steady) + 0.03);
  });

  it('leans plants the way the wind blows', () => {
    const toRight = mean(series({ ...BREEZE, directionDeg: 0 }, 25, 25, 0.4, 60));
    const toLeft = mean(series({ ...BREEZE, directionDeg: 180 }, 25, 25, 0.4, 60));
    expect(toRight).toBeGreaterThan(0.02);
    expect(toLeft).toBeLessThan(-0.02);
  });

  it('leaves a plant that does not respond to wind perfectly still', () => {
    const still = sampleWind(BREEZE, { amplitude: 0, frequency: 0.4, flutter: 0 }, 5, 5, 3, 1);
    expect(still.lean).toBe(0);
    expect(still.flutter).toBe(0);
  });
});
