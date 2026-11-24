/* Art contract between a world pack's artists and the engine (see ARTIST_CONTRACT.md).
   A pack declares which pictures and sheets it has slots for (WorldArtCatalog); the art folder
   ships an art-index.json listing the files actually present with their sizes and passports.
   The engine draws a picture or sheet only when the index has it, and keeps the geometric
   placeholder for everything else, so art can arrive one file at a time.
   Pure data and math only: loading textures lives in art-runtime.ts. */

import type { VariantStep } from './building-variants';
import type { BuildingKind, CityBuilding } from './city-layout';
import { resolveStageSpecForBuilding, type BuildingConstructionState } from './construction';
import { tileTopVertexToWorld, type Point2D } from './coords';
import { BOAT_CARGO_MAX_DEFAULT, YARD_FILL_STEPS, type HarbourSide } from './harbour';
import {
  CONSTRUCTION_STAGE_IDS,
  type BuildingLoopKind,
  type ConstructionStageId,
  type Direction8,
  type FootprintKey,
  type UniqueRenderAngle5,
  type WorldPackManifest,
} from './manifest';
import { hashSeed } from './prng';
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
  /* On a harbour pier head: the water-line point where a boat lies moored at this pier (#2006). */
  mooring?: ArtPoint;
  /* Pictures on the same canvas drawn over this one, in order (contract section 4, layers). */
  layers?: readonly ArtLayerSpec[];
  /* A shared module drawn as an empty canvas says why here (nothing of it fits the lot); the engine lays nothing. */
  empty?: string;
}>;

/* One layer over a building picture: a file beside it on the same canvas and registration. A shadow layer multiplies
   the ground and walls under it. A layer sways in the wind only by its cloth mask, `<layer>_w.png` beside it (cloth.ts),
   a little, or by the `amplitude` its own passport names; with no mask it never moves. */
export type ArtLayerSpec = Readonly<{
  file: string;
  blend?: 'multiply';
}>;

/* How far a cloth's free edge (mask 255) lifts at the strongest wind, picture px, and the most a passport may ask. */
export const CLOTH_SWAY_PX = 3;
const CLOTH_SWAY_MAX_PX = 8;

/* A layer named by a picture's passport, with its cloth mask and amplitude if it has them: each in the folder, on the
   picture's canvas; both files belong to the picture, so neither counts as undeclared. */
function checkLayerFiles(index: ArtIndex, path: string, entry: ArtIndexEntry, lp: string, errors: string[], layerOf: Map<string, string>): void {
  const le = index.files[lp];
  if (!le) errors.push(`${path}: layer ${lp.slice(lp.lastIndexOf('/') + 1)} is not in the folder`);
  else if (le.w !== entry.w || le.h !== entry.h) errors.push(`${lp}: a layer must be the same size as ${path} (${entry.w} x ${entry.h})`);
  layerOf.set(lp, path);
  checkClothAmplitude(lp, le, errors);
  const mp = clothMaskPath(lp);
  const mask = index.files[mp];
  if (!mask) return;
  layerOf.set(mp, path);
  if (mask.w !== entry.w || mask.h !== entry.h) errors.push(`${mp}: a cloth mask must be the same size as ${path} (${entry.w} x ${entry.h})`);
}

function checkClothAmplitude(lp: string, le: ArtIndexEntry | undefined, errors: string[]): void {
  const amplitude = (le?.passport as { amplitude?: unknown } | undefined)?.amplitude;
  if (amplitude !== undefined && !(isFiniteNum(amplitude) && amplitude > 0 && amplitude <= CLOTH_SWAY_MAX_PX)) {
    errors.push(`${lp}: amplitude must be above 0 and at most ${CLOTH_SWAY_MAX_PX} px`);
  }
}

/* The cloth mask beside a layer: awning.png -> awning_w.png. */
export function clothMaskPath(layerPath: string): string {
  return layerPath.replace(/\.png$/, '_w.png');
}

/* Passport of a small attached picture (flag, capstone): the point that touches its parent. */
export type AnchorPassport = Readonly<{ anchor: ArtPoint }>;

export type LoopAttachPoint = 'top' | 'awning' | 'door' | 'ground' | 'head';

/* Passport of an animation sheet: frames left to right; people have one row per direction. */
export type SheetPassport = Readonly<{
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
  /* Feet point for people, attach point for loops, inside one frame. */
  anchor: ArtPoint;
  attach?: LoopAttachPoint;
  /* People: the drawn directions, one row each in this order, any of the 8; without it the five rows N, NE, E, SE, S.
     A direction not drawn shows the nearest drawn one or its mirror. */
  directions?: readonly Direction8[];
  /* People, sleep: where the Z-z-z loop stands over the head, inside one frame. */
  headAnchor?: ArtPoint;
  /* People, walking sheets: the master px the figure moves on in one cycle, as the E row draws it; without it
     WALK_STRIDE_PX. The engine walks a resident one stride per cycle, so its feet never slide. */
  stride?: number;
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
  /* Drawn variants of the step, each a full set in its own folder v01, v02, ...; v01 is required, the rest optional. */
  variants?: number;
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
  people?: Readonly<{
    looks: readonly string[];
    tiers: number;
    /* Looks whose prop is a large item (PackRoleLookSpec.largeItem). */
    largeItemLooks?: readonly string[];
    /* Sheets accepted before a rule of order v3 4.4 changed, by path, each naming its set: the check warns about them
       instead of rejecting them, until a delivery that meets the rule replaces them. */
    acceptedSheets?: Readonly<Record<string, string>>;
  }>;
  loops?: readonly BuildingLoopKind[];
  /* Kinds whose stage pictures carry their own scaffolds and ramps: no kit module, crane or hoist goes over them. */
  ownConstruction?: readonly BuildingKind[];
  /* The harbour the tasks arrive at (#2006): its yard sizes, and whether the land gate and caravan have slots too. */
  harbour?: Readonly<{ yards: readonly FootprintKey[]; gate?: boolean }>;
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
  'sad_sit',
] as const;
export type ResidentAnimationId = (typeof RESIDENT_ANIMATION_IDS)[number];

/* Poses drawn facing the camera: shown as drawn whatever way the resident faces, never mirrored. */
const FACING_ANIMATIONS: ReadonlySet<ResidentAnimationId> = new Set(['pray', 'sad_sit']);

/* Body types of residents; male_slim sheets lie directly in the tier folder, the others in a folder of their name. */
export const RESIDENT_BODIES = ['male_slim', 'female_slim', 'male_heavy', 'female_full'] as const;
export type ResidentBody = (typeof RESIDENT_BODIES)[number];

/* A resident's body type, from its agent's id so it stays the same in every session. */
export function residentBody(agentId: string): ResidentBody {
  return RESIDENT_BODIES[hashSeed(agentId) % RESIDENT_BODIES.length]!;
}

/* The sleeper's Z-z-z loop, placed at the sleep sheet's headAnchor. */
export const SLEEP_LOOP = 'loops/sleep_z.png';
/* Where the head is above the feet when a sheet names no headAnchor: the standing 136 px figure's crown, less 10 px. */
const STANDING_HEAD_PX = 146;
/* The stride of a walking sheet that names none: on the pilot walk sheets (tier 1 mason, tier 3 architect) a planted
   foot travels 46 master px in the E row in half a cycle of 8 frames. */
export const WALK_STRIDE_PX = 92;

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
/* The directions a sheet may draw: the west ones too, so a big carried item keeps its hand when the resident turns. */
const DRAWABLE_DIRECTIONS: readonly Direction8[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export type DeclaredArtRole = 'building' | 'module' | 'altar' | 'flag' | 'capstone' | 'person' | 'cloak' | 'loop' | 'harbour';

export type DeclaredArtFile = Readonly<{
  path: string;
  role: DeclaredArtRole;
  passport: 'picture' | 'anchor' | 'sheet' | 'none';
  required: boolean;
  /* Files that stand in for a required picture: with any of them in the folder this one is not needed. */
  alternatives?: readonly string[];
  /* For a cloak layer: the base sheet it must match pixel for pixel. */
  baseSheet?: string;
  /* For a person's sheet holding an item that must not change hands: the directions it must draw. */
  held?: HeldItemRule;
  /* For a harbour picture: the footprint its canvas is drawn for. */
  footprint?: FootprintKey;
}>;

/* A sheet whose held item a mirror would move to the other hand (order v3 4.4): what it is, the directions it must
   draw, and the accepted set it belongs to when it was accepted before the rule. */
export type HeldItemRule = Readonly<{ what: string; need: readonly Direction8[]; accepted?: string }>;

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function artFootprintKey(span: number): FootprintKey {
  const clamped = Math.max(1, Math.min(6, Math.round(span)));
  return `${clamped}x${clamped}` as FootprintKey;
}

function footprintSpan(key: FootprintKey): number {
  return Number(key.split('x')[0]);
}

/* The folder of a step's pictures, or of one of its variants (0 = v01). */
function stepFolder(kind: BuildingKind, step: ArtBuildingStep, variant?: number): string {
  return variant === undefined ? `buildings/${kind}/${step.id}/` : `buildings/${kind}/${step.id}/v${pad2(variant + 1)}/`;
}

function stepPicturePath(kind: BuildingKind, step: ArtBuildingStep, picture: string, variant?: number): string {
  return `${stepFolder(kind, step, variant)}${picture}.png`;
}

export function modulePath(footprint: FootprintKey, module: (typeof CONSTRUCTION_MODULES)[number]): string {
  return `modules/${footprint}/${module}.png`;
}

/* Harbour pieces of one tile each, laid along the bank in the bank's orientation (#2006, ARTIST_CONTRACT.md). */
export const HARBOUR_PIECES = ['quay', 'pier_root', 'pier', 'pier_head'] as const;
export type HarbourPiece = (typeof HARBOUR_PIECES)[number];
export const HARBOUR_SIDES: readonly HarbourSide[] = ['a', 'b'];
export const BOAT_STATES = ['sail', 'moored', 'unload'] as const;
export type BoatSheetState = (typeof BOAT_STATES)[number];
/* The pictures of the yard's fill, fill_0 (empty) to one per step of YARD_FILL_STEPS. */
export const YARD_FILL_PICTURES = YARD_FILL_STEPS.length + 1;
export const CARAVAN_SHEET = 'harbour/caravan_walk.png';
/* The ways a boat or a caravan heads on screen as it moves along the grid. */
export const CARRIER_DIRECTIONS: readonly Direction8[] = ['NE', 'SE', 'SW', 'NW'];

export const harbourPiecePath = (piece: HarbourPiece, side: HarbourSide): string => `harbour/${piece}_${side}.png`;
/* A quay's end: 1 is the end higher on screen, 2 the other. */
export const quayEndPath = (side: HarbourSide, end: 1 | 2): string => `harbour/quay_end_${side}${end}.png`;
export const boatSheetPath = (state: BoatSheetState): string => `harbour/boat_${state}.png`;
export const boatCargoPath = (blocks: number): string => `harbour/boat_cargo_${blocks}.png`;
export const yardFillPath = (footprint: FootprintKey, stage: number): string => `harbour/yard/${footprint}/fill_${stage}.png`;
export const harbourGatePath = (side: HarbourSide): string => `harbour/gate_${side}.png`;

/* Every harbour slot of a catalog. None is required: until the set a harbour needs is there, no harbour is shown. */
function harbourFiles(harbour: NonNullable<WorldArtCatalog['harbour']>): DeclaredArtFile[] {
  const out: DeclaredArtFile[] = [];
  const carrier = (what: string): HeldItemRule => ({ what, need: CARRIER_DIRECTIONS });
  for (const side of HARBOUR_SIDES) {
    for (const piece of HARBOUR_PIECES) out.push({ path: harbourPiecePath(piece, side), role: 'harbour', passport: 'picture', required: false, footprint: '1x1' });
    for (const end of [1, 2] as const) out.push({ path: quayEndPath(side, end), role: 'harbour', passport: 'picture', required: false, footprint: '1x1' });
  }
  for (const state of BOAT_STATES) out.push({ path: boatSheetPath(state), role: 'harbour', passport: 'sheet', required: false, held: carrier('a boat') });
  for (let n = 1; n <= BOAT_CARGO_MAX_DEFAULT; n++) {
    out.push({ path: boatCargoPath(n), role: 'harbour', passport: 'sheet', required: false, held: carrier('a boat’s cargo') });
  }
  for (const fp of harbour.yards) {
    for (let stage = 0; stage < YARD_FILL_PICTURES; stage++) {
      out.push({ path: yardFillPath(fp, stage), role: 'harbour', passport: 'picture', required: false, footprint: fp });
    }
  }
  if (harbour.gate) {
    for (const side of HARBOUR_SIDES) out.push({ path: harbourGatePath(side), role: 'harbour', passport: 'picture', required: false, footprint: '2x2' });
    out.push({ path: CARAVAN_SHEET, role: 'harbour', passport: 'sheet', required: false, held: carrier('a caravan') });
  }
  return out;
}

export function personSheetPath(lookId: string, tier: number, anim: ResidentAnimationId, cloak = false, body: ResidentBody = 'male_slim'): string {
  const folder = body === 'male_slim' ? '' : `${body}/`;
  return `people/${lookId}/tier_${tier}/${folder}${anim}${cloak ? '.cloak' : ''}.png`;
}

/* The files of one step's folder (or one variant's), with `at` naming a picture's path. */
type StepPicture = (name: string, required: boolean, role?: DeclaredArtRole) => DeclaredArtFile;

/* prefix_01 .. prefix_<count>. */
const numbered = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}_${pad2(i + 1)}`);

/* Statues and monuments: their own stage pictures (and the monument's capstone) in place of the standard ones. */
function ownStageFiles(pack: WorldPackManifest, kind: BuildingKind, picture: StepPicture): DeclaredArtFile[] | null {
  if (kind === 'statue') return numbered('stage', pack.stageCounts.statue).map(n => picture(n, true));
  if (kind === 'monument') return [...numbered('tier', pack.stageCounts.monument).map(n => picture(n, true)), picture('capstone', true, 'capstone')];
  return null;
}

/* The finished and staged pictures every other kind has; a supply shows its fills in place of complete. */
function standardStepFiles(kind: BuildingKind, at: (picture: string) => string, picture: StepPicture): DeclaredArtFile[] {
  const names = STANDARD_BUILDING_PICTURES.filter(name => kind !== 'supply' || name !== 'complete');
  return names.map(name => {
    const stage = STAGE_OF_PICTURE[name];
    return { ...picture(name, !OPTIONAL_BUILDING_PICTURES.has(name)), ...(stage ? { alternatives: [at(`stage_${pad2(stage)}`)] } : {}) };
  });
}

/* A supply's fill levels; any other kind's construction line on its own canvas (contract 2) and its demolition. */
function lineStepFiles(pack: WorldPackManifest, kind: BuildingKind, picture: StepPicture): DeclaredArtFile[] {
  if (kind === 'supply') return Array.from({ length: SUPPLY_FILL_LEVELS }, (_, f) => picture(`fill_${f}`, true));
  return [...numbered('stage', pack.stageCounts.construction).map(n => picture(n, false)), ...DEMOLITION_PICTURES.map(name => picture(name, false))];
}

function declaredStepFiles(pack: WorldPackManifest, kind: BuildingKind, at: (picture: string) => string): DeclaredArtFile[] {
  const picture: StepPicture = (name, required, role = 'building') => ({
    path: at(name),
    role,
    passport: role === 'capstone' ? 'anchor' : 'picture',
    required,
  });
  return ownStageFiles(pack, kind, picture) ?? [...standardStepFiles(kind, at, picture), ...lineStepFiles(pack, kind, picture)];
}

/* A step's files: in its own folder, or in its variant folders v01 (required), v02, ... (optional). A step delivered
   with no variant folders keeps its pictures in the step folder (order v3), so that set stands in for v01. */
function stepFolderFiles(pack: WorldPackManifest, kind: BuildingKind, step: ArtBuildingStep): DeclaredArtFile[] {
  const flat = declaredStepFiles(pack, kind, picture => stepPicturePath(kind, step, picture));
  if (!step.variants) return flat;
  const out: DeclaredArtFile[] = flat.map(f => ({ ...f, required: false }));
  for (let v = 0; v < step.variants; v++) {
    const files = declaredStepFiles(pack, kind, picture => stepPicturePath(kind, step, picture, v));
    out.push(...(v === 0 ? files.map((f, i) => asVariantOne(f, flat[i]!)) : files.map(f => ({ ...f, required: false }))));
  }
  return out;
}

/* A v01 file the same file of the flat step folder stands in for, as well as what stands in for that one. */
function asVariantOne(file: DeclaredArtFile, flat: DeclaredArtFile): DeclaredArtFile {
  return { ...file, alternatives: [...(file.alternatives ?? []), flat.path, ...(flat.alternatives ?? [])] };
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
      if (kind !== 'statue' && kind !== 'monument') moduleFootprints.add(step.footprint);
      out.push(...stepFolderFiles(pack, kind, step));
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
          for (const body of RESIDENT_BODIES) {
            const base = personSheetPath(look, tier, anim, false, body);
            const held = heldItemRule(art.people, look, anim, base);
            out.push({ path: base, role: 'person', passport: 'sheet', required: tier === 1 && body === 'male_slim', ...(held ? { held } : {}) });
            out.push({ path: personSheetPath(look, tier, anim, true, body), role: 'cloak', passport: 'none', required: false, baseSheet: base });
          }
        }
      }
    }
  }

  for (const loop of art.loops ?? []) {
    out.push({ path: `loops/${loop}.png`, role: 'loop', passport: 'sheet', required: true });
  }
  if (art.people) out.push({ path: SLEEP_LOOP, role: 'loop', passport: 'sheet', required: false });
  if (art.harbour) out.push(...harbourFiles(art.harbour));
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
    ['mooring', p.mooring],
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
  }
}

/* A layer's file name: a png in the picture's folder or below it. */
const LAYER_FILE = /^[\w-][\w./-]*\.png$/;

/* Path of a layer file named in a picture's passport: beside the picture. */
export function artLayerPath(picturePath: string, file: string): string {
  return picturePath.slice(0, picturePath.lastIndexOf('/') + 1) + file;
}

const CARRY_ANIMATIONS: ReadonlySet<ResidentAnimationId> = new Set(['carry', 'carry_back']);
/* The four ways a resident faces on screen as it walks the grid's four steps (#1983). */
const WALKED_DIRECTIONS: readonly Direction8[] = ['NE', 'SE', 'SW', 'NW'];
const LARGE_ITEM_DIRECTIONS: Readonly<Partial<Record<ResidentAnimationId, readonly Direction8[]>>> = { walk: WALKED_DIRECTIONS, idle: ['SE', 'SW'] };

/* Order v3 4.4 (Ivan, 23.11): a carry, and the walk of a look with a large item, draw every way a resident walks on
   screen, NE, SE, SW and NW, and that look's idle SE and SW, so no mirrored row moves the item to the other hand.
   Other sheets keep their drawn rows and a mirror. */
function heldItemRule(people: NonNullable<WorldArtCatalog['people']>, look: string, anim: ResidentAnimationId, path: string): HeldItemRule | undefined {
  const large = people.largeItemLooks?.includes(look) ?? false;
  const need = CARRY_ANIMATIONS.has(anim) ? WALKED_DIRECTIONS : large ? LARGE_ITEM_DIRECTIONS[anim] : undefined;
  if (!need) return undefined;
  const accepted = people.acceptedSheets?.[path];
  return { what: CARRY_ANIMATIONS.has(anim) ? anim : `${anim} of a look with a large item`, need, ...(accepted ? { accepted } : {}) };
}

/* "SE and SW", "NE, SE, SW and NW". */
function listOf(items: readonly string[]): string {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/* A sheet missing a direction its held item needs: an error, or a named warning for a set accepted before the rule. */
function checkHeldItem(path: string, entry: ArtIndexEntry, rule: HeldItemRule, errors: string[], warnings: string[]): void {
  const drawn = (entry.passport as SheetPassport | undefined)?.directions ?? DIRECTION_ROWS;
  const missing = rule.need.filter(d => !drawn.includes(d));
  if (missing.length === 0) return;
  if (rule.accepted) {
    warnings.push(
      `${path}: ${rule.what} lacks ${listOf(missing)}: the accepted set ${rule.accepted} stays in play until its export in ${listOf(rule.need)} replaces it (order v3 4.4)`,
    );
  } else {
    errors.push(`${path}: ${rule.what} must be drawn in ${listOf(rule.need)} (order v3 4.4), it has ${drawn.join(', ')}`);
  }
}

/* The rows a person's sheet must hold: one per drawn direction it names, five without the field; its stride checked too. */
function personRows(path: string, entry: ArtIndexEntry, errors: string[]): number {
  checkStride(path, entry, errors);
  const directions = (entry.passport as SheetPassport | undefined)?.directions;
  if (directions === undefined) return DIRECTION_ROWS.length;
  const list = Array.isArray(directions) ? (directions as readonly string[]) : [];
  if (list.length === 0 || list.some(d => !(DRAWABLE_DIRECTIONS as readonly string[]).includes(d))) {
    errors.push(`${path}: directions must name drawn ones among ${DRAWABLE_DIRECTIONS.join(', ')}`);
  }
  if (new Set(list).size !== list.length) errors.push(`${path}: directions names a direction twice`);
  return Math.max(1, list.length);
}

/* A stride the engine walks by: px above zero, or none for the default. */
function checkStride(path: string, entry: ArtIndexEntry, errors: string[]): void {
  const stride = (entry.passport as SheetPassport | undefined)?.stride;
  if (stride !== undefined && (!isFiniteNum(stride) || stride <= 0)) errors.push(`${path}: stride must be a number of px above zero`);
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
      errors.push(`${path}: height ${entry.h} px must hold ${rows} direction rows of ${s.frameH} px, one per drawn direction`);
    }
  } else if (entry.h % s.frameH !== 0 || entry.h === 0) {
    errors.push(`${path}: height ${entry.h} px must be a whole number of ${s.frameH} px rows`);
  }
  if (!pointInside(s.anchor, s.frameW, s.frameH)) {
    errors.push(`${path}: anchor lies outside one ${s.frameW} x ${s.frameH} frame`);
  }
}

/* Checks the art folder's index against the pack's catalog and the contract's geometry rules. */
/* A step's own folder (undefined), then each of its variant folders (0 = v01). */
const variantNumbers = (step: ArtBuildingStep): (number | undefined)[] => [undefined, ...Array.from({ length: step.variants ?? 0 }, (_, v) => v)];

/* The footprint of every step folder of the catalog, its variant folders included. */
function stepFootprints(buildings: WorldArtCatalog['buildings']): Map<string, FootprintKey> {
  const out = new Map<string, FootprintKey>();
  for (const [kind, steps] of Object.entries(buildings) as [BuildingKind, readonly ArtBuildingStep[]][]) {
    for (const step of steps) for (const v of variantNumbers(step)) out.set(stepFolder(kind, step, v), step.footprint);
  }
  return out;
}

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

  const footprintOf = stepFootprints(pack.art?.buildings ?? {});

  /* Layer files are declared by the passports that name them and must match their picture's canvas. */
  const layerOf = new Map<string, string>();
  for (const [path, entry] of Object.entries(index.files)) {
    const layers = (entry.passport as BuildingPicturePassport | undefined)?.layers;
    if (!byPath.has(path) || !Array.isArray(layers)) continue;
    for (const layer of layers) {
      if (typeof layer?.file === 'string') checkLayerFiles(index, path, entry, artLayerPath(path, layer.file), errors, layerOf);
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
      else if (slot.footprint) fp = slot.footprint;
      checkPicture(pack, path, entry, fp, errors);
    } else if (slot.passport === 'anchor') {
      const a = entry.passport as AnchorPassport | undefined;
      if (!a || !isPoint(a.anchor) || !pointInside(a.anchor, entry.w, entry.h)) {
        errors.push(`${path}: needs a passport with an anchor inside the picture`);
      }
    } else if (slot.passport === 'sheet') {
      checkSheet(path, entry, slot.role === 'person' || slot.role === 'harbour' ? personRows(path, entry, errors) : null, errors);
      if (slot.held) checkHeldItem(path, entry, slot.held, errors, warnings);
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
    .filter(d => d.required && !index.files[d.path] && !d.alternatives?.some(a => index.files[a]))
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
  for (const fp of art.harbour?.yards ?? []) {
    if (!ART_FOOTPRINT_KEYS.includes(fp)) errors.push(`art.harbour.yards: unknown footprint "${String(fp)}"`);
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
  /* Sways by the cloth mask at `mask`, its free edge lifting up to `amplitude` picture px (cloth.ts). */
  sway?: Readonly<{ mask: string; amplitude: number }>;
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
  /* The variant of its step the building shows (0 = v01), from chooseBuildingVariants. */
  variant?: number;
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
/* A layer's sway when its cloth mask lies beside it on the same canvas: the passport's amplitude, else CLOTH_SWAY_PX. */
function clothSway(files: ArtIndex['files'], lp: string, entry: ArtIndexEntry): { sway?: { mask: string; amplitude: number } } {
  const mask = clothMaskPath(lp);
  const m = files[mask];
  if (!m || m.w !== entry.w || m.h !== entry.h) return {};
  const own = (entry.passport as { amplitude?: unknown } | undefined)?.amplitude;
  const amplitude = isFiniteNum(own) && own > 0 ? Math.min(own, CLOTH_SWAY_MAX_PX) : CLOTH_SWAY_PX;
  return { sway: { mask, amplitude } };
}

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
      ...clothSway(files, lp, entry),
    });
  }
  return out;
}

/* The variant to draw: the wanted one when its finished picture is in the folder, else the next delivered one going
   round; undefined for a step without variants, null when none is delivered. */
function deliveredVariant(files: ArtIndex['files'], kind: BuildingKind, step: ArtBuildingStep, wanted: number): number | null | undefined {
  const count = step.variants;
  if (!count) return undefined;
  for (let k = 0; k < count; k++) {
    const at = variantFolder(files, kind, step, (((wanted + k) % count) + count) % count);
    if (at !== null) return at;
  }
  return null;
}

/* Where variant v of a step is delivered: its own folder, the step folder for v01 when the step came with no variant
   folders (order v3), or nowhere (null). */
function variantFolder(files: ArtIndex['files'], kind: BuildingKind, step: ArtBuildingStep, v: number): number | null | undefined {
  if (files[stepPicturePath(kind, step, 'complete', v)]) return v;
  return v === 0 && files[stepPicturePath(kind, step, 'complete')] ? undefined : null;
}

/* The step a building shows and the paths of its pictures in the variant to draw; null without art for it. */
function shownStep(
  art: WorldArtCatalog,
  files: ArtIndex['files'],
  building: CityBuilding,
  wanted: number | undefined,
): { step: ArtBuildingStep; base: (picture: string) => string } | null {
  const step = pickStep(art.buildings[building.kind], building, building.stage);
  if (!step) return null;
  const variant = deliveredVariant(files, building.kind, step, wanted ?? 0);
  if (variant === null) return null;
  return { step, base: picture => stepPicturePath(building.kind, step, picture, variant) };
}

/* The step a building shows and its number of variants, for chooseBuildingVariants; null without variants. */
export function variantStepOf(pack: WorldPackManifest, building: CityBuilding): VariantStep | null {
  const step = pickStep(pack.art?.buildings[building.kind], building, building.stage);
  return step?.variants ? { key: `${building.kind}/${step.id}`, count: step.variants } : null;
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
  const shown = shownStep(art, files, building, options.variant);
  if (!shown) return null;
  const { step, base } = shown;

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

export type ResidentArtLayer = Readonly<{
  path: string;
  frame: ArtRect;
  anchor: ArtPoint;
  tint?: string;
  /* Where the layer's anchor stands from the feet, in master px; at the feet without it. */
  at?: ArtPoint;
  /* Never mirrored with the resident (lettering). */
  upright?: boolean;
}>;

export type ResidentArt = Readonly<{
  layers: readonly ResidentArtLayer[];
  mirror: boolean;
}>;

const FACE_ANGLE: Readonly<Record<string, number>> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/* The row to show for a resident facing `facing`: the nearest drawn direction or the mirror of one; at the same distance
   a drawn row wins over a mirror (a big carried item keeps its hand), then the earlier row. A facing pose shows its S
   row, or its first, as drawn. */
export function sheetRowFor(
  directions: readonly Direction8[] | undefined,
  facing: string,
  facingPose: boolean,
): { row: number; mirror: boolean } {
  const rows = directions ?? DIRECTION_ROWS;
  if (facingPose) return { row: Math.max(0, rows.indexOf('S')), mirror: false };
  const want = FACE_ANGLE[facing] ?? 180;
  let best = { row: 0, mirror: false };
  let bestDiff = Infinity;
  rows.forEach((d, row) => {
    for (const mirror of [false, true]) {
      const drawn = FACE_ANGLE[d] ?? 180;
      const angle = mirror ? (360 - drawn) % 360 : drawn;
      const diff = Math.abs(((want - angle + 540) % 360) - 180) + (mirror ? 0.5 : 0);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { row, mirror };
      }
    }
  });
  return best;
}

/* Where a resident layer's sprite goes and its horizontal scale, the feet at (x, y) and s world px per master px. */
export function residentLayerPlacement(layer: ResidentArtLayer, mirror: boolean, s: number, x: number, y: number): { x: number; y: number; scaleX: number } {
  const side = mirror ? -1 : 1;
  const at = layer.at ?? { x: 0, y: 0 };
  return { x: x + side * at.x * s, y: y + at.y * s, scaleX: mirror && !layer.upright ? -s : s };
}

function sheetEntry(index: ArtIndex, path: string): (ArtIndexEntry & { passport: SheetPassport }) | null {
  const entry = index.files[path];
  if (!entry?.passport || !('frames' in entry.passport)) return null;
  return entry as ArtIndexEntry & { passport: SheetPassport };
}

/* The first sheet of the look, animation and tier among the bodies, the resident's own first. */
function bodySheet(index: ArtIndex, look: string, tier: number, anim: ResidentAnimationId, bodies: readonly ResidentBody[]) {
  for (const body of bodies) {
    const path = personSheetPath(look, tier, anim, false, body);
    const entry = sheetEntry(index, path);
    if (entry) return { path, body, entry };
  }
  return null;
}

/* The Z-z-z over a sleeper, standing at the sheet's headAnchor (or the standing head), never mirrored. */
function sleepLoopLayer(index: ArtIndex, sheet: SheetPassport, timeSec: number): ResidentArtLayer | null {
  const z = sheetEntry(index, SLEEP_LOOP);
  if (!z) return null;
  const head = sheet.headAnchor ?? { x: sheet.anchor.x, y: sheet.anchor.y - STANDING_HEAD_PX };
  const frameIdx = Math.floor(timeSec * z.passport.fps) % z.passport.frames;
  return {
    path: SLEEP_LOOP,
    frame: { x: frameIdx * z.passport.frameW, y: 0, w: z.passport.frameW, h: z.passport.frameH },
    anchor: z.passport.anchor,
    at: { x: head.x - sheet.anchor.x, y: head.y - sheet.anchor.y },
    upright: true,
  };
}

type FoundSheet = Readonly<{ look: string; tier: number; anim: ResidentAnimationId; body: ResidentBody; path: string; entry: ArtIndexEntry & { passport: SheetPassport } }>;

/* The frame of a found sheet to show now, in the row of the resident's facing, with its cloak and the sleeper's Z. */
function sheetArt(index: ArtIndex, found: FoundSheet, resident: ResidentEntity, timeSec: number): ResidentArt {
  const s = found.entry.passport;
  const { row, mirror } = sheetRowFor(s.directions, resident.facing, FACING_ANIMATIONS.has(found.anim));
  /* The cycle runs on time alone, each resident from its own frame; the walking speed comes from the stride. */
  const frameIdx = (Math.floor(timeSec * s.fps) + (hashSeed(resident.id) % s.frames)) % s.frames;
  const frame: ArtRect = { x: frameIdx * s.frameW, y: row * s.frameH, w: s.frameW, h: s.frameH };
  const layers: ResidentArtLayer[] = [{ path: found.path, frame, anchor: s.anchor }];
  const cloakPath = personSheetPath(found.look, found.tier, found.anim, true, found.body);
  const cloak = index.files[cloakPath];
  if (cloak && cloak.w === found.entry.w && cloak.h === found.entry.h) {
    layers.push({ path: cloakPath, frame, anchor: s.anchor, tint: resident.cloakColor });
  }
  const z = found.anim === 'sleep' ? sleepLoopLayer(index, s, timeSec) : null;
  if (z) layers.push(z);
  return { layers, mirror };
}

/* Chooses a resident's sheet (look, outfit tier, animation, body) and the frame to show, falling back to lower
   outfit tiers, then to walking or standing, then to the placeholder; a missing body takes the male_slim sheet. */
export function resolveResidentArt(
  pack: WorldPackManifest,
  index: ArtIndex | null,
  resident: ResidentEntity,
  timeSec: number,
): ResidentArt | null {
  const found = residentSheet(pack, index, resident);
  return found && index ? sheetArt(index, found, resident, timeSec) : null;
}

/* The sheet a resident shows from the pack's art, its own look first, then its class's. */
function residentSheet(pack: WorldPackManifest, index: ArtIndex | null, resident: ResidentEntity): FoundSheet | null {
  const people = pack.art?.people;
  if (!people || !index) return null;
  const looks = [resident.look.id, pack.classFallbackLooks?.[resident.roleClass]?.id].filter(
    (id): id is string => Boolean(id) && people.looks.includes(id!),
  );
  return looks.length > 0 ? foundSheet(people, index, resident, looks) : null;
}

/* The sheet a resident shows: its pose's animation, else walking or standing, from its outfit tier down. */
function foundSheet(
  people: NonNullable<WorldArtCatalog['people']>,
  index: ArtIndex,
  resident: ResidentEntity,
  looks: readonly string[],
): FoundSheet | null {
  const wanted = POSE_ANIMATIONS[resident.pose] ?? 'idle';
  const anims: ResidentAnimationId[] = [wanted];
  if (MOVING_ANIMATIONS.has(wanted) && wanted !== 'walk') anims.push('walk');
  if (wanted !== 'idle') anims.push('idle');
  const bodies = [...new Set<ResidentBody>([residentBody(resident.agentId), 'male_slim'])];

  const topTier = Math.max(1, Math.min(people.tiers, resident.outfitTier));
  for (const look of looks) {
    for (const anim of anims) {
      for (let tier = topTier; tier >= 1; tier--) {
        const found = bodySheet(index, look, tier, anim, bodies);
        if (found) return { look, tier, anim, ...found };
      }
    }
  }
  return null;
}

/* Tiles a resident walks per second so the moving sheet it shows covers one stride per cycle; null when it shows no
   moving sheet. A stride along the E row is a screen-level step of tile diagonals: master px * sqrt 2 / master tile. */
/* True when a resident is drawn from a standing sheet for its pose (idle, build and the like): it has no stride, so the
   resident keeps its place instead of sliding (#1983). False without art, where the placeholder draws its own steps. */
export function residentStandsStill(pack: WorldPackManifest, index: ArtIndex | null, resident: ResidentEntity): boolean {
  const found = residentSheet(pack, index, resident);
  return found !== null && !MOVING_ANIMATIONS.has(found.anim);
}

export function residentWalkSpeed(pack: WorldPackManifest, index: ArtIndex | null, resident: ResidentEntity): number | null {
  const found = residentSheet(pack, index, resident);
  if (!found || !MOVING_ANIMATIONS.has(found.anim)) return null;
  const s = found.entry.passport;
  const strideTiles = ((s.stride ?? WALK_STRIDE_PX) * Math.SQRT2) / masterTileW(pack);
  return (strideTiles * s.fps) / Math.max(1, s.frames);
}
