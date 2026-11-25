/* Cloth in the wind (#1983): a building layer such as an awning sways by its grey mask alone, `<layer>_w.png` beside it,
   the plants' format: 0 stays still (where the cloth is fastened, the posts and the frame), 255 moves the most (the free
   edge). The layer is drawn as a mesh of CLOTH_COLS x CLOTH_ROWS vertices over its whole canvas; each vertex lifts and
   drops by the amplitude times its weight times the wind. A layer with no mask never moves. */

export const CLOTH_COLS = 12;
export const CLOTH_ROWS = 9;

/* The weight of each vertex in [0, 1], row by row from the top: the stillest mask pixel in the cells around it. So a
   cell that holds one still pixel keeps all four corners in place, and every pixel of a post or the frame stays put. */
export function clothVertexWeights(mask: Uint8ClampedArray, w: number, h: number, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows);
  const at = (i: number, n: number, size: number) => (Math.max(0, Math.min(n - 1, i)) / (n - 1)) * (size - 1);
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor(at(r - 1, rows, h));
    const y1 = Math.ceil(at(r + 1, rows, h));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor(at(c - 1, cols, w));
      const x1 = Math.ceil(at(c + 1, cols, w));
      out[r * cols + c] = stillestIn(mask, w, x0, x1, y0, y1) / 255;
    }
  }
  return out;
}

function stillestIn(mask: Uint8ClampedArray, w: number, x0: number, x1: number, y0: number, y1: number): number {
  let least = 255;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      least = Math.min(least, mask[y * w + x] ?? 0);
      if (least === 0) return 0;
    }
  }
  return least;
}

/* The red channel of RGBA pixels, one byte per pixel: a grey mask as the canvas reads it back. */
export function greyOf(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]!;
  return out;
}

/* The mesh's vertices in picture pixels for a wind in [-1, 1]: each lifts or drops by amplitudePx times its weight. */
export function swayClothVertices(out: Float32Array, w: number, h: number, weights: Float32Array, amplitudePx: number, wind: number): void {
  for (let r = 0; r < CLOTH_ROWS; r++) {
    for (let c = 0; c < CLOTH_COLS; c++) {
      const i = r * CLOTH_COLS + c;
      out[i * 2] = (c / (CLOTH_COLS - 1)) * w;
      out[i * 2 + 1] = (r / (CLOTH_ROWS - 1)) * h - amplitudePx * (weights[i] ?? 0) * wind;
    }
  }
}

/* Texture coordinates of the mesh over the whole layer, row by row from the top. */
export function clothUvs(): Float32Array {
  const out = new Float32Array(CLOTH_COLS * CLOTH_ROWS * 2);
  for (let r = 0; r < CLOTH_ROWS; r++) {
    for (let c = 0; c < CLOTH_COLS; c++) {
      const i = (r * CLOTH_COLS + c) * 2;
      out[i] = c / (CLOTH_COLS - 1);
      out[i + 1] = r / (CLOTH_ROWS - 1);
    }
  }
  return out;
}

/* Two triangles per cell of the mesh. */
export function clothIndices(): Uint32Array {
  const out = new Uint32Array((CLOTH_COLS - 1) * (CLOTH_ROWS - 1) * 6);
  let k = 0;
  for (let r = 0; r < CLOTH_ROWS - 1; r++) {
    for (let c = 0; c < CLOTH_COLS - 1; c++) {
      const a = r * CLOTH_COLS + c;
      out.set([a, a + 1, a + CLOTH_COLS, a + 1, a + CLOTH_COLS + 1, a + CLOTH_COLS], k);
      k += 6;
    }
  }
  return out;
}

/* The wind on a cloth at `timeSec`, in [-1, 1]: a slow swell and a quicker flutter, out of step per building. */
export function clothWind(timeSec: number, phase: number): number {
  return 0.65 * Math.sin(timeSec * 2.4 + phase) + 0.35 * Math.sin(timeSec * 6.3 + phase * 2.1);
}
