/* A world pack written as data: the world/world.json of a theme archive (docs/theme-archive.md, 4.1). It is the pack
   manifest of the engine's contract (world/manifest.ts) in JSON, every field but its two functions; its map recipe is
   one Hornhoof ships, named by id, whose tile kinds it may rename and recolour. The server checks an uploaded world
   with this, and the screens draw an installed one with it, so both read it alike. */

import { validateWorldPack, type TerrainKindSpec, type TerrainRecipeSpec, type WorldPackManifest } from '../world/manifest';
import { shippedRecipe, shippedRecipeIds } from './recipes';

/* The fields of the contract a world written as data may give; id and the art's address are Hornhoof's. */
const FIELDS = [
  'name', 'engine', 'mapSize', 'projection', 'camera', 'defaultTileId', 'tiles', 'sprites', 'stageCounts', 'palette', 'params',
  'showGridByDefault', 'outerWallMode', 'buildingLayout', 'altarAnchor', 'roleLooks', 'classFallbackLooks', 'constructionStages',
  'constructionPalette', 'materials', 'liquidLayer', 'plants', 'wind', 'lighting', 'paths', 'terrainArt', 'art', 'recipe',
];
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const LABEL = 60;

type Raw = Record<string, unknown>;
type Built = { ok: true; pack: WorldPackManifest } | { ok: false; errors: string[] };
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLabel = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= LABEL;

function tileOverride(kind: TerrainKindSpec, raw: unknown, errors: string[]): TerrainKindSpec {
  if (!isObject(raw)) {
    errors.push(`recipe.tiles.${kind.id} must be an object with a label and a colour`);
    return kind;
  }
  const extra = Object.keys(raw).find(key => key !== 'label' && key !== 'color');
  if (extra) errors.push(`recipe.tiles.${kind.id} has an unknown field "${extra}"`);
  if (!labelHolds(raw.label)) errors.push(`recipe.tiles.${kind.id}.label needs en and ru, each 1 to ${LABEL} characters`);
  if (!colorHolds(raw.color)) errors.push(`recipe.tiles.${kind.id}.color needs #RRGGBB`);
  return {
    ...kind,
    ...(isObject(raw.label) ? { label: { en: String(raw.label.en), ru: String(raw.label.ru) } } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
  };
}

/* A tile kind's own words, when the world gives them: English and Russian, each a label. */
const labelHolds = (label: unknown) => label === undefined || (isObject(label) && isLabel(label.en) && isLabel(label.ru) && Object.keys(label).length === 2);
const colorHolds = (color: unknown) => color === undefined || (typeof color === 'string' && COLOR.test(color));

/* The shipped recipe a world names, with its tile kinds renamed and recoloured as the world says. */
function recipeOf(raw: unknown, errors: string[]): TerrainRecipeSpec | null {
  if (!isObject(raw)) {
    errors.push('recipe must name one of the recipes Hornhoof ships: {"use": "<id>"}');
    return null;
  }
  const extra = Object.keys(raw).find(key => key !== 'use' && key !== 'tiles');
  if (extra) errors.push(`recipe has an unknown field "${extra}"`);
  const shipped = typeof raw.use === 'string' ? shippedRecipe(raw.use) : null;
  if (!shipped) {
    errors.push(`recipe.use must be one of ${shippedRecipeIds().join(', ')}`);
    return null;
  }
  return withTiles(shipped, raw.tiles === undefined ? {} : raw.tiles, errors);
}

/* A shipped recipe with the tile kinds the world renames and recolours; it brings no kind of its own. */
function withTiles(shipped: TerrainRecipeSpec, tiles: unknown, errors: string[]): TerrainRecipeSpec {
  if (!isObject(tiles)) {
    errors.push('recipe.tiles must be an object of tile kinds');
    return shipped;
  }
  const known = new Set(shipped.tileKinds.map(kind => kind.id));
  for (const id of Object.keys(tiles)) if (!known.has(id)) errors.push(`recipe.tiles names "${id}", a tile kind recipe ${shipped.id} does not have`);
  return { ...shipped, tileKinds: shipped.tileKinds.map(kind => (kind.id in tiles ? tileOverride(kind, tiles[kind.id], errors) : kind)) };
}

/* What a world written as data stays within, so an archive never asks a browser for more than a city's work: the map and
   its chunks, the zoom, the tile pictures and every other number. Hornhoof's packs are 150 tiles in chunks of 4, and
   no number of theirs is over 5200. */
export const WORLD_DATA_BOUNDS = {
  anyNumber: 10_000, mapSize: 512, chunkSize: [2, 64], chunksPerSide: 128, zoom: [0.25, 4], tileW: 1024, lods: 8, texelsPerTile: 1024,
} as const;

const numberAt = (raw: unknown, ...path: string[]): number | undefined => {
  let value = raw;
  for (const key of path) value = isObject(value) ? value[key] : undefined;
  return typeof value === 'number' ? value : undefined;
};

const boundsErrors = (raw: Raw): string[] => [...numberErrors(raw), ...gridErrors(raw), ...zoomErrors(raw), ...tileErrors(raw)];

/* At most this many wrong numbers are said: a world with thousands of them is refused as one with a few, and the check
   never holds or passes on more than it says (#1960, F4). */
const NUMBERS_SAID = 20;

/* Every number anywhere in the world, its place said, in the order the file gives them. */
function numberErrors(raw: Raw): string[] {
  const errors: string[] = [];
  const stack: [unknown, string][] = [[raw, '']];
  for (let next = stack.pop(); next && errors.length < NUMBERS_SAID; next = stack.pop()) visitNumber(next, stack, errors);
  return errors;
}

function visitNumber([value, at]: [unknown, string], stack: [unknown, string][], errors: string[]): void {
  if (typeof value === 'number' && !(Math.abs(value) <= WORLD_DATA_BOUNDS.anyNumber)) errors.push(`${at} is beyond ${WORLD_DATA_BOUNDS.anyNumber}`);
  else if (typeof value === 'object' && value !== null) for (const [key, inner] of Object.entries(value).reverse()) stack.push([inner, at ? `${at}.${key}` : key]);
}

/* The map, its chunks and how many of them a side. */
function gridErrors(raw: Raw): string[] {
  const B = WORLD_DATA_BOUNDS;
  const mapSize = numberAt(raw, 'mapSize') ?? 0;
  const chunkSize = numberAt(raw, 'params', 'chunkSize') ?? 0;
  const errors = mapSize > B.mapSize ? [`mapSize is at most ${B.mapSize} tiles`] : [];
  if (chunkSize < B.chunkSize[0] || chunkSize > B.chunkSize[1]) errors.push(`params.chunkSize is from ${B.chunkSize[0]} to ${B.chunkSize[1]} tiles`);
  else if (Math.ceil(mapSize / chunkSize) > B.chunksPerSide) errors.push(`the map is at most ${B.chunksPerSide} chunks a side: mapSize / params.chunkSize`);
  return errors;
}

function zoomErrors(raw: Raw): string[] {
  const [least, most] = WORLD_DATA_BOUNDS.zoom;
  return ['minZoom', 'defaultZoom', 'maxZoom']
    .filter(zoom => !inRange(numberAt(raw, 'camera', zoom), least, most))
    .map(zoom => `camera.${zoom} is from ${least} to ${most}`);
}

const inRange = (value: number | undefined, least: number, most: number) => value === undefined || (value >= least && value <= most);

/* The tile pictures: how many tiers, how wide each, and how many texels a tile of the painted ground takes. */
function tileErrors(raw: Raw): string[] {
  const B = WORLD_DATA_BOUNDS;
  const projection = isObject(raw.projection) ? raw.projection : {};
  const lods = Array.isArray(projection.lods) ? projection.lods : [];
  const errors = lods.length > B.lods ? [`projection.lods has at most ${B.lods} tiers`] : [];
  /* Tiers past the most a world may have are refused for their number, so only the widths of the first ones are read. */
  const widths: [string, unknown][] = [['projection.defaultTileW', projection.defaultTileW], ...lods.slice(0, B.lods).map((lod, n): [string, unknown] => [`projection.lods.${n}.tileW`, isObject(lod) ? lod.tileW : undefined])];
  errors.push(...widths.filter(([, value]) => !inRange(typeof value === 'number' ? value : undefined, -Infinity, B.tileW)).map(([at]) => `${at} is at most ${B.tileW} px`));
  if (!inRange(numberAt(raw, 'terrainArt', 'texelsPerTile'), -Infinity, B.texelsPerTile)) errors.push(`terrainArt.texelsPerTile is at most ${B.texelsPerTile}`);
  return errors;
}

/* The pack of a world written as data, under the theme's id, its art at baseUrl, checked as the shipped packs are. */
export function worldPackOfData(id: string, raw: unknown, baseUrl: string): Built {
  if (!isObject(raw)) return { ok: false, errors: ['world.json must be an object'] };
  const errors = Object.keys(raw).filter(key => !FIELDS.includes(key)).map(key => (key === 'id' ? 'id is the theme\'s own: leave it out' : `world.json has an unknown field "${key}"`));
  errors.push(...boundsErrors(raw));
  const recipe = recipeOf(raw.recipe, errors);
  if (raw.art !== undefined && !isObject(raw.art)) errors.push('art must be the art catalog object');
  if (errors.length || !recipe) return { ok: false, errors };
  const fields = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'recipe'));
  return checkedPack({ ...fields, id, terrainRecipe: recipe, ...(isObject(raw.art) ? { art: { ...raw.art, baseUrl } } : {}) } as unknown as WorldPackManifest);
}

function checkedPack(pack: WorldPackManifest): Built {
  try {
    const checked = validateWorldPack(pack);
    return checked.ok ? { ok: true, pack } : { ok: false, errors: [...checked.errors] };
  } catch (error) {
    return { ok: false, errors: [`world.json is not a world pack: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/* A shipped pack as a world written as data: what packs Hornhoof's own themes as archives. Its recipe is named by id
   with each tile kind's words and colour; the art's address and the pack's id are the installed theme's. A pack that
   chooses its empty tiles by code cannot be written as data. */
export function dataOfWorldPack(pack: WorldPackManifest): Record<string, unknown> {
  if (pack.resolveEmptyTileId) throw new Error(`World pack "${pack.id}" chooses its empty tiles by code, which a world written as data cannot.`);
  const { terrainRecipe, art } = pack;
  if (!terrainRecipe) throw new Error(`World pack "${pack.id}" has no map recipe, which a world written as data names.`);
  if (!shippedRecipe(terrainRecipe.id)) throw new Error(`World pack "${pack.id}" uses recipe "${terrainRecipe.id}", which Hornhoof does not ship.`);
  const fields = Object.fromEntries(Object.entries(pack).filter(([key]) => FIELDS.includes(key) && key !== 'art'));
  const tiles = Object.fromEntries(terrainRecipe.tileKinds.map(kind => [kind.id, { label: { en: kind.label.en, ru: kind.label.ru }, color: kind.color }]));
  const catalog = art ? { art: Object.fromEntries(Object.entries(art).filter(([key]) => key !== 'baseUrl')) } : {};
  return JSON.parse(JSON.stringify({ ...fields, recipe: { use: terrainRecipe.id, tiles }, ...catalog })) as Record<string, unknown>;
}
