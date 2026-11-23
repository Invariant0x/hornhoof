import { describe, expect, it } from 'vitest';
import { contrastOn, faceOf, type Pixels } from '../src/skins/kit-contrast';

/* How readable an ink stays on a painted part of a kit (Design, 23.11, #1970): measured at the worst spot under the words,
   not on the average tone. A 2x picture is read at 1x (each 2 x 2 block as one pixel, as the screen shows it), only where
   it is opaque, and only where words sit: inside a plate's slice, between a strip's rims. */

const ink = '#0F3A64';

/* A picture of width x height whose every pixel is paint(x, y). */
function picture(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return { width, height, data };
}

describe('the contrast of an ink on a painted part', () => {
  it('gives the WCAG ratio of the ink against the darkest and the lightest spot of a plain face', () => {
    const plain = picture(8, 8, () => [255, 255, 255, 255]);
    const measured = contrastOn(plain, faceOf(plain, {}), '#000000');
    expect(measured.worst).toBeCloseTo(21, 5);
    expect(measured.darkest).toBe('#FFFFFF');
  });

  it('takes the worst spot, not the average: one dark 2 x 2 block decides', () => {
    const light = picture(40, 40, (x, y) => (x >= 20 && x < 22 && y >= 20 && y < 22 ? [150, 130, 100, 255] : [240, 225, 190, 255]));
    const measured = contrastOn(light, faceOf(light, {}), ink);
    const everywhere = contrastOn(picture(40, 40, () => [240, 225, 190, 255]), { x: 0, y: 0, width: 40, height: 40 }, ink);
    expect(measured.worst).toBeLessThan(everywhere.worst - 3);
    expect(measured.darkest).toBe('#968264');
  });

  it('reads a 2x picture at 1x, so a single bright pixel is averaged with its block as the screen shows it', () => {
    const speck = picture(4, 4, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
    expect(contrastOn(speck, { x: 0, y: 0, width: 4, height: 4 }, '#000000').lightest).toBe('#4F4F4F');
  });

  it('leaves out clear and see-through pixels: the theme colour shows there, not the picture', () => {
    const edged = picture(8, 8, (x) => (x < 2 ? [0, 0, 0, 0] : x < 4 ? [0, 0, 0, 200] : [250, 250, 250, 255]));
    expect(contrastOn(edged, { x: 0, y: 0, width: 8, height: 8 }, '#000000').darkest).toBe('#FAFAFA');
  });

  it('measures a plate inside its slice, so its rim never counts as the face under the words', () => {
    const plate = picture(40, 20, (x, y) => (x < 6 || y < 6 || x >= 34 || y >= 14 ? [10, 10, 10, 255] : [240, 240, 240, 255]));
    expect(faceOf(plate, { slice: '6 fill' })).toEqual({ x: 6, y: 6, width: 28, height: 8 });
    expect(faceOf(plate, { slice: '4 6 4 6 fill' })).toEqual({ x: 6, y: 4, width: 28, height: 12 });
    expect(contrastOn(plate, faceOf(plate, { slice: '6 fill' }), '#000000').darkest).toBe('#F0F0F0');
  });

  it('measures a strip between its rims, where a row puts its words', () => {
    const strip = picture(100, 50, (_x, y) => (y < 11 || y >= 39 ? [90, 60, 20, 255] : [250, 230, 190, 255]));
    expect(faceOf(strip, {}, 'strip')).toEqual({ x: 0, y: 11, width: 100, height: 28 });
    expect(contrastOn(strip, faceOf(strip, {}, 'strip'), ink).darkest).toBe('#FAE6BE');
  });
});
