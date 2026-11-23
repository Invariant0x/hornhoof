import { contrast, readColor } from './contrast';

/* How readable an ink stays on a painted part of a kit (Design, 23.11, #1970): at the worst spot under the words, not on
   the average tone. A kit's pictures are 2x, so they are read at 1x, each 2 x 2 block as one pixel as the screen shows it,
   and only where every pixel of the block is opaque: where the picture is see-through, the theme's own colour shows. */

/* A picture's pixels, four bytes each (red, green, blue, alpha), row by row: what a canvas gives. */
export type Pixels = Readonly<{ width: number; height: number; data: Uint8ClampedArray }>;
export type Area = Readonly<{ x: number; y: number; width: number; height: number }>;
export type Measured = Readonly<{ worst: number; darkest: string; lightest: string; onDarkest: number; onLightest: number }>;

/* A strip's rims: the share of its height at top and at bottom where no words sit. */
const STRIP_RIM = 0.22;
const OPAQUE = 250;

const hex = (rgb: readonly number[]) => `#${rgb.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/* Where words sit on a part: inside a plate's slice (picture pixels, one value or top right bottom left), between a strip's
   rims, or anywhere on a fill. */
export function faceOf(picture: Pick<Pixels, 'width' | 'height'>, slot: { slice?: string }, kind: 'plate' | 'strip' = 'plate'): Area {
  if (kind === 'strip') {
    const rim = Math.floor(picture.height * STRIP_RIM);
    return { x: 0, y: rim, width: picture.width, height: picture.height - 2 * rim };
  }
  const values = (slot.slice?.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!values.length) return { x: 0, y: 0, width: picture.width, height: picture.height };
  const [top, right = top, bottom = top, left = right] = values as [number, number?, number?, number?];
  return { x: left, y: top, width: picture.width - left - right, height: picture.height - top - bottom };
}

/* The 1x pixels of an area: each 2 x 2 block averaged, skipped when any of its pixels is not opaque. */
function blocks({ width, data }: Pixels, area: Area): number[][] {
  const out: number[][] = [];
  for (let y = area.y; y + 1 < area.y + area.height; y += 2) {
    for (let x = area.x; x + 1 < area.x + area.width; x += 2) {
      const at = [(y * width + x) * 4, (y * width + x + 1) * 4, ((y + 1) * width + x) * 4, ((y + 1) * width + x + 1) * 4];
      if (at.some(i => data[i + 3]! < OPAQUE)) continue;
      out.push([0, 1, 2].map(c => at.reduce((sum, i) => sum + data[i + c]!, 0) / 4));
    }
  }
  return out;
}

/* The ink against the darkest and the lightest 1x pixel of the area; worst is the lower of the two ratios. */
export function contrastOn(picture: Pixels, area: Area, ink: string): Measured {
  const color = readColor(ink);
  if (!color) throw new Error(`not a colour: ${ink}`);
  const rgb = (p: number[]) => ({ r: p[0]!, g: p[1]!, b: p[2]!, a: 1 });
  let darkest: number[] | null = null;
  let lightest: number[] | null = null;
  let low = Infinity;
  let high = -Infinity;
  for (const pixel of blocks(picture, area)) {
    const against = contrast(rgb(pixel), { r: 0, g: 0, b: 0, a: 1 });
    if (against < low) [low, darkest] = [against, pixel];
    if (against > high) [high, lightest] = [against, pixel];
  }
  if (!darkest || !lightest) throw new Error('no opaque pixel under the words');
  const onDarkest = contrast(color, rgb(darkest));
  const onLightest = contrast(color, rgb(lightest));
  return { worst: Math.min(onDarkest, onLightest), darkest: hex(darkest), lightest: hex(lightest), onDarkest, onLightest };
}
