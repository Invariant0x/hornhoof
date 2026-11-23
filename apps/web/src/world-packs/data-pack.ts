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
  const label = raw.label;
  if (label !== undefined && !(isObject(label) && isLabel(label.en) && isLabel(label.ru) && Object.keys(label).length === 2)) errors.push(`recipe.tiles.${kind.id}.label needs en and ru, each 1 to ${LABEL} characters`);
  if (raw.color !== undefined && !(typeof raw.color === 'string' && COLOR.test(raw.color))) errors.push(`recipe.tiles.${kind.id}.color needs #RRGGBB`);
  return {
    ...kind,
    ...(isObject(label) ? { label: { en: String(label.en), ru: String(label.ru) } } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
  };
}

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
  const tiles = raw.tiles === undefined ? {} : raw.tiles;
  if (!isObject(tiles)) {
    errors.push('recipe.tiles must be an object of tile kinds');
    return shipped;
  }
  const known = new Set(shipped.tileKinds.map(kind => kind.id));
  for (const id of Object.keys(tiles)) if (!known.has(id)) errors.push(`recipe.tiles names "${id}", a tile kind recipe ${shipped.id} does not have`);
  return { ...shipped, tileKinds: shipped.tileKinds.map(kind => (kind.id in tiles ? tileOverride(kind, tiles[kind.id], errors) : kind)) };
}

/* The pack of a world written as data, under the theme's id, its art at baseUrl, checked as the shipped packs are. */
export function worldPackOfData(id: string, raw: unknown, baseUrl: string): Built {
  if (!isObject(raw)) return { ok: false, errors: ['world.json must be an object'] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) if (!FIELDS.includes(key)) errors.push(key === 'id' ? 'id is the theme\'s own: leave it out' : `world.json has an unknown field "${key}"`);
  const recipe = recipeOf(raw.recipe, errors);
  if (raw.art !== undefined && !isObject(raw.art)) errors.push('art must be the art catalog object');
  if (errors.length || !recipe) return { ok: false, errors };
  const fields = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'recipe'));
  const pack = { ...fields, id, terrainRecipe: recipe, ...(isObject(raw.art) ? { art: { ...raw.art, baseUrl } } : {}) } as unknown as WorldPackManifest;
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
