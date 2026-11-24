import { Container, MeshSimple, Sprite, Texture } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ART_CONTRACT_VERSION, type ArtIndex, type BuildingArtLayer } from '../src/world/art';
import { WorldArtFiles } from '../src/world/art-files';
import { DisplayRunPool, WorldArtLibrary, type GreyReader } from '../src/world/art-runtime';
import { placeCloth, placeLayerSprite, swayCloths, type CityArtContext, type ClothLayer } from '../src/world/city-renderer';
import { CLOTH_COLS, CLOTH_ROWS } from '../src/world/cloth';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* #1983: the runtime side of cloth that sways by its mask: the mask read once into vertex weights, the cloth mesh in the
   display pool, and a layer drawn as cloth only once its mask is in. */
const AT = 'buildings/house/mudbrick/v01/';
const PACK = { ...EGYPT_WORLD_PACK, art: { ...EGYPT_WORLD_PACK.art!, baseUrl: '/art/' } };
const W = 72;
const H = 96;

const INDEX: ArtIndex = {
  contract: ART_CONTRACT_VERSION,
  pack: 'egypt',
  files: {
    [`${AT}complete.png`]: {
      w: W,
      h: H,
      passport: {
        groundAnchor: { x: 36, y: 78 },
        corners: { top: { x: 36, y: 60 }, right: { x: 72, y: 78 }, bottom: { x: 36, y: 95 }, left: { x: 0, y: 78 } },
        layers: [{ file: 'awning.png' }],
      },
    },
    [`${AT}awning.png`]: { w: W, h: H },
    [`${AT}awning_w.png`]: { w: W, h: H },
  },
};

/* The art folder answers its index; the masks come through the injected reader. */
const index = new WorldArtFiles({ packId: 'egypt', baseUrl: '/art/', store: null, fetch: async () => new Response(JSON.stringify(INDEX)) });
/* The free edge (the lower half) moves, the rest is still. */
const halfMask: GreyReader = async () => {
  const data = new Uint8ClampedArray(W * H);
  data.fill(255, (H / 2) * W);
  return { data, w: W, h: H };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Cloth masks in the art runtime (#1983)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a cloth mask once into the mesh weights and tells the map, null until then', async () => {
    let reads = 0;
    const lib = await WorldArtLibrary.load(PACK, index, async url => {
      reads += 1;
      expect(url).toBe(`/art/${AT}awning_w.png`);
      return halfMask(url);
    });
    let changes = 0;
    lib.onChange(() => (changes += 1));
    expect(lib.clothWeights(`${AT}awning_w.png`)).toBeNull();
    expect(lib.clothWeights(`${AT}awning_w.png`)).toBeNull();
    await settle();
    const weights = lib.clothWeights(`${AT}awning_w.png`)!;
    expect(weights).toHaveLength(CLOTH_COLS * CLOTH_ROWS);
    expect(weights[0]).toBe(0);
    expect(weights[weights.length - 1]).toBe(1);
    expect(reads).toBe(1);
    expect(changes).toBe(1);
    expect(lib.clothWeights('buildings/house/mudbrick/v01/missing_w.png')).toBeNull();
  });

  it('reads a mask from its own picture file in the browser: the size is taken before the bitmap is closed', async () => {
    /* A closed ImageBitmap reads 0 by 0, as browsers do, and a 0 by 0 read of a canvas throws. */
    vi.stubGlobal('createImageBitmap', async () => ({
      width: W,
      height: H,
      close() {
        this.width = 0;
        this.height = 0;
      },
    }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return {
            drawImage: () => undefined,
            getImageData: (_x: number, _y: number, w: number, h: number) => {
              if (w <= 0 || h <= 0) throw new RangeError('IndexSizeError');
              const data = new Uint8ClampedArray(w * h * 4);
              for (let i = (H / 2) * W * 4; i < data.length; i++) data[i] = 255;
              return { data };
            },
          };
        }
      },
    );
    const files = new WorldArtFiles({
      packId: 'egypt',
      baseUrl: '/art/',
      store: null,
      fetch: async url => (url.endsWith('art-index.json') ? new Response(JSON.stringify(INDEX)) : new Response(new Blob([new Uint8Array(4)]))),
    });
    const lib = await WorldArtLibrary.load(PACK, files);
    expect(lib.clothWeights(`${AT}awning_w.png`)).toBeNull();
    for (let i = 0; i < 10 && !lib.clothWeights(`${AT}awning_w.png`); i++) await settle();
    const weights = lib.clothWeights(`${AT}awning_w.png`);
    expect(weights).toHaveLength(CLOTH_COLS * CLOTH_ROWS);
    expect(weights![0]).toBe(0);
    expect(weights![weights!.length - 1]).toBe(1);
  });

  it('keeps a cloth still when its mask cannot be read, and ignores a mask that comes after the map ended', async () => {
    const broken = await WorldArtLibrary.load(PACK, index, () => Promise.reject(new Error('404')));
    expect(broken.clothWeights(`${AT}awning_w.png`)).toBeNull();
    await settle();
    expect(broken.clothWeights(`${AT}awning_w.png`)).toBeNull();

    const late = await WorldArtLibrary.load(PACK, index, halfMask);
    let changes = 0;
    late.onChange(() => (changes += 1));
    late.clothWeights(`${AT}awning_w.png`);
    late.destroy();
    await settle();
    expect(changes).toBe(0);
  });

  it('hands out cloth meshes in the pool and takes them back for the next pass', () => {
    const pool = new DisplayRunPool(new Container());
    const first = pool.cloth(Texture.EMPTY);
    expect(first).toBeInstanceOf(MeshSimple);
    expect(first.geometry.positions).toHaveLength(CLOTH_COLS * CLOTH_ROWS * 2);
    pool.begin();
    const again = pool.cloth(Texture.WHITE);
    expect(again).toBe(first);
    expect(again.texture).toBe(Texture.WHITE);
    pool.destroy();
    expect(pool.container.children).toHaveLength(0);
  });

  it('draws a layer as cloth only with its mask in, still before; the wind moves its free edge alone', async () => {
    const lib = await WorldArtLibrary.load(PACK, index, halfMask);
    const tex = Texture.WHITE;
    const textured = Object.assign(Object.create(lib) as WorldArtLibrary, { texture: () => tex });
    const swaying: ClothLayer[] = [];
    const pool = new DisplayRunPool(new Container());
    const ctx: CityArtContext = { library: textured, pool, variants: new Map(), swaying };
    const layer: BuildingArtLayer = {
      path: `${AT}awning.png`,
      frame: { x: 0, y: 0, w: W, h: H },
      anchor: { x: 36, y: 78 },
      offset: { x: 0, y: 0 },
      sway: { mask: `${AT}awning_w.png`, amplitude: 3 },
    };
    const centre = { x: 500, y: 300 };
    expect(placeCloth(ctx, layer, centre, 0.5, 'h1')).toBe(false);
    await settle();
    expect(placeCloth(ctx, { ...layer, sway: undefined }, centre, 0.5, 'h1')).toBe(false);
    expect(placeCloth(ctx, layer, centre, 0.5, 'h1')).toBe(true);
    expect(swaying).toHaveLength(1);
    const cloth = swaying[0]!;
    expect(cloth.mesh.position).toMatchObject({ x: 500 - 36 * 0.5, y: 300 - 78 * 0.5 });
    const rest = Array.from(cloth.mesh.geometry.positions);
    let lifted = 0;
    for (let t = 0; t < 3; t += 0.2) {
      swayCloths(swaying, t);
      const now = cloth.mesh.geometry.positions;
      for (let v = 0; v < CLOTH_COLS * CLOTH_ROWS; v++) {
        if (cloth.weights[v] === 0) expect(now[v * 2 + 1]).toBe(rest[v * 2 + 1]);
        else lifted = Math.max(lifted, Math.abs(now[v * 2 + 1]! - rest[v * 2 + 1]!));
      }
    }
    expect(lifted).toBeGreaterThan(0.5);
    cloth.mesh.destroy();
    swayCloths(swaying, 1);

    /* A still layer: a sprite on the picture's registration, multiplied or tinted as it says. */
    placeLayerSprite(ctx, { ...layer, sway: undefined, blend: 'multiply', tint: '#336699' }, tex, centre, 0.5);
    const sprite = pool.container.children.find(c => c instanceof Sprite) as Sprite;
    expect(sprite.blendMode).toBe('multiply');
    expect(sprite.tint).toBe(0x336699);
    expect(sprite.position).toMatchObject({ x: 500, y: 300 });
  });
});
