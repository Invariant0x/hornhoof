/* Wind for plants: a steady breeze, light gust fronts that travel across the map and a personal rhythm for every plant,
   so a grove ripples instead of nodding in unison. Pure and continuous in time and place: the renderer, the tests and a
   future artist pipeline all read the same numbers. Knows no species and no world. */

import type { PlantKindSpec, WindSpec } from './manifest';
import { fbm2D } from './prng';

const GUST_SEED = 0x6a35c1;
const BREATH_SEED = 0x2f9be7;
/* Converts the 0..~1.3 wind strength of a plant with amplitude 1 into shear (horizontal shift per unit of height). */
const LEAN_SCALE = 0.18;
const TAU = Math.PI * 2;

export type WindSample = Readonly<{
  /* Shear of the whole plant around its root: the top moves by lean * height, positive to the right. */
  lean: number;
  /* Fast small turn of the crown around its hub, in radians. */
  flutter: number;
  /* How strongly a gust front is passing, in [0, 1]. */
  gust: number;
}>;

const CALM: WindSample = { lean: 0, flutter: 0, gust: 0 };

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* Wind at a plant. x and y are tile coordinates, timeSec the clock, phase the plant's own 0..2pi offset. */
export function sampleWind(
  wind: WindSpec,
  sway: PlantKindSpec['sway'],
  x: number,
  y: number,
  timeSec: number,
  phase: number,
): WindSample {
  if (sway.amplitude <= 0) return CALM;

  const rad = (wind.directionDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const along = x * dx + y * dy;
  const across = -x * dy + y * dx;

  /* A gust is a front of stronger air that moves downwind; its noise is carried along at gustSpeed. */
  const front = fbm2D((along - wind.gustSpeed * timeSec) / wind.gustScale, across / (wind.gustScale * 1.7), GUST_SEED, 2);
  const gust = smoothstep(0.5, 0.74, front);
  /* The breeze itself breathes slowly from place to place. */
  const breath = fbm2D(along / 38 - timeSec * 0.04, across / 38, BREATH_SEED, 2);
  const push = wind.baseStrength * (0.75 + 0.5 * breath) + wind.gustStrength * gust;

  /* Each plant has its own pace (a few percent either way) and its own start, and neighbours are offset by place. */
  const pace = 0.88 + 0.24 * (phase / TAU);
  const swing = Math.sin(TAU * sway.frequency * pace * timeSec + phase + 0.45 * along);
  const second = Math.sin(TAU * sway.frequency * pace * 1.7 * timeSec + phase * 1.9 + 0.8 * across);
  const swingSize = 0.3 + 0.4 * gust;

  const lean = sway.amplitude * LEAN_SCALE * (push * dx + swingSize * swing + 0.12 * second);
  const flutter =
    sway.flutter * 0.09 * (0.3 + gust) * Math.sin(TAU * sway.frequency * pace * 3.3 * timeSec + phase * 2.3 + across * 0.9);
  return { lean, flutter, gust };
}
