import { describe, expect, it } from 'vitest';
import { CLOTH_COLS, CLOTH_ROWS, clothIndices, clothUvs, clothVertexWeights, clothWind, greyOf, swayClothVertices } from '../src/world/cloth';

/* #1983: wooden posts and frames never move; only cloth sways, a little. A layer sways by its grey mask alone
   (0 still, 255 the free edge), and a mesh cell that holds one still pixel keeps all its corners where they are. */
const W = 120;
const H = 80;

/* Posts down both sides, the frame along the top and the ground strip at the bottom are still; the cloth between them
   moves more toward its free (lower) edge. */
function awningMask(): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const post = x < 14 || x >= W - 14;
      const frame = y < 10 || y >= H - 8;
      mask[y * W + x] = post || frame ? 0 : Math.round((255 * (y - 10)) / (H - 18));
    }
  }
  return mask;
}

function restVertices(): Float32Array {
  const out = new Float32Array(CLOTH_COLS * CLOTH_ROWS * 2);
  swayClothVertices(out, W, H, new Float32Array(CLOTH_COLS * CLOTH_ROWS), 0, 0);
  return out;
}

describe('Cloth sways by its mask alone (#1983)', () => {
  it('keeps every mesh corner of a cell with a still pixel in place at every wind phase', () => {
    const mask = awningMask();
    const weights = clothVertexWeights(mask, W, H, CLOTH_COLS, CLOTH_ROWS);
    const rest = restVertices();
    const out = new Float32Array(rest.length);
    let moved = 0;
    for (let wind = -1; wind <= 1; wind += 0.25) {
      swayClothVertices(out, W, H, weights, 3, wind);
      for (let r = 0; r < CLOTH_ROWS - 1; r++) {
        for (let c = 0; c < CLOTH_COLS - 1; c++) {
          const x0 = Math.floor((c / (CLOTH_COLS - 1)) * (W - 1));
          const x1 = Math.ceil(((c + 1) / (CLOTH_COLS - 1)) * (W - 1));
          const y0 = Math.floor((r / (CLOTH_ROWS - 1)) * (H - 1));
          const y1 = Math.ceil(((r + 1) / (CLOTH_ROWS - 1)) * (H - 1));
          let still = false;
          for (let y = y0; y <= y1 && !still; y++) for (let x = x0; x <= x1 && !still; x++) still = mask[y * W + x] === 0;
          const corners = [r * CLOTH_COLS + c, r * CLOTH_COLS + c + 1, (r + 1) * CLOTH_COLS + c, (r + 1) * CLOTH_COLS + c + 1];
          for (const v of corners) {
            const shift = Math.hypot(out[v * 2]! - rest[v * 2]!, out[v * 2 + 1]! - rest[v * 2 + 1]!);
            if (still) expect(shift, `cell ${c},${r} holds a still pixel, corner ${v} at wind ${wind}`).toBe(0);
            else moved = Math.max(moved, shift);
          }
        }
      }
    }
    /* The free edge does move, by no more than the amplitude. */
    expect(moved).toBeGreaterThan(0.5);
    expect(moved).toBeLessThanOrEqual(3 + 1e-9);
  });

  it('moves nothing where the whole mask is still', () => {
    const weights = clothVertexWeights(new Uint8ClampedArray(W * H), W, H, CLOTH_COLS, CLOTH_ROWS);
    const out = new Float32Array(CLOTH_COLS * CLOTH_ROWS * 2);
    swayClothVertices(out, W, H, weights, 3, 1);
    expect(Array.from(out)).toEqual(Array.from(restVertices()));
  });

  it('spreads the mesh over the whole layer: corners at the texture corners, two triangles per cell', () => {
    const uvs = clothUvs();
    expect([uvs[0], uvs[1]]).toEqual([0, 0]);
    expect([uvs[uvs.length - 2], uvs[uvs.length - 1]]).toEqual([1, 1]);
    const indices = clothIndices();
    expect(indices).toHaveLength((CLOTH_COLS - 1) * (CLOTH_ROWS - 1) * 6);
    expect(Math.max(...indices)).toBe(CLOTH_COLS * CLOTH_ROWS - 1);
  });

  it('reads a grey mask from its red channel and keeps the wind within one either way', () => {
    expect(Array.from(greyOf(new Uint8ClampedArray([7, 1, 2, 255, 200, 0, 0, 255])))).toEqual([7, 200]);
    for (let t = 0; t < 10; t += 0.37) expect(Math.abs(clothWind(t, 1.3))).toBeLessThanOrEqual(1);
  });
});
