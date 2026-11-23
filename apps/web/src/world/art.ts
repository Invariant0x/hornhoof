/* Art contract between a world pack's artists and the engine (see ARTIST_CONTRACT.md).
   A pack declares which pictures and sheets it has slots for (WorldArtCatalog); the art folder
   ships an art-index.json listing the files actually present with their sizes and passports.
   The engine draws a picture or sheet only when the index has it, and keeps the geometric
   placeholder for everything else, so art can arrive one file at a time.
   Pure data and math only: loading textures lives in art-runtime.ts. */

import type { BuildingKind, CityBuilding } from './city-layout';
import { resolveStageSpecForBuilding, type BuildingConstructionState } from './construction';
import { tileTopVertexToWorld, type Point2D } from './coords';
import {
  CONSTRUCTION_STAGE_IDS,
  type BuildingLoopKind,
  type ConstructionStageId,
  type FootprintKey,
  type UniqueRenderAngle5,
  type WorldPackManifest,
} from './manifest';
import type { ResidentEntity, ResidentPose } from './residents';

export const ART_CONTRACT_VERSION = 2;
export const ART_INDEX_FILE = 'art-index.json';
/* Two pixels of slack on master 4x geometry: one pixel of anti-aliasing on each side. */
export const ART_GEOMETRY_TOLERANCE_PX = 2;
export const PEOPLE_TIER_COUNT = 5;
export const SUPPLY_FILL_LEVELS = 5;

/* Master art is drawn at the 4x tier: a 240 x 120 px tile and a 136 px tall person. */
export function masterTileW(pack: WorldPackManifest): number {
  return pack.projection.lods.find(l => l.id === '4x')?.tileW ?? pack.projection.defaultTileW * 2;
}

export const ALTAR_PICTURE = 'buildings/altar/complete.png';

export const ART_FOOTPRINT_KEYS: readonly FootprintKey[] = ['1x1', '2x2', '3x3', '4x4', '5x5', '6x6'];

export type ArtPoint = Readonly<{ x: number; y: number }>;
export type ArtRect = Readonly<{ x: number; y: number; w: number; h: number }>;

export type ArtDiamond = Readonly<{ top: ArtPoint; right: ArtPoint; bottom: ArtPoint; left: ArtPoint }>;

export type ArtWorkSlotSpec = Readonly<{
  x: number;
  y: number;
  layer: 'front' | 'inside';
}>;

/* Passport of one building picture or shared construction module, in master 4x pixels, y down. */
export type BuildingPicturePassport = Readonly<{
  /* Centre of the footprint diamond on the ground: the point that sits on the lot centre. */
  groundAnchor: ArtPoint;
  corners: ArtDiamond;
  door?: ArtPoint;
  wallTopLine?: number;
  roofLine?: number;
  /* Row where a full-height wall picture is cut to stand in for waist-high walls. */
  wallCutY?: number;
  flagAnchor?: ArtPoint;
  awningAnchor?: ArtPoint;
  /* Top centre (apex, spire, chimney) where a capstone or a top loop attaches. */
  topAnchor?: ArtPoint;
  workSlots?: readonly ArtWorkSlotSpec[];
  /* Pictures on the same canvas drawn over this one, in order (contract section 4, layers). */
  layers?: readonly ArtLayerSpec[];
  /* A shared module drawn as an empty canvas says why here (nothing of it fits the lot); the engine lays nothing. */
  empty?: string;
}>;

/* One layer over a building picture: a file beside it on the same canvas and registration. A shadow layer multiplies
   the ground and walls under it; a swaying layer (awning, cloth) moves in the wind about a line where it is fixed. */
export type ArtLayerSpec = Readonly<{
  file: string;
  blend?: 'multiply';
  sway?: Readonly<{
    /* Two points of the line the layer hangs from; the cloth on the far side of it sways. */
    pivot: readonly [ArtPoint, ArtPoint];
    /* Vertical shift of a pixel per pixel of distance from the line at the strongest gust (default 0.03). */
    amplitude?: number;
  }>;
}>;

/* Passport of a small attached picture (flag, capstone): the point that touches its parent. */
export type AnchorPassport = Readonly<{ anchor: ArtPoint }>;

export type LoopAttachPoint = 'top' | 'awning' | 'door' | 'ground';

/* Passport of an animation sheet: frames left to right; people have one row per direction. */
export type SheetPassport = Readonly<{
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
  /* Feet point for people, attach point for loops, inside one frame. */
  anchor: ArtPoint;
  attach?: LoopAttachPoint;
}>;

export type ArtPassport = BuildingPicturePassport | AnchorPassport | SheetPassport;

export type ArtIndexEntry = Readonly<{ w: number; h: number; passport?: ArtPassport }>;

export type ArtIndex = Readonly<{
  contract: number;
  pack: string;
  files: Readonly<Record<string, ArtIndexEntry>>;
}>;

/* One growth step of a building kind with its own pictures (a hut, a villa, a bigger temple). */
export type ArtBuildingStep = Readonly<{
  id: string;
  footprint: FootprintKey;
  /* The step applies from this building stage or agent level on (houses grow by level). */
  fromStage?: number;
  fromLevel?: number;
  label: Readonly<{ en: string; ru: string }>;
}>;

export type ArtStagePictureRule = Readonly<{
  picture?: BuildingPictureName;
  module?: 'stakes' | 'foundation';
  /* Cut the picture at its passport wallCutY, keeping the part below the line. */
  cutToWallLine?: boolean;
  fallback?: BuildingPictureName;
}>;

export type WorldArtCatalog = Readonly<{
  /* Absolute path or URL of the folder holding art-index.json, ending with a slash. */
  baseUrl: string;
  buildings: Readonly<Partial<Record<BuildingKind, readonly ArtBuildingStep[]>>>;
  stagePictures?: Readonly<Partial<Record<ConstructionStageId, ArtStagePictureRule>>>;
  altar?: boolean;
  flags?: Readonly<{ district?: boolean; department?: boolean }>;
  people?: Readonly<{ looks: readonly string[]; tiers: number }>;
  loops?: readonly BuildingLoopKind[];
}>;

export const STANDARD_BUILDING_PICTURES = [
  'low_walls_open',
  'full_walls',
  'roof_beams',
  'roof',
  'complete',
  'upgraded',
  'annex',
] as const;
export type BuildingPictureName = (typeof STANDARD_BUILDING_PICTURES)[number];
const OPTIONAL_BUILDING_PICTURES: ReadonlySet<string> = new Set(['upgraded', 'annex']);
/* Construction stage a contract 1 picture shows; a step's own stage_NN picture stands in for it. */
const STAGE_OF_PICTURE: Readonly<Partial<Record<BuildingPictureName, number>>> = { low_walls_open: 3, full_walls: 5, roof_beams: 6, roof: 7 };
/* Demolition of a step drawn by the artist: half torn down, then rubble. */
export const DEMOLITION_PICTURES = ['demol_01', 'demol_02'] as const;

export const CONSTRUCTION_MODULES = ['stakes', 'foundation', 'scaffold_back', 'scaffold_front', 'ramp'] as const;
const OPTIONAL_MODULES: ReadonlySet<string> = new Set(['scaffold_back']);

/* Default way each construction stage is drawn: stages 1 and 2 are shared modules per footprint,
   stage 4 reuses the open-room picture and stage 8 the finished picture under scaffolding. */
export const DEFAULT_STAGE_PICTURES: Readonly<Record<ConstructionStageId, ArtStagePictureRule>> = {
  stakes_and_rope: { module: 'stakes' },
  foundation: { module: 'foundation' },
  low_walls_open: { picture: 'low_walls_open' },
  waist_walls_scaffold: { picture: 'low_walls_open' },
  full_walls: { picture: 'full_walls' },
  roof_beams: { picture: 'roof_beams' },
  roof: { picture: 'roof' },
  finishing: { picture: 'complete' },
  complete: { picture: 'complete' },
  upgraded: { picture: 'upgraded', fallback: 'complete' },
};

export const RESIDENT_ANIMATION_IDS = [
  'idle',
  'walk',
  'carry',
  'carry_back',
  'build',
  'inspect',
  'direct',
  'survey',
  'write',
  'carve',
  'gong',
  'extinguish',
  'guard',
  'hold_scroll',
  'pray',
  'broken_tool',
  'sleep',
] as const;
export type ResidentAnimationId = (typeof RESIDENT_ANIMATION_IDS)[number];

export const POSE_ANIMATIONS: Readonly<Record<ResidentPose, ResidentAnimationId>> = {
  walking: 'walk',
  carrying_stone: 'carry',
  returning_stone: 'carry_back',
  building: 'build',
  building_home: 'build',
  inspecting: 'inspect',
  directing: 'direct',
  surveying: 'survey',
  writing: 'write',
  carving: 'carve',
  ringing_gong: 'gong',
  extinguishing: 'extinguish',
  guarding: 'guard',
  holding_scroll: 'hold_scroll',
  praying: 'pray',
  broken_tool: 'broken_tool',
  sleeping: 'sleep',
  idle: 'idle',
};

const MOVING_ANIMATIONS: ReadonlySet<ResidentAnimationId> = new Set(['walk', 'carry', 'carry_back']);

export const DIRECTION_ROWS: readonly UniqueRenderAngle5[] = ['N', 'NE', 'E', 'SE', 'S'];

export type DeclaredArtRole = 'building' | 'module' | 'altar' | 'flag' | 'capstone' | 'person' | 'cloak' | 'loop';

export type DeclaredArtFile = Readonly<{
  path: string;
  role: DeclaredArtRole;
  passport: 'picture' | 'anchor' | 'sheet' | 'none';
  required: boolean;
  /* A required picture another file stands in for: with that file in the folder this one is not needed. */
  alternative?: string;
  /* For a cloak layer: the base sheet it must match pixel for pixel. */
  baseSheet?: string;
}>;

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function artFootprintKey(span: number): FootprintKey {
  const clamped = Math.max(1, Math.min(6, Math.round(span)));
  return `${clamped}x${clamped}` as FootprintKey;
}

function footprintSpan(key: FootprintKey): number {
  return Number(key.split('x')[0]);
}

function stepPicturePath(kind: BuildingKind, step: ArtBuildingStep, picture: string): string {
  return `buildings/${kind}/${step.id}/${picture}.png`;
}

export function modulePath(footprint: FootprintKey, module: (typeof CONSTRUCTION_MODULES)[number]): string {
  return `modules/${footprint}/${module}.png`;
}

export function personSheetPath(lookId: string, tier: number, anim: ResidentAnimationId, cloak = false): string {
  return `people/${lookId}/tier_${tier}/${anim}${cloak ? '.cloak' : ''}.png`;
}

/* Every file the pack's catalog has a slot for, with the passport kind each one needs. */
export function declaredArtFiles(pack: WorldPackManifest): readonly DeclaredArtFile[] {
  const art = pack.art;
  if (!art) return [];
  const out: DeclaredArtFile[] = [];
  const moduleFootprints = new Set<FootprintKey>();

  for (const [kindKey, steps] of Object.entries(art.buildings)) {
    const kind = kindKey as BuildingKind;
    for (const step of steps ?? []) {
      if (kind === 'statue') {
        for (let s = 1; s <= pack.stageCounts.statue; s++) {
          out.push({ path: stepPicturePath(kind, step, `stage_${pad2(s)}`), role: 'building', passport: 'picture', required: true });
        }
        continue;
      }
      if (kind === 'monument') {
        for (let t = 1; t <= pack.stageCounts.monument; t++) {
          out.push({ path: stepPicturePath(kind, step, `tier_${pad2(t)}`), role: 'building', passport: 'picture', required: true });
        }
        out.push({ path: stepPicturePath(kind, step, 'capstone'), role: 'capstone', passport: 'anchor', required: true });
        continue;
      }
      moduleFootprints.add(step.footprint);
      for (const picture of STANDARD_BUILDING_PICTURES) {
        if (kind === 'supply' && picture === 'complete') continue;
        const stage = STAGE_OF_PICTURE[picture];
        out.push({
          path: stepPicturePath(kind, step, picture),
          role: 'building',
          passport: 'picture',
          required: !OPTIONAL_BUILDING_PICTURES.has(picture),
          ...(stage ? { alternative: stepPicturePath(kind, step, `stage_${pad2(stage)}`) } : {}),
        });
      }
      /* Contract 2: the whole construction line drawn on the step's own canvas, and its demolition. */
      if (kind !== 'supply') {
        for (let n = 1; n <= pack.stageCounts.construction; n++) {
          out.push({ path: stepPicturePath(kind, step, `stage_${pad2(n)}`), role: 'building', passport: 'picture', required: false });
        }
        for (const picture of DEMOLITION_PICTURES) {
          out.push({ path: stepPicturePath(kind, step, picture), role: 'building', passport: 'picture', required: false });
        }
      }
      if (kind === 'supply') {
        for (let f = 0; f < SUPPLY_FILL_LEVELS; f++) {
          out.push({ path: stepPicturePath(kind, step, `fill_${f}`), role: 'building', passport: 'picture', required: true });
        }
      }
    }
  }

  for (const fp of ART_FOOTPRINT_KEYS) {
    if (!moduleFootprints.has(fp)) continue;
    for (const mod of CONSTRUCTION_MODULES) {
      out.push({ path: modulePath(fp, mod), role: 'module', passport: 'picture', required: !OPTIONAL_MODULES.has(mod) });
    }
  }

  if (art.altar) {
    out.push({ path: ALTAR_PICTURE, role: 'altar', passport: 'picture', required: true });
  }
  if (art.flags?.district) out.push({ path: 'flags/district.png', role: 'flag', passport: 'anchor', required: true });
  if (art.flags?.department) out.push({ path: 'flags/department.png', role: 'flag', passport: 'anchor', required: true });

  if (art.people) {
    for (const look of art.people.looks) {
      for (let tier = 1; tier <= art.people.tiers; tier++) {
        for (const anim of RESIDENT_ANIMATION_IDS) {
          const base = personSheetPath(look, tier, anim);
          out.push({ path: base, role: 'person', passport: 'sheet', required: tier === 1 });
          out.push({ path: personSheetPath(look, tier, anim, true), role: 'cloak', passport: 'none', required: false, baseSheet: base });
        }
      }
    }
  }

  for (const loop of art.loops ?? []) {
    out.push({ path: `loops/${loop}.png`, role: 'loop', passport: 'sheet', required: true });
  }
  return out;
}

export type ArtIndexReport = Readonly<{
  ok: boolean;
  errors: readonly string[];
  warnings: readonly string[];
  declared: number;
  present: number;
  missingRequired: readonly string[];
}>;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= ART_GEOMETRY_TOLERANCE_PX;
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isPoint(v: unknown): v is ArtPoint {
  return Boolean(v) && isFiniteNum((v as ArtPoint).x) && isFiniteNum((v as ArtPoint).y);
}

function pointInside(p: ArtPoint, w: number, h: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h;
}

function checkPicture(
  pack: WorldPackManifest,
  path: string,
  entry: ArtIndexEntry,
  footprint: FootprintKey | null,
  errors: string[],
): void {
  const p = entry.passport as BuildingPicturePassport | undefined;
  if (!p || !isPoint(p.groundAnchor) || !p.corners || !isPoint(p.corners.top) || !isPoint(p.corners.right) || !isPoint(p.corners.bottom) || !isPoint(p.corners.left)) {
    errors.push(`${path}: needs a picture passport with groundAnchor and four corners`);
    return;
  }
  const { top, right, bottom, left } = p.corners;
  const diamondW = right.x - left.x;
  const diamondH = bottom.y - top.y;
  if (!near(diamondW, diamondH * 2)) {
    errors.push(`${path}: footprint diamond must be 2:1, it is ${diamondW} x ${diamondH}`);
  }
  if (!near(top.x, bottom.x) || !near(left.y, right.y)) {
    errors.push(`${path}: footprint corners must be symmetric around the ground anchor`);
  }
  if (!near(p.groundAnchor.x, (left.x + right.x) / 2) || !near(p.groundAnchor.y, (top.y + bottom.y) / 2)) {
    errors.push(`${path}: groundAnchor must sit at the centre of the footprint diamond`);
  }
  if (footprint) {
    const fp = pack.projection.buildingFootprintsMaster4x[footprint];
    if (!near(diamondW, fp.diamondW)) {
      errors.push(`${path}: diamond width ${diamondW} px does not match footprint ${footprint} (${fp.diamondW} px)`);
    }
    if (entry.h > fp.maxCanvasH) {
      errors.push(`${path}: ${entry.h} px is taller than ${fp.maxCanvasH} px allowed for footprint ${footprint}`);
    }
  }
  const named: Array<[string, ArtPoint | undefined]> = [
    ['groundAnchor', p.groundAnchor],
    ['door', p.door],
    ['flagAnchor', p.flagAnchor],
    ['awningAnchor', p.awningAnchor],
    ['topAnchor', p.topAnchor],
    ...Object.entries(p.corners).map(([k, v]) => [`corners.${k}`, v] as [string, ArtPoint]),
  ];
  for (const [name, pt] of named) {
    if (pt !== undefined && (!isPoint(pt) || !pointInside(pt, entry.w, entry.h))) {
      errors.push(`${path}: ${name} lies outside the ${entry.w} x ${entry.h} picture`);
    }
  }
  for (const [name, y] of [['wallTopLine', p.wallTopLine], ['roofLine', p.roofLine], ['wallCutY', p.wallCutY]] as const) {
    if (y !== undefined && (!isFiniteNum(y) || y < 0 || y >= entry.h)) {
      errors.push(`${path}: ${name} lies outside the picture`);
    }
  }
  for (const slot of p.workSlots ?? []) {
    if (!isPoint(slot) || !pointInside(slot, entry.w, entry.h) || (slot.layer !== 'front' && slot.layer !== 'inside')) {
      errors.push(`${path}: every work slot needs x, y inside the picture and layer front or inside`);
      break;
    }
  }
  if (p.layers !== undefined && !Array.isArray(p.layers)) errors.push(`${path}: layers must be a list`);
  for (const layer of Array.isArray(p.layers) ? p.layers : []) {
    if (!layer || typeof layer.file !== 'string' || !LAYER_FILE.test(layer.file) || layer.file.includes('..')) {
      errors.push(`${path}: every layer needs a file, a png beside the picture`);
      continue;
    }
    if (layer.blend !== undefined && layer.blend !== 'multiply') errors.push(`${path}: layer ${layer.file} blend must be multiply`);
    if (layer.sway !== undefined) {
      const pv = layer.sway.pivot;
      const amp = layer.sway.amplitude;
      if (!Array.isArray(pv) || pv.length !== 2 || !pv.every(pt => isPoint(pt) && pointInside(pt, entry.w, entry.h))) {
        errors.push(`${path}: layer ${layer.file} sway needs two pivot points inside the picture`);
      } else if (Math.hypot(pv[1]!.x - pv[0]!.x, pv[1]!.y - pv[0]!.y) < 1) {
        errors.push(`${path}: layer ${layer.file} sway pivot points must differ`);
      }
      if (amp !== undefined && !(isFiniteNum(amp) && amp > 0 && amp <= 0.2)) {
        errors.push(`${path}: layer ${layer.file} sway amplitude must be above 0 and at most 0.2`);
      }
    }
  }
}

/* A layer's file name: a png in the picture's folder or below it. */
const LAYER_FILE = /^[\w-][\w./-]*\.png$/;

/* Path of a layer file named in a picture's passport: beside the picture. */
export function artLayerPath(picturePath: string, file: string): string {
  return picturePath.slice(0, picturePath.lastIndexOf('/') + 1) + file;
}

function checkSheet(path: string, entry: ArtIndexEntry, rows: number | null, errors: string[]): void {
  const s = entry.passport as SheetPassport | undefined;
  if (!s || !isFiniteNum(s.frameW) || !isFiniteNum(s.frameH) || !isFiniteNum(s.frames) || !isFiniteNum(s.fps) || !isPoint(s.anchor)) {
    errors.push(`${path}: needs a sheet passport with frameW, frameH, frames, fps and anchor`);
    return;
  }
  if (s.frames < 1 || !Number.isInteger(s.frames) || s.fps <= 0) {
    errors.push(`${path}: frames must be a positive whole number and fps above zero`);
  }
  if (entry.w !== s.frameW * s.frames) {
    errors.push(`${path}: width ${entry.w} px must equal frameW * frames (${s.frameW * s.frames} px)`);
  }
  if (rows !== null) {
    if (entry.h !== s.frameH * rows) {
      errors.push(`${path}: height ${entry.h} px must hold ${rows} direction rows of ${s.frameH} px (N, NE, E, SE, S)`);
    }
  } else if (entry.h % s.frameH !== 0 || entry.h === 0) {
    errors.push(`${path}: height ${entry.h} px must be a whole number of ${s.frameH} px rows`);
  }
  if (!pointInside(s.anchor, s.frameW, s.frameH)) {
    errors.push(`${path}: anchor lies outside one ${s.frameW} x ${s.frameH} frame`);
  }
}

/* Checks the art folder's index against the pack's catalog and the contract's geometry rules. */
export function validateArtIndex(pack: WorldPackManifest, index: ArtIndex): ArtIndexReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const declared = declaredArtFiles(pack);
  const byPath = new Map(declared.map(d => [d.path, d]));

  if (index.contract !== ART_CONTRACT_VERSION) {
    errors.push(`art-index.json is for contract ${index.contract}, the engine reads contract ${ART_CONTRACT_VERSION}`);
  }
  if (index.pack !== pack.id) {
    errors.push(`art-index.json belongs to pack "${index.pack}", not "${pack.id}"`);
  }

  const footprintOf = new Map<string, FootprintKey>();
  for (const [kindKey, steps] of Object.entries(pack.art?.buildings ?? {})) {
    for (const step of steps ?? []) footprintOf.set(`buildings/${kindKey}/${step.id}/`, step.footprint);
  }

  /* Layer files are declared by the passports that name them and must match their picture's canvas. */
  const layerOf = new Map<string, string>();
  for (const [path, entry] of Object.entries(index.files)) {
    const layers = (entry.passport as BuildingPicturePassport | undefined)?.layers;
    if (!byPath.has(path) || !Array.isArray(layers)) continue;
    for (const layer of layers) {
      if (typeof layer?.file !== 'string') continue;
      const lp = artLayerPath(path, layer.file);
      const le = index.files[lp];
      if (!le) errors.push(`${path}: layer ${layer.file} is not in the folder`);
      else if (le.w !== entry.w || le.h !== entry.h) errors.push(`${lp}: a layer must be the same size as ${path} (${entry.w} x ${entry.h})`);
      layerOf.set(lp, path);
    }
  }

  for (const [path, entry] of Object.entries(index.files)) {
    const slot = byPath.get(path);
    if (!slot && layerOf.has(path)) continue;
    if (!slot) {
      warnings.push(`${path}: not declared by the pack catalog, the engine will not draw it`);
      continue;
    }
    if (!isFiniteNum(entry.w) || !isFiniteNum(entry.h) || entry.w <= 0 || entry.h <= 0) {
      errors.push(`${path}: width and height must be positive`);
      continue;
    }
    if (slot.passport === 'picture') {
      let fp: FootprintKey | null = null;
      if (slot.role === 'module') fp = path.split('/')[1] as FootprintKey;
      else if (slot.role === 'building') fp = footprintOf.get(path.slice(0, path.lastIndexOf('/') + 1)) ?? null;
      checkPicture(pack, path, entry, fp, errors);
    } else if (slot.passport === 'anchor') {
      const a = entry.passport as AnchorPassport | undefined;
      if (!a || !isPoint(a.anchor) || !pointInside(a.anchor, entry.w, entry.h)) {
        errors.push(`${path}: needs a passport with an anchor inside the picture`);
      }
    } else if (slot.passport === 'sheet') {
      checkSheet(path, entry, slot.role === 'person' ? DIRECTION_ROWS.length : null, errors);
    } else if (slot.role === 'cloak' && slot.baseSheet) {
      const base = index.files[slot.baseSheet];
      if (!base) {
        errors.push(`${path}: cloak layer without its base sheet ${slot.baseSheet}`);
      } else if (base.w !== entry.w || base.h !== entry.h) {
        errors.push(`${path}: cloak layer must be the same size as ${slot.baseSheet} (${base.w} x ${base.h})`);
      }
    }
  }

  const missingRequired = declared
    .filter(d => d.required && !index.files[d.path] && !(d.alternative && index.files[d.alternative]))
    .map(d => d.path);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    declared: declared.length,
    present: Object.keys(index.files).length,
    missingRequired,
  };
}

/* Structural checks of a pack's catalog, run by validateWorldPack. */
export function validateArtCatalog(art: WorldArtCatalog): string[] {
  const errors: string[] = [];
  if (!/^(\/|https?:\/\/).*\/$/.test(art.baseUrl)) {
    errors.push('art.baseUrl must be an absolute path or URL ending with "/"');
  }
  for (const [kind, steps] of Object.entries(art.buildings)) {
    const ids = new Set<string>();
    for (const step of steps ?? []) {
      if (!/^[a-z0-9_]+$/.test(step.id)) errors.push(`art.buildings.${kind}: step id "${step.id}" must be lowercase letters, digits or _`);
      if (ids.has(step.id)) errors.push(`art.buildings.${kind}: duplicate step id "${step.id}"`);
      ids.add(step.id);
      if (!ART_FOOTPRINT_KEYS.includes(step.footprint)) {
        errors.push(`art.buildings.${kind}.${step.id}: unknown footprint "${String(step.footprint)}"`);
      }
    }
  }
  if (art.people) {
    const t = art.people.tiers;
    if (!Number.isInteger(t) || t < 1 || t > PEOPLE_TIER_COUNT) {
      errors.push(`art.people.tiers must be a whole number from 1 to ${PEOPLE_TIER_COUNT}`);
    }
    for (const look of art.people.looks) {
      if (!/^[a-z0-9_-]+$/.test(look)) errors.push(`art.people.looks: "${look}" must be lowercase letters, digits, - or _`);
    }
  }
  return errors;
}

export type BuildingArtLayer = Readonly<{
  path: string;
  /* Part of the file to draw, in its own pixels. */
  frame: ArtRect;
  /* Point of the frame that lands on the building ground point plus offset. */
  anchor: ArtPoint;
  /* Art pixels from the building ground point (main picture groundAnchor) to this layer's anchor. */
  offset: ArtPoint;
  tint?: string;
  blend?: 'multiply';
  /* Sways about the line a-b (picture pixels), by up to `amplitude` pixels per pixel away from it. */
  sway?: Readonly<{ a: ArtPoint; b: ArtPoint; amplitude: number }>;
}>;

export type BuildingArt = Readonly<{
  layers: readonly BuildingArtLayer[];
  /* Art pixels across one tile of the main picture: world scale = tileW / artPxPerTile. */
  artPxPerTile: number;
  passport: BuildingPicturePassport;
}>;

export type BuildingArtOptions = Readonly<{
  upgrading?: boolean;
  districtColor?: string;
  departmentColor?: string;
}>;

function pickStep(
  steps: readonly ArtBuildingStep[] | undefined,
  building: Pick<CityBuilding, 'spanCol' | 'stage' | 'level'>,
  stage: number,
): ArtBuildingStep | null {
  if (!steps || steps.length === 0) return null;
  const eligible = steps.filter(
    s => (s.fromStage === undefined || stage >= s.fromStage) && (s.fromLevel === undefined || building.level >= s.fromLevel),
  );
  const pool = eligible.length > 0 ? eligible : steps;
  let best: ArtBuildingStep | null = null;
  let bestScore = Infinity;
  pool.forEach((s, i) => {
    const diff = footprintSpan(s.footprint) - building.spanCol;
    /* Exact size first, then the nearest larger step (downscaling keeps detail), later steps win ties. */
    const score = Math.abs(diff) * 2 + (diff < 0 ? 1 : 0) - i * 1e-3;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  });
  return best;
}

function pictureLayer(path: string, entry: ArtIndexEntry, cutY?: number): BuildingArtLayer {
  const p = entry.passport as BuildingPicturePassport;
  const y0 = cutY !== undefined ? Math.max(0, Math.min(entry.h - 1, cutY)) : 0;
  return {
    path,
    frame: { x: 0, y: y0, w: entry.w, h: entry.h - y0 },
    anchor: { x: p.groundAnchor.x, y: p.groundAnchor.y - y0 },
    offset: { x: 0, y: 0 },
  };
}

function attachedLayer(
  path: string,
  entry: ArtIndexEntry,
  main: BuildingPicturePassport,
  at: ArtPoint,
  tint?: string,
): BuildingArtLayer {
  const a = (entry.passport as AnchorPassport).anchor;
  return {
    path,
    frame: { x: 0, y: 0, w: entry.w, h: entry.h },
    anchor: { x: a.x, y: a.y },
    offset: { x: at.x - main.groundAnchor.x, y: at.y - main.groundAnchor.y },
    ...(tint ? { tint } : {}),
  };
}

/* A picture's own layers from its passport, on its canvas; a layer whose file is not in the folder is left out. */
function passportLayers(files: ArtIndex['files'], path: string, main: BuildingPicturePassport): BuildingArtLayer[] {
  const out: BuildingArtLayer[] = [];
  for (const spec of Array.isArray(main.layers) ? main.layers : []) {
    if (typeof spec?.file !== 'string' || !LAYER_FILE.test(spec.file) || spec.file.includes('..')) continue;
    const lp = artLayerPath(path, spec.file);
    const entry = files[lp];
    if (!entry) continue;
    out.push({
      path: lp,
      frame: { x: 0, y: 0, w: entry.w, h: entry.h },
      anchor: { x: main.groundAnchor.x, y: main.groundAnchor.y },
      offset: { x: 0, y: 0 },
      ...(spec.blend ? { blend: spec.blend } : {}),
      ...(spec.sway ? { sway: { a: spec.sway.pivot[0], b: spec.sway.pivot[1], amplitude: spec.sway.amplitude ?? 0.03 } } : {}),
    });
  }
  return out;
}

/* A shared module laid over a building's picture; none when it is missing or drawn as an empty canvas. */
function moduleLayer(files: ArtIndex['files'], path: string): BuildingArtLayer | null {
  const entry = files[path];
  if (!hasPicturePassport(entry) || entry.passport.empty) return null;
  return pictureLayer(path, entry);
}

function hasPicturePassport(entry: ArtIndexEntry | undefined): entry is ArtIndexEntry & { passport: BuildingPicturePassport } {
  return Boolean(entry?.passport && 'groundAnchor' in entry.passport && 'corners' in entry.passport);
}

function hasAnchorPassport(entry: ArtIndexEntry | undefined): boolean {
  return Boolean(entry?.passport && 'anchor' in entry.passport && !('frames' in entry.passport));
}

function pushFlag(
  art: WorldArtCatalog,
  files: ArtIndex['files'],
  building: CityBuilding,
  main: BuildingPicturePassport,
  layers: BuildingArtLayer[],
  options: BuildingArtOptions,
): void {
  if (!main.flagAnchor) return;
  const isDept = building.kind === 'department';
  const tint = isDept ? options.departmentColor : options.districtColor;
  const flagPath = isDept ? 'flags/department.png' : 'flags/district.png';
  const wanted = isDept ? art.flags?.department : art.flags?.district;
  if (wanted && tint && hasAnchorPassport(files[flagPath])) {
    layers.push(attachedLayer(flagPath, files[flagPath]!, main, main.flagAnchor, tint));
  }
}

/* Chooses the pictures for a building at its current growth or construction stage,
   or null when any picture it needs is missing so the placeholder draws instead. */
export function resolveBuildingArt(
  pack: WorldPackManifest,
  index: ArtIndex | null,
  building: CityBuilding,
  job: BuildingConstructionState | null,
  options: BuildingArtOptions = {},
): BuildingArt | null {
  const art = pack.art;
  if (!art || !index) return null;
  if (job && job.phase === 'cleared') return null;
  const files = index.files;
  const stage = job ? job.currentStage : building.stage;
  /* Growth steps follow the building's own stage or level; a construction job only walks pictures inside the step. */
  const step = pickStep(art.buildings[building.kind], building, building.stage);
  if (!step) return null;
  const base = (picture: string) => stepPicturePath(building.kind, step, picture);

  const finish = (layers: BuildingArtLayer[], mainPath: string): BuildingArt | null => {
    const mainEntry = files[mainPath];
    if (!hasPicturePassport(mainEntry)) return null;
    const main = mainEntry.passport;
    const span = Math.max(1, building.spanCol);
    return { layers, artPxPerTile: (main.corners.right.x - main.corners.left.x) / span, passport: main };
  };

  if (building.kind === 'statue') {
    const path = base(`stage_${pad2(Math.max(1, Math.min(pack.stageCounts.statue, stage)))}`);
    const entry = files[path];
    return hasPicturePassport(entry) ? finish([pictureLayer(path, entry)], path) : null;
  }

  if (building.kind === 'monument') {
    const tiers = pack.stageCounts.monument;
    const maxS = Math.max(1, job ? job.maxStage : building.maxStage);
    const reached = job ? job.phase === 'complete' && stage >= maxS : Boolean(building.reached);
    const progress = job ? stage / maxS : (building.progress ?? stage / maxS);
    const tier = reached ? tiers : Math.max(1, Math.min(tiers, Math.round(progress * tiers)));
    const path = base(`tier_${pad2(tier)}`);
    const entry = files[path];
    if (!hasPicturePassport(entry)) return null;
    const layers = [pictureLayer(path, entry)];
    const capPath = base('capstone');
    const cap = files[capPath];
    if (reached && entry.passport.topAnchor && hasAnchorPassport(cap)) {
      layers.push(attachedLayer(capPath, cap!, entry.passport, entry.passport.topAnchor));
    }
    return finish(layers, path);
  }

  const footprint = step.footprint;
  const layers: BuildingArtLayer[] = [];
  let mainPath: string;

  /* Outside construction a building shows the finished look of its growth step, as the placeholders do. */
  if (!job) {
    let picture = 'complete';
    if (building.kind === 'supply') {
      const fullness = building.resting ? 0 : (building.fullness ?? 0.5);
      picture = `fill_${Math.max(0, Math.min(SUPPLY_FILL_LEVELS - 1, Math.round(fullness * (SUPPLY_FILL_LEVELS - 1))))}`;
    } else if (options.upgrading && files[base('annex')]) {
      picture = 'annex';
    } else if (building.stage >= building.maxStage && files[base('upgraded')]) {
      picture = 'upgraded';
    }
    mainPath = base(picture);
    const entry = files[mainPath];
    if (!hasPicturePassport(entry)) return null;
    layers.push(pictureLayer(mainPath, entry), ...passportLayers(files, mainPath, entry.passport));
    pushFlag(art, files, building, entry.passport, layers, options);
    return finish(layers, mainPath);
  }

  const spec = resolveStageSpecForBuilding(building, job, pack);
  const rule = art.stagePictures?.[spec.id] ?? DEFAULT_STAGE_PICTURES[spec.id];

  /* Contract 2: the step's own pictures. Demolition shows the building half torn down, then its rubble; a stage
     before the finished building shows its own picture of that stage, scaffolding and ramps drawn in it or not. */
  const own = (path: string): BuildingArt | null => {
    const entry = files[path];
    if (!hasPicturePassport(entry)) return null;
    return finish([pictureLayer(path, entry), ...passportLayers(files, path, entry.passport)], path);
  };
  if (job.phase === 'demolishing' && files[base('demol_01')] && files[base('demol_02')]) {
    return own(base(job.currentStage > job.maxStage / 2 ? 'demol_01' : 'demol_02'));
  }
  const stageNo = CONSTRUCTION_STAGE_IDS.indexOf(spec.id) + 1;
  const stagePath = base(`stage_${pad2(stageNo)}`);
  if (spec.id !== 'complete' && spec.id !== 'upgraded' && building.kind !== 'supply' && files[stagePath]) {
    return own(stagePath);
  }

  if (rule.module) {
    mainPath = modulePath(footprint, rule.module);
    const entry = files[mainPath];
    if (!hasPicturePassport(entry)) return null;
    layers.push(pictureLayer(mainPath, entry));
    return finish(layers, mainPath);
  }

  const finished = spec.id === 'complete' || spec.id === 'upgraded';
  let picture: string = rule.picture ?? 'complete';
  if (building.kind === 'supply' && finished) {
    picture = `fill_${SUPPLY_FILL_LEVELS - 1}`;
  } else if (!files[base(picture)] && rule.fallback) {
    picture = rule.fallback;
  }
  mainPath = base(picture);
  const mainEntry = files[mainPath];
  if (!hasPicturePassport(mainEntry)) return null;
  const cutY = rule.cutToWallLine ? mainEntry.passport.wallCutY : undefined;

  const scaffold = spec.hasScaffolding;
  const pushModule = (mod: (typeof CONSTRUCTION_MODULES)[number]) => {
    const layer = moduleLayer(files, modulePath(footprint, mod));
    if (layer) layers.push(layer);
  };
  if (scaffold) pushModule('scaffold_back');
  layers.push(pictureLayer(mainPath, mainEntry, cutY));
  if (cutY === undefined) layers.push(...passportLayers(files, mainPath, mainEntry.passport));
  if (spec.hasRamp) pushModule('ramp');
  if (scaffold) pushModule('scaffold_front');

  if (finished) pushFlag(art, files, building, mainEntry.passport, layers, options);
  return finish(layers, mainPath);
}

/* World position of the centre of a building's footprint: where its picture's ground anchor lands. */
export function artFootprintCentre(
  building: Pick<CityBuilding, 'col' | 'row' | 'spanCol' | 'spanRow'>,
  tileW: number,
  tileH: number,
): Point2D {
  return tileTopVertexToWorld(building.col + building.spanCol / 2, building.row + building.spanRow / 2, tileW, tileH);
}

export type ResidentArtLayer = Readonly<{ path: string; frame: ArtRect; anchor: ArtPoint; tint?: string }>;

export type ResidentArt = Readonly<{
  layers: readonly ResidentArtLayer[];
  mirror: boolean;
}>;

const MIRRORED_FACES: Readonly<Record<string, UniqueRenderAngle5>> = { SW: 'SE', W: 'E', NW: 'NE' };

function sheetEntry(index: ArtIndex, path: string): (ArtIndexEntry & { passport: SheetPassport }) | null {
  const entry = index.files[path];
  if (!entry?.passport || !('frames' in entry.passport)) return null;
  return entry as ArtIndexEntry & { passport: SheetPassport };
}

/* Chooses a resident's sheet (look, outfit tier, animation) and the frame to show,
   falling back to lower outfit tiers, then to walking or standing, then to the placeholder. */
export function resolveResidentArt(
  pack: WorldPackManifest,
  index: ArtIndex | null,
  resident: ResidentEntity,
  timeSec: number,
): ResidentArt | null {
  const people = pack.art?.people;
  if (!people || !index) return null;
  const looks = [resident.look.id, pack.classFallbackLooks?.[resident.roleClass]?.id].filter(
    (id): id is string => Boolean(id) && people.looks.includes(id!),
  );
  if (looks.length === 0) return null;

  const wanted = POSE_ANIMATIONS[resident.pose] ?? 'idle';
  const anims: ResidentAnimationId[] = [wanted];
  if (MOVING_ANIMATIONS.has(wanted) && wanted !== 'walk') anims.push('walk');
  if (wanted !== 'idle') anims.push('idle');

  const topTier = Math.max(1, Math.min(people.tiers, resident.outfitTier));
  for (const look of looks) {
    for (const anim of anims) {
      for (let tier = topTier; tier >= 1; tier--) {
        const path = personSheetPath(look, tier, anim);
        const entry = sheetEntry(index, path);
        if (!entry) continue;
        const s = entry.passport;
        const mirroredFrom = MIRRORED_FACES[resident.facing];
        const face = mirroredFrom ?? (resident.facing as UniqueRenderAngle5);
        const row = Math.max(0, DIRECTION_ROWS.indexOf(face));
        const phase = (resident.walkPhase / (Math.PI * 2)) * s.frames;
        const frameIdx = ((Math.floor(timeSec * s.fps + phase) % s.frames) + s.frames) % s.frames;
        const frame: ArtRect = { x: frameIdx * s.frameW, y: row * s.frameH, w: s.frameW, h: s.frameH };
        const layers: ResidentArtLayer[] = [{ path, frame, anchor: s.anchor }];
        const cloakPath = personSheetPath(look, tier, anim, true);
        const cloak = index.files[cloakPath];
        if (cloak && cloak.w === entry.w && cloak.h === entry.h) {
          layers.push({ path: cloakPath, frame, anchor: s.anchor, tint: resident.cloakColor });
        }
        return { layers, mirror: Boolean(mirroredFrom) };
      }
    }
  }
  return null;
}
