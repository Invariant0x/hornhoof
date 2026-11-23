import type { ThemeArtFile } from '@hornhoof/protocol/themes';
import { WORLD_BUILDING_KINDS } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import { parseLook } from '../src/skins/validate';
import { checkLook, checkWorld } from '../src/themes/check';
import { ART_CONTRACT_VERSION, declaredArtFiles } from '../src/world/art';
import { dataOfWorldPack, worldPackOfData } from '../src/world-packs/data-pack';
import { registeredWorldPacks } from '../src/world-packs/registry';
import type { WorldPackManifest } from '../src/world/manifest';

/* The checks of a theme archive's look and world that the server runs from the screens' own code
   (docs/theme-archive.md, 3.1 and 4): a look and a world Hornhoof ships pass them as data, and each thing an archive
   may not do is refused with what to fix. */

type Raw = Record<string, unknown>;
/* A built-in skin's look as a ui/look.json holds it: every value but its id and its world, which the archive's world/ gives. */
const lookFile = (id: string): Raw => {
  const raw = JSON.parse(JSON.stringify(builtinSkin(id))) as Raw;
  delete raw.id;
  delete raw.world;
  return raw;
};
const refusal = (change: (raw: Raw) => void, families: readonly string[] = []) => {
  const raw = lookFile('egypt');
  change(raw);
  const parsed = parseLook(raw, families);
  return parsed.ok ? null : parsed.error;
};
const BASE = '/api/themes/files/t-1/world/art/';

/* The head of a PNG of a size, which is all the art check reads of a picture. */
const pngHead = (w: number, h: number) => {
  const head = new Uint8Array(33);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(head.buffer).setUint32(16, w);
  new DataView(head.buffer).setUint32(20, h);
  return head;
};

/* Every picture a shipped pack's art catalog requires, at the size and with the passport its slot asks for, as a finished
   pack brings them (the server's completeArt, in the form the check takes). Test pictures only (#105). */
function completeArtOf(pack: WorldPackManifest): ThemeArtFile[] {
  const footprintOf = (path: string) => {
    const [, kind, step] = path.split('/');
    return pack.art?.buildings[kind as keyof NonNullable<typeof pack.art>['buildings']]?.find(one => one.id === step)?.footprint ?? '1x1';
  };
  return declaredArtFiles(pack)
    .filter(slot => slot.required)
    .map(slot => {
      if (slot.passport === 'anchor') return { path: slot.path, head: pngHead(40, 100), passport: { anchor: { x: 20, y: 98 } } };
      if (slot.passport === 'sheet') return { path: slot.path, head: pngHead(8 * 136, (slot.role === 'person' ? 5 : 1) * 200), passport: { frameW: 136, frameH: 200, frames: 8, fps: 10, anchor: { x: 68, y: 190 } } };
      const footprints = pack.projection.buildingFootprintsMaster4x;
      const fp = footprints[(slot.role === 'module' ? slot.path.split('/')[1]! : footprintOf(slot.path)) as keyof typeof footprints];
      const [w, h] = [fp.diamondW + 8, Math.min(fp.maxCanvasH, fp.diamondH + 300)];
      const [x, y] = [w / 2, h - fp.diamondH / 2 - 4];
      const corners = { top: { x, y: y - fp.diamondH / 2 }, right: { x: x + fp.diamondW / 2, y }, bottom: { x, y: y + fp.diamondH / 2 }, left: { x: x - fp.diamondW / 2, y } };
      return { path: slot.path, head: pngHead(w, h), passport: { groundAnchor: { x, y }, corners, flagAnchor: { x: x + 10, y: 20 }, topAnchor: { x, y: 10 } } };
    });
}

describe('the look of a theme archive', () => {
  it('takes the whole look of every built-in skin, built anew', () => {
    for (const skin of BUILTIN_SKINS) {
      const raw = lookFile(skin.id);
      const parsed = parseLook(raw, []);
      expect(parsed.ok, skin.id).toBe(true);
      if (!parsed.ok) continue;
      const look: Raw = { ...skin };
      delete look.id;
      delete look.world;
      expect(parsed.look, skin.id).toEqual(look);
      expect(parsed.look.colors).not.toBe(raw.colors);
    }
  });

  it('takes a font the archive brings only when its ui/fonts.json names it', () => {
    const own = (raw: Raw) => ((raw.fonts as Raw).body = ['Papyrus Own', 'serif']);
    expect(refusal(own)).toEqual({ code: 'bad_font', key: 'fonts.body', value: 'Papyrus Own' });
    expect(refusal(own, ['Papyrus Own'])).toBeNull();
  });

  it('refuses what a look cannot hold, naming the field', () => {
    expect(refusal(raw => (raw.world = 'egypt'))).toEqual({ code: 'unknown_key', key: 'world' });
    expect(refusal(raw => (raw.grid = 8))).toEqual({ code: 'layout_locked', key: 'grid' });
    expect(refusal(raw => (raw.shape = 'round'))).toEqual({ code: 'bad_shape', key: 'shape' });
    expect(refusal(raw => delete raw.shape)).toEqual({ code: 'missing', key: 'shape' });
    expect(refusal(raw => (raw.surface = 'velvet'))).toEqual({ code: 'bad_surface', key: 'surface' });
    expect(refusal(raw => (raw.pulse = 0))).toEqual({ code: 'bad_pulse', key: 'pulse' });
    expect(refusal(raw => ((raw.worldColors as Raw).water = 'url(x)'))).toEqual({ code: 'unsafe', key: 'worldColors.water' });
    expect(refusal(raw => ((raw.terminal as Raw).ansi = ['#000000']))).toEqual({ code: 'bad_color', key: 'terminal.ansi' });
    expect(refusal(raw => ((raw.terminal as Raw).bell = '#000000'))).toEqual({ code: 'unknown_key', key: 'terminal.bell' });
    expect(refusal(raw => ((raw.colors as Raw).ink = (raw.colors as Raw).bg))).toMatchObject({ code: 'low_contrast' });
    /* An uploaded theme whose buttons have no visible edge is refused as a skin file is (Design, #1960). */
    expect(refusal(raw => Object.assign(raw.colors as Raw, { button: (raw.colors as Raw).bg, on_button: (raw.colors as Raw).ink }))).toMatchObject({ code: 'faint_line', key: 'button', value: 'bg' });
    expect(parseLook(JSON.parse('{"__proto__":{"x":1}}'), [])).toEqual({ ok: false, error: { code: 'forbidden_key', key: '__proto__' } });
  });

  it('says what to fix in plain words in English and Russian for each new refusal', () => {
    for (const code of ['bad_shape', 'bad_surface', 'bad_pulse'] as const) {
      for (const words of [en, ru]) expect(words.skins.errors[code]('shape', '')).toMatch(/shape/);
    }
  });

  it('gives the server a detail it can show, and the look itself when it passes', () => {
    expect(checkLook(lookFile('matrix'), [])).toMatchObject({ ok: true });
    expect(checkLook({ ...lookFile('matrix'), shape: 'round' }, [])).toEqual({ ok: false, detail: '["bad_shape","shape",""]' });
  });
});

describe('the world of a theme archive', () => {
  it('writes every shipped pack as data that gives the same pack back under the theme\'s id', () => {
    for (const pack of registeredWorldPacks()) {
      const data = dataOfWorldPack(pack);
      expect(JSON.parse(JSON.stringify(data))).toEqual(data);
      const built = worldPackOfData('t-1', data, BASE);
      expect(built.ok ? [] : built.errors, pack.id).toEqual([]);
      if (!built.ok) continue;
      expect(built.pack.id).toBe('t-1');
      expect(built.pack.terrainRecipe?.prepare).toBe(pack.terrainRecipe?.prepare);
      expect(built.pack.terrainRecipe?.tileKinds).toEqual(pack.terrainRecipe?.tileKinds);
      expect(built.pack.art?.baseUrl).toBe(pack.art ? BASE : undefined);
    }
  });

  it('renames and recolours a recipe\'s tile kinds, and refuses a kind the recipe does not have', () => {
    const pack = registeredWorldPacks().find(one => one.id === 'dungeon')!;
    const data = dataOfWorldPack(pack);
    const shipped = pack.terrainRecipe!;
    const [first] = shipped.tileKinds;
    const recipe = (tiles: Raw) => ({ ...data, recipe: { use: shipped.id, tiles } });
    const built = worldPackOfData('t-1', recipe({ [first!.id]: { label: { en: 'Moss', ru: 'Мох' }, color: '#335533' } }), BASE);
    expect(built.ok && built.pack.terrainRecipe?.tileKinds[0]).toEqual({ ...first, label: { en: 'Moss', ru: 'Мох' }, color: '#335533' });
    /* The dungeon has a river of lava; a meadow it has not. */
    expect(worldPackOfData('t-1', recipe({ meadow: { color: '#33AA33' } }), BASE)).toEqual({ ok: false, errors: [`recipe.tiles names "meadow", a tile kind recipe ${shipped.id} does not have`] });
    expect(worldPackOfData('t-1', recipe({ [first!.id]: { color: 'red' } }), BASE)).toEqual({ ok: false, errors: [`recipe.tiles.${first!.id}.color needs #RRGGBB`] });
    expect(worldPackOfData('t-1', recipe({ [first!.id]: { buildable: false } }), BASE)).toEqual({ ok: false, errors: [`recipe.tiles.${first!.id} has an unknown field "buildable"`] });
  });

  it('refuses a world that brings its own code, its own id or a recipe Hornhoof does not ship', () => {
    const data = dataOfWorldPack(registeredWorldPacks()[0]!);
    expect(worldPackOfData('t-1', { ...data, recipe: { use: 'volcano' } }, BASE)).toMatchObject({ ok: false, errors: [expect.stringContaining('recipe.use must be one of')] });
    expect(worldPackOfData('t-1', { ...data, id: 'egypt' }, BASE)).toEqual({ ok: false, errors: ['id is the theme\'s own: leave it out'] });
    expect(worldPackOfData('t-1', { ...data, terrainRecipe: {} }, BASE)).toEqual({ ok: false, errors: ['world.json has an unknown field "terrainRecipe"'] });
    expect(worldPackOfData('t-1', { ...data, resolveEmptyTileId: 'x' }, BASE)).toEqual({ ok: false, errors: ['world.json has an unknown field "resolveEmptyTileId"'] });
    expect(worldPackOfData('t-1', { ...data, mapSize: 0 }, BASE)).toMatchObject({ ok: false, errors: expect.arrayContaining(['mapSize must be a positive integer']) });
    expect(worldPackOfData('t-1', [], BASE)).toEqual({ ok: false, errors: ['world.json must be an object'] });
  });

  /* A world asks every browser of the company for its map: an archive's world stays within a city's work (#1960, F3). */
  it('refuses a world whose numbers ask a browser for more than a city', () => {
    const data = dataOfWorldPack(registeredWorldPacks().find(one => one.id === 'space')!) as Raw;
    const params = data.params as Raw;
    const camera = data.camera as Raw;
    const projection = data.projection as Raw;
    const cases: [string, Raw, string][] = [
      ['a map of 100 000 tiles a side', { mapSize: 100_000 }, 'mapSize is at most 512 tiles'],
      ['chunks of one tile', { params: { ...params, chunkSize: 1 } }, 'params.chunkSize is from 2 to 64 tiles'],
      ['more chunks a side than a browser holds', { mapSize: 512, params: { ...params, chunkSize: 2 } }, 'the map is at most 128 chunks a side: mapSize / params.chunkSize'],
      ['a zoom of a hundred times', { camera: { ...camera, maxZoom: 100 } }, 'camera.maxZoom is from 0.25 to 4'],
      ['tiles of 100 000 px', { projection: { ...projection, defaultTileW: 100_000, defaultTileH: 50_000 } }, 'projection.defaultTileW is beyond 10000'],
      ['a number of a billion anywhere', { projection: { ...projection, sun: { ...(projection.sun as Raw), kelvin: 1e9 } } }, 'projection.sun.kelvin is beyond 10000'],
      ['a tier of tiles 2000 px wide', { projection: { ...projection, lods: [{ ...(projection.lods as Raw[])[0], tileW: 2_000 }] } }, 'projection.lods.0.tileW is at most 1024 px'],
      ['painted ground of 2048 texels a tile', { terrainArt: { texelsPerTile: 2_048 } }, 'terrainArt.texelsPerTile is at most 1024'],
      ['tiers that are a word', { projection: { ...projection, lods: 'many' } }, 'projection.lods must be a list of tiers, each an object'],
      ['a tier that is a word', { projection: { ...projection, lods: ['x'] } }, 'projection.lods must be a list of tiers, each an object'],
    ];
    for (const [name, change, said] of cases) {
      expect(worldPackOfData('t-1', { ...data, ...change }, BASE), name).toMatchObject({ ok: false, errors: expect.arrayContaining([said]) });
    }
    expect(worldPackOfData('t-1', { ...data, projection: 'flat' }, BASE).ok).toBe(false);
    for (const pack of registeredWorldPacks().filter(one => one.terrainRecipe && !one.resolveEmptyTileId)) {
      expect(worldPackOfData('t-1', dataOfWorldPack(pack), BASE).ok, pack.id).toBe(true);
    }
  });

  /* A world with very many wrong numbers is refused as one with a few: the check says the first of them and never
     breaks on how many there are (#1960, F4). */
  it('refuses a world of 150 000 numbers beyond their bounds as it refuses one with a few, without breaking', () => {
    const data = dataOfWorldPack(registeredWorldPacks().find(one => one.id === 'space')!) as Raw;
    const many = Array.from({ length: 150_000 }, (_, n) => 10_001 + ((n * 7_919) % 89_999));
    const lods = Array.from({ length: 150_000 }, () => ({ tileW: 2_000 }));
    const cases: [string, Raw, string][] = [
      ['numbers', { params: { ...(data.params as Raw), many } }, 'params.many.0 is beyond 10000'],
      ['tile tiers', { projection: { ...(data.projection as Raw), lods } }, 'projection.lods has at most 8 tiers'],
    ];
    for (const [name, change, first] of cases) {
      const built = worldPackOfData('t-1', { ...data, ...change }, BASE);
      expect(built, name).toMatchObject({ ok: false, errors: expect.arrayContaining([first]) });
      expect(built.ok ? 0 : built.errors.length, name).toBeLessThanOrEqual(50);
    }
  });

  /* A world is whole only with its own pictures: every one its catalog requires, a building of every kind the city
     grows, and its residents. Anything less installs as the interface alone (#1960, #1972). */
  it('calls a world whole only with every required picture, a building of every kind and residents', () => {
    const pack = registeredWorldPacks().find(one => one.id === 'egypt')!;
    const world = dataOfWorldPack(pack) as Raw;
    const art = completeArtOf(pack);
    const check = (data: Raw, files: readonly ThemeArtFile[] = art) => checkWorld({ id: 't-1', world: data, baseUrl: BASE, art: files, files: files.map(file => file.path) });
    const catalog = world.art as Raw;
    const buildings = catalog.buildings as Raw;
    const [kind] = WORLD_BUILDING_KINDS;
    const otherKinds = Object.fromEntries(Object.entries(buildings).filter(([key]) => key !== kind));
    expect(check(world)).toMatchObject({ ok: true, complete: true, missing: 0 });
    expect(check(world, art.slice(1))).toMatchObject({ ok: true, complete: false, missing: 1 });
    expect(check({ ...world, art: { ...catalog, people: { ...(catalog.people as Raw), looks: [] } } })).toMatchObject({ ok: true, complete: false });
    expect(check({ ...world, art: { ...catalog, buildings: { ...buildings, [kind]: [] } } })).toMatchObject({ ok: true, complete: false, missing: 0 });
    expect(check({ ...world, art: { ...catalog, buildings: otherKinds } })).toMatchObject({ ok: true, complete: false, missing: 0 });
    expect(check(Object.fromEntries(Object.entries(world).filter(([key]) => key !== 'art')))).toMatchObject({ ok: true, complete: false, missing: 0 });
  });

  it('checks the art of a world by the art contract, and indexes what passed', () => {
    const pack = registeredWorldPacks().find(one => one.id === 'egypt')!;
    const world = dataOfWorldPack(pack);
    const png = (w: number, h: number) => {
      const head = new Uint8Array(33);
      head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(head.buffer).setUint32(16, w);
      new DataView(head.buffer).setUint32(20, h);
      return head;
    };
    const empty = checkWorld({ id: 't-1', world, baseUrl: BASE, art: [], files: [] });
    /* A world passes with any art the contract takes; it is whole only with every picture its catalog requires. */
    const required = declaredArtFiles(pack).filter(slot => slot.required).length;
    expect(empty).toEqual({ ok: true, world, artIndex: { contract: ART_CONTRACT_VERSION, pack: 't-1', files: {} }, complete: false, missing: required });
    const loose = checkWorld({ id: 't-1', world, baseUrl: BASE, art: [{ path: 'loose/one.png', head: png(4, 4) }], files: ['loose/one.png'] });
    expect(loose).toMatchObject({ ok: true, artIndex: { files: { 'loose/one.png': { w: 4, h: 4 } } } });
    const anchored = declaredArtFiles(pack).find(slot => slot.passport === 'anchor')!;
    const bare = checkWorld({ id: 't-1', world, baseUrl: BASE, art: [{ path: anchored.path, head: png(64, 64) }], files: [anchored.path] });
    expect(bare).toEqual({ ok: false, code: 'art_bad', detail: `${anchored.path}: needs a passport with an anchor inside the picture` });
    const held = checkWorld({ id: 't-1', world, baseUrl: BASE, art: [{ path: anchored.path, head: png(64, 64), passport: { anchor: [32, 60] } }], files: [anchored.path] });
    expect(held).toMatchObject({ ok: true, artIndex: { files: { [anchored.path]: { w: 64, h: 64, passport: { anchor: { x: 32, y: 60 } } } } }, complete: false, missing: required - 1 });
    const dungeon = registeredWorldPacks().find(one => one.id === 'dungeon')!;
    expect(checkWorld({ id: 't-1', world: dataOfWorldPack(dungeon), baseUrl: BASE, art: [], files: [] })).toMatchObject({ ok: true, complete: false, missing: 0 });
    expect(checkWorld({ id: 't-1', world: { ...world, recipe: { use: 'volcano' } }, baseUrl: BASE, art: [], files: [] })).toMatchObject({ ok: false, code: 'world_bad' });
  });
});
